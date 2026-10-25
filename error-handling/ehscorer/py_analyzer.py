"""Python analysis built on the ``ast`` module."""

from __future__ import annotations

import ast
import builtins
from typing import Dict, Iterator, List, Optional, Set

from .metrics import IDIOMATIC_SWALLOW, FileResult, record_handler

BROAD = {"Exception", "BaseException"}
BUILTIN_EXCEPTIONS = {
    n for n, v in vars(builtins).items() if isinstance(v, type) and issubclass(v, BaseException)
}
_LOG_OBJS = {"logging", "logger", "log", "_logger", "_log", "warnings", "traceback", "structlog"}
_LOG_METHODS = {"debug", "info", "warning", "warn", "error", "exception", "critical", "fatal",
                "log", "print_exc", "print_exception", "format_exc", "notice"}
_PRINT_CALLS = {"print", "sys.stderr.write", "click.echo", "typer.echo", "console.print",
                "parser.error", "ctx.fail", "pytest.fail", "pytest.skip", "self.fail"}
_EXIT_CALLS = {"sys.exit", "exit", "quit", "os._exit", "abort", "ctx.exit", "self.error"}
_CLOSE_ATTRS = {"close", "shutdown", "cleanup", "terminate", "kill", "release", "aclose",
                "dispose", "stop", "disconnect", "__exit__"}
_VALIDATING_DECORATORS = {"validate_arguments", "validate_call", "validator", "field_validator",
                          "typechecked", "beartype", "validate", "require", "enforce_types"}

RESOURCES = {
    "open", "io.open", "codecs.open", "gzip.open", "bz2.open", "lzma.open", "tarfile.open",
    "zipfile.ZipFile", "ZipFile", "socket.socket", "sqlite3.connect", "urlopen",
    "urllib.request.urlopen", "request.urlopen", "subprocess.Popen", "Popen",
    "tempfile.NamedTemporaryFile", "tempfile.TemporaryFile", "tempfile.TemporaryDirectory",
    "tempfile.SpooledTemporaryFile", "NamedTemporaryFile", "TemporaryDirectory",
    "psycopg2.connect", "pymysql.connect", "mysql.connector.connect", "aiohttp.ClientSession",
    "httpx.Client", "httpx.AsyncClient", "requests.Session", "requests.session",
    "ThreadPoolExecutor", "ProcessPoolExecutor", "concurrent.futures.ThreadPoolExecutor",
    "concurrent.futures.ProcessPoolExecutor", "multiprocessing.Pool", "Pool", "smtplib.SMTP",
    "ftplib.FTP", "paramiko.SSHClient", "redis.Redis", "pymongo.MongoClient",
}
_NET_TIMEOUT = {
    "requests.get", "requests.post", "requests.put", "requests.delete", "requests.head",
    "requests.patch", "requests.request", "httpx.get", "httpx.post", "httpx.put",
    "httpx.delete", "httpx.head", "httpx.patch", "httpx.request", "urlopen",
    "urllib.request.urlopen", "request.urlopen", "socket.create_connection",
}
_RISKY2 = {
    "os.remove": "io", "os.unlink": "io", "os.rename": "io", "os.replace": "io",
    "os.makedirs": "io", "os.mkdir": "io", "os.rmdir": "io", "os.listdir": "io",
    "os.scandir": "io", "shutil.copy": "io", "shutil.copyfile": "io", "shutil.copytree": "io",
    "shutil.move": "io", "shutil.rmtree": "io", "shutil.copy2": "io",
    "json.load": "parse", "json.loads": "parse", "yaml.load": "parse", "yaml.safe_load": "parse",
    "yaml.full_load": "parse", "pickle.load": "parse", "pickle.loads": "parse",
    "tomllib.load": "parse", "tomllib.loads": "parse", "toml.load": "parse", "toml.loads": "parse",
    "ET.parse": "parse", "ET.fromstring": "parse", "ElementTree.parse": "parse",
    "ElementTree.fromstring": "parse", "ast.literal_eval": "parse", "ast.parse": "parse",
    "datetime.strptime": "parse", "configparser.read": "parse",
    "subprocess.run": "proc", "subprocess.call": "proc", "subprocess.check_call": "proc",
    "subprocess.check_output": "proc", "subprocess.Popen": "proc", "os.system": "proc",
    "requests.get": "net", "requests.post": "net", "requests.put": "net",
    "requests.delete": "net", "requests.head": "net", "requests.patch": "net",
    "requests.request": "net", "httpx.get": "net", "httpx.post": "net", "httpx.request": "net",
    "socket.create_connection": "net", "urllib.request.urlopen": "net", "request.urlopen": "net",
    "sqlite3.connect": "db", "psycopg2.connect": "db", "pymysql.connect": "db",
}
_RISKY_SINGLE = {"open": "io", "urlopen": "net", "Popen": "proc"}
_RISKY_LAST = {
    "read_text": "io", "write_text": "io", "read_bytes": "io", "write_bytes": "io",
    "strptime": "parse", "safe_load": "parse", "literal_eval": "parse",
    "execute": "db", "executemany": "db", "urlopen": "net",
}


def dotted(node: ast.AST) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        base = dotted(node.value)
        return f"{base}.{node.attr}" if base else node.attr
    if isinstance(node, ast.Call):
        return dotted(node.func)
    if isinstance(node, ast.Subscript):
        return dotted(node.value)
    return ""


def iter_nodes(stmts) -> Iterator[ast.AST]:
    """Walk statements without descending into nested function/class definitions."""
    stack = list(stmts)
    while stack:
        n = stack.pop()
        yield n
        for ch in ast.iter_child_nodes(n):
            if not isinstance(ch, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)):
                stack.append(ch)


def exc_names(node: Optional[ast.AST]) -> List[str]:
    if node is None:
        return []
    if isinstance(node, ast.Tuple):
        out: List[str] = []
        for e in node.elts:
            out.extend(exc_names(e))
        return out
    d = dotted(node)
    return [d.split(".")[-1]] if d else []


def classify_risky(name: str) -> Optional[str]:
    if not name:
        return None
    parts = name.split(".")
    if len(parts) == 1:
        return _RISKY_SINGLE.get(name)
    return _RISKY2.get(".".join(parts[-2:])) or _RISKY_LAST.get(parts[-1])


def _is_log(name: str) -> bool:
    parts = name.lower().split(".")
    return (
        len(parts) >= 2
        and parts[-1] in _LOG_METHODS
        and any(p in _LOG_OBJS or p.endswith("logger") or p.endswith("log") for p in parts[:-1])
    )


def _scan_function(fn: ast.AST):
    """Return (validated, defensive) for a function body."""
    a = fn.args  # type: ignore[attr-defined]
    params = {x.arg for x in a.posonlyargs + a.args + a.kwonlyargs} - {"self", "cls"}
    if a.vararg:
        params.add(a.vararg.arg)
    if a.kwarg:
        params.add(a.kwarg.arg)
    validated = defensive = False
    for dec in fn.decorator_list:  # type: ignore[attr-defined]
        if dotted(dec).split(".")[-1] in _VALIDATING_DECORATORS:
            validated = True
    for n in iter_nodes(fn.body):  # type: ignore[attr-defined]
        if isinstance(n, ast.If):
            if any(isinstance(x, ast.Raise) for x in iter_nodes(n.body)):
                validated = True
            t = n.test
            if isinstance(t, ast.UnaryOp) and isinstance(t.op, ast.Not) and \
                    isinstance(t.operand, ast.Name) and t.operand.id in params:
                defensive = True
        elif isinstance(n, ast.Assert):
            defensive = True
        elif isinstance(n, ast.Call):
            d = dotted(n.func)
            if d in ("isinstance", "issubclass", "callable"):
                defensive = True
            elif d.endswith(".get") and len(n.args) >= 2:
                defensive = True
            elif d == "getattr" and len(n.args) >= 3:
                defensive = True
        elif isinstance(n, ast.Compare):
            if any(isinstance(op, (ast.Is, ast.IsNot)) for op in n.ops) and \
                    isinstance(n.left, ast.Name) and n.left.id in params and \
                    any(isinstance(c, ast.Constant) and c.value is None for c in n.comparators):
                defensive = True
    return validated, validated or defensive


class _Ctx:
    __slots__ = ("unmanaged", "has_close", "has_finally")

    def __init__(self) -> None:
        self.unmanaged: List[tuple] = []
        self.has_close = False
        self.has_finally = False


class PyVisitor(ast.NodeVisitor):
    def __init__(self, res: FileResult) -> None:
        self.res = res
        self.try_depth = 0
        self.managed: Set[int] = set()
        self.transferred: Set[int] = set()
        self.ctx_stack: List[_Ctx] = [_Ctx()]
        self.class_stack: List[str] = []
        self.func_depth = 0

    # -- functions & classes ------------------------------------------------
    def visit_FunctionDef(self, node) -> None:  # noqa: N802
        res = self.res
        stmts = sum(1 for n in iter_nodes(node.body) if isinstance(n, ast.stmt))
        a = node.args
        nparams = len({x.arg for x in a.posonlyargs + a.args + a.kwonlyargs} - {"self", "cls"})
        nparams += bool(a.vararg) + bool(a.kwarg)
        nontrivial = stmts >= 4
        validated, defensive = _scan_function(node)
        if nontrivial:
            res.inc("funcs_nontrivial")
            if defensive:
                res.inc("funcs_defensive")
        public = (
            not node.name.startswith("_") or node.name == "__init__"
        ) and self.func_depth == 0 and not any(c.startswith("_") for c in self.class_stack)
        if public and nparams >= 1 and nontrivial and not res.is_test:
            res.inc("funcs_public")
            if validated:
                res.inc("funcs_validated")
        decs = {dotted(d).split(".")[-1] for d in node.decorator_list}
        if node.name in ("__enter__", "__aenter__") or decs & {"contextmanager", "asynccontextmanager"}:
            res.inc("ctx_defs")

        self.ctx_stack.append(_Ctx())
        self.func_depth += 1
        saved_try = self.try_depth
        self.try_depth = 0  # a try in the caller does not protect calls in this body
        self.generic_visit(node)
        self.try_depth = saved_try
        self.func_depth -= 1
        self._close_ctx(self.ctx_stack.pop())

    visit_AsyncFunctionDef = visit_FunctionDef  # noqa: N815

    def visit_ClassDef(self, node: ast.ClassDef) -> None:  # noqa: N802
        bases = tuple(b for b in (dotted(x).split(".")[-1] for x in node.bases) if b)
        self.res.classes.append((node.name, bases))
        self.class_stack.append(node.name)
        self.generic_visit(node)
        self.class_stack.pop()

    def _close_ctx(self, ctx: _Ctx) -> None:
        for line, name in ctx.unmanaged:
            if ctx.has_close or ctx.has_finally:
                self.res.inc("res_manual")
            else:
                self.res.inc("res_unmanaged")
                self.res.add("unclosed_resource", line, f"{name}() is not closed or used in a with block")

    # -- try / with ----------------------------------------------------------
    def visit_Try(self, node: ast.Try) -> None:  # noqa: N802
        res = self.res
        res.inc("tries")
        if node.finalbody:
            res.inc("tries_finally")
            self.ctx_stack[-1].has_finally = True
        for h in node.handlers:
            self._handler(h)
        if node.handlers:
            self.try_depth += 1
        for s in node.body:
            self.visit(s)
        if node.handlers:
            self.try_depth -= 1
        for h in node.handlers:
            for s in h.body:
                self.visit(s)
        for s in node.orelse + node.finalbody:
            self.visit(s)

    visit_TryStar = visit_Try  # noqa: N815

    def visit_With(self, node) -> None:  # noqa: N802
        self.res.inc("with_stmts")
        for item in node.items:
            for sub in ast.walk(item.context_expr):
                if isinstance(sub, ast.Call):
                    self.managed.add(id(sub))
        self.generic_visit(node)

    visit_AsyncWith = visit_With  # noqa: N815

    def visit_Return(self, node: ast.Return) -> None:  # noqa: N802
        if isinstance(node.value, ast.Call):
            self.transferred.add(id(node.value))
        self.generic_visit(node)

    def visit_Assign(self, node: ast.Assign) -> None:  # noqa: N802
        if isinstance(node.value, ast.Call) and any(isinstance(t, ast.Attribute) for t in node.targets):
            self.transferred.add(id(node.value))  # ownership handed to an object
        self.generic_visit(node)

    # -- raise / call ----------------------------------------------------------
    def visit_Raise(self, node: ast.Raise) -> None:  # noqa: N802
        if node.exc is not None:
            self.res.inc("raises")
            name = dotted(node.exc).split(".")[-1]
            if name:
                self.res.used_names.add(name)
            if name in BROAD:
                self.res.inc("raise_generic")
                self.res.add("raise_generic_exception", node.lineno,
                             f"raises bare {name}; use a specific or custom exception type")
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> None:  # noqa: N802
        res = self.res
        name = dotted(node.func)
        ctx = self.ctx_stack[-1]
        if isinstance(node.func, ast.Attribute):
            if node.func.attr in _CLOSE_ATTRS:
                ctx.has_close = True
            if node.func.attr in ("enter_context", "enter_async_context", "callback", "push",
                                  "push_async_callback"):
                for arg in node.args:
                    for sub in ast.walk(arg):
                        if isinstance(sub, ast.Call):
                            self.managed.add(id(sub))
        if name.endswith("closing") or name.endswith("aclosing"):
            for arg in node.args:
                for sub in ast.walk(arg):
                    if isinstance(sub, ast.Call):
                        self.managed.add(id(sub))
        if name in RESOURCES:
            if id(node) in self.managed:
                res.inc("res_with")
            elif id(node) not in self.transferred:
                ctx.unmanaged.append((node.lineno, name))
        cat = classify_risky(name)
        if cat:
            res.inc("risky_total")
            res.inc("risky_" + cat)
            if self.try_depth > 0 or id(node) in self.managed:
                res.inc("risky_covered")
                res.inc("riskycov_" + cat)
            elif cat != "io" or not res.is_test:
                res.add("unprotected_call", node.lineno, f"{name}() ({cat}) is not inside a try block")
        if name in _NET_TIMEOUT or ".".join(name.split(".")[-2:]) in _NET_TIMEOUT:
            res.inc("net_total")
            has_kw = any(k.arg == "timeout" for k in node.keywords)
            has_splat = any(k.arg is None for k in node.keywords)
            if not has_kw and not has_splat:
                res.inc("net_no_timeout")
                res.add("network_no_timeout", node.lineno, f"{name}() called without a timeout")
        self.generic_visit(node)

    # -- handlers ----------------------------------------------------------------
    def _handler(self, h: ast.ExceptHandler) -> None:
        names = exc_names(h.type)
        for n in names:
            self.res.used_names.add(n)
        if h.type is None:
            kind = "bare"
        elif any(n in BROAD for n in names):
            kind = "broad"
        else:
            kind = "specific"
        raised = reraised = False
        new = chained = 0
        logged = printed = uses = exits = False
        for n in iter_nodes(h.body):
            if isinstance(n, ast.Raise):
                raised = True
                if n.exc is None or (isinstance(n.exc, ast.Name) and n.exc.id == h.name):
                    reraised = True
                else:
                    new += 1
                    chained += n.cause is not None
            elif isinstance(n, ast.Call):
                d = dotted(n.func)
                if _is_log(d):
                    logged = True
                elif d in _PRINT_CALLS or (d.endswith(".print") or d.endswith(".echo")):
                    printed = True
                elif d in _EXIT_CALLS:
                    exits = True
            elif isinstance(n, ast.Name) and h.name and n.id == h.name and isinstance(n.ctx, ast.Load):
                uses = True
        trivial = all(
            isinstance(s, (ast.Pass, ast.Continue, ast.Break))
            or (isinstance(s, ast.Expr) and isinstance(s.value, ast.Constant))
            for s in h.body
        )
        idiomatic = bool(names) and all(n in IDIOMATIC_SWALLOW for n in names)
        record_handler(
            self.res, kind, line=h.lineno, raised=raised, reraised=reraised, new_raises=new,
            chained=chained, logged=logged, printed=printed, uses_exc=uses, exits=exits,
            trivial=trivial, idiomatic=idiomatic,
            label=", ".join(names) if names else "",
        )


def analyze_python(text: str, res: FileResult) -> None:
    import warnings

    res.loc = sum(1 for ln in text.splitlines() if ln.strip() and not ln.lstrip().startswith("#"))
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            tree = ast.parse(text, filename=res.path)
    except (SyntaxError, ValueError):
        res.parse_mode = "failed"
        res.error = "syntax error (Python 2 or template file?)"
        return
    res.parse_mode = "ast"
    v = PyVisitor(res)
    v.visit(tree)
    v._close_ctx(v.ctx_stack[0])  # module-level resources
