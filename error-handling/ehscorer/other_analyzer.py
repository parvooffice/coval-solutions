"""Heuristic analysis for JavaScript/TypeScript, Java and Go.

Comments and string literals are blanked first (offsets preserved), brackets are
matched once, and anchored regexes locate handlers, resources and risky calls.
The same counters as the Python analyzer are produced, so scoring is uniform.
"""

from __future__ import annotations

import bisect
import re
from typing import Dict, List, Optional, Tuple

from .metrics import FileResult, record_handler

_NON_NL = re.compile(r"[^\n]")
_MASKS: Dict[str, "re.Pattern[str]"] = {}


def _mask_re(language: str) -> "re.Pattern[str]":
    pat = _MASKS.get(language)
    if pat is None:
        parts = [r"//[^\n]*", r"/\*.*?\*/"]
        if language == "java":
            parts.append(r'"""[\s\S]*?"""')
        parts += [r'"(?:\\.|[^"\\\n])*"', r"'(?:\\.|[^'\\\n])*'"]
        if language in ("javascript", "typescript", "go"):
            parts.append(r"`(?:\\.|[^`\\])*`")
        pat = _MASKS[language] = re.compile("|".join(parts), re.S)
    return pat


def _blank(m: "re.Match[str]") -> str:
    s = m.group(0)
    if s.startswith(("//", "/*")):
        return _NON_NL.sub(" ", s)
    if s.startswith('"""'):
        return '"""' + _NON_NL.sub(" ", s[3:-3]) + '"""'
    return s[0] + _NON_NL.sub(" ", s[1:-1]) + s[-1]


class Src:
    def __init__(self, text: str, language: str) -> None:
        self.text = text
        self.m = _mask_re(language).sub(_blank, text)
        self.starts = [0] + [x.end() for x in re.finditer("\n", text)]
        self.braces: Dict[int, int] = {}
        self.parens: Dict[int, int] = {}
        bs: List[int] = []
        ps: List[int] = []
        for x in re.finditer(r"[(){}]", self.m):
            ch, pos = x.group(), x.start()
            if ch == "{":
                bs.append(pos)
            elif ch == "}":
                if bs:
                    self.braces[bs.pop()] = pos
            elif ch == "(":
                ps.append(pos)
            elif ps:
                self.parens[ps.pop()] = pos

    def line(self, pos: int) -> int:
        return bisect.bisect_right(self.starts, pos)

    def body(self, open_pos: int) -> Tuple[str, str]:
        close = self.braces.get(open_pos, open_pos)
        return self.m[open_pos + 1:close], self.text[open_pos + 1:close]


def _in_ranges(pos: int, ranges: List[Tuple[int, int]]) -> bool:
    return any(a <= pos <= b for a, b in ranges)


# ------------------------------------------------------------------ JS / TS

_JS_CATCH = re.compile(r"\s*catch\b\s*(?:\(([^)]*)\))?\s*\{")
_JS_FINALLY = re.compile(r"\s*finally\s*\{")
_JS_LOG = re.compile(r"\b(?:console\.(?:error|warn)|logger\.\w+|log\.(?:error|warn|fatal)\w*|"
                     r"Sentry\.\w+|captureException|reportError|winston\.\w+|bunyan\.\w+|pino\.\w+)\b")
_JS_PRINT = re.compile(r"\bconsole\.(?:log|info|debug|trace)\b|\bnext\s*\(\s*\w+|\breject\s*\(|"
                       r"\bcallback\s*\(\s*\w*err|\bprocess\.exit\b|\bres\.status\b|\bsetError\b")
_JS_NARROW = re.compile(r"\binstanceof\b|\.(?:name|code|status|statusCode)\s*[=!]==?|\bcode\s*===")
_JS_RISKY = [
    ("net", re.compile(r"\bfetch\s*\(|\baxios(?:\.\w+)?\s*\(|\bhttps?\.(?:get|request)\s*\(|\bgot(?:\.\w+)?\s*\(")),
    ("parse", re.compile(r"\bJSON\.parse\s*\(")),
    ("io", re.compile(r"\bfs(?:\.promises)?\.(?:readFile|writeFile|readFileSync|writeFileSync|unlink|"
                      r"mkdir|readdir|stat|rm|appendFile|copyFile|rename|readdirSync|mkdirSync|"
                      r"unlinkSync|statSync)\s*\(")),
    ("proc", re.compile(r"\b(?:exec|execSync|spawn|spawnSync|execFile)\s*\(")),
    ("db", re.compile(r"\.(?:query|findOne|findMany|insertOne|updateOne|deleteOne)\s*\(")),
]
_JS_RES = re.compile(r"\bfs\.(?:openSync|open)\s*\(|\bcreate(?:Read|Write)Stream\s*\(|\bnew\s+WebSocket\s*\(")
_JS_CLOSE = re.compile(r"\.(?:close|destroy|end)\s*\(|\bpipeline\s*\(|\bfinished\s*\(")
_JS_FUNC = re.compile(
    r"(?<![\w$.])function\b\s*\*?\s*[A-Za-z_$][\w$]*\s*(?:<[^()]*?>)?\(\s*[^)\s]"
    r"|(?:export\s+)?(?:const|let)\s+[A-Za-z_$][\w$]*\s*(?::[^=]+)?=\s*(?:async\s*)?\(\s*[^)\s][^)]*\)\s*(?::[^=>]+)?=>"
)
_JS_GUARD = re.compile(
    r"\bthrow\s+new\s+(?:TypeError|RangeError|Error|\w*(?:Error|Exception))\b|\btypeof\s+[\w$.]+\s*[!=]==?|"
    r"\bArray\.isArray\s*\(|\bNumber\.isFinite\s*\(|\bassert(?:\.\w+)?\s*\(|\binvariant\s*\(|"
    r"\bif\s*\(\s*!\s*[\w$.]+\s*\)\s*(?:return|throw)|\b(?:zod|joi|yup|ajv)\b|\.safeParse\s*\(|\.validate\s*\("
)
_JS_CLASS = re.compile(r"\bclass\s+([A-Za-z_$][\w$]*)\s+extends\s+([A-Za-z_$][\w$.]*)")
_JS_THROW_NEW = re.compile(r"\bthrow\s+new\s+([A-Za-z_$][\w$]*)")


def _handler_text_flags(m: str, t: str) -> dict:
    throws_new = re.findall(r"\bthrow\s+new\b[^;]*", m)
    return dict(
        raised=bool(re.search(r"\bthrow\b", m)),
        reraised=bool(re.search(r"\bthrow\s+(?:e|err|error|ex|exception)\s*;?\s*$", m.strip(), re.M)),
        new_raises=len(throws_new),
        chained=sum(1 for x in throws_new if "cause" in x),
        logged=bool(_JS_LOG.search(m)),
        printed=bool(_JS_PRINT.search(m)),
    )


def analyze_js(src: Src, res: FileResult) -> None:
    m = src.m
    try_ranges: List[Tuple[int, int]] = []
    for t in re.finditer(r"\btry\s*\{", m):
        res.inc("tries")
        open_pos = t.end() - 1
        close = src.braces.get(open_pos)
        if close is None:
            continue
        cm = _JS_CATCH.match(m, close + 1)
        nxt = close + 1
        if cm:
            try_ranges.append((open_pos, close))
            bopen = cm.end() - 1
            bm, bt = src.body(bopen)
            nxt = src.braces.get(bopen, bopen) + 1
            _js_handler(src, res, bm, bt, t.start())
        fm = _JS_FINALLY.match(m, nxt)
        if fm:
            res.inc("tries_finally")
    for c in re.finditer(r"\.catch\s*\(", m):
        popen = c.end() - 1
        pclose = src.parens.get(popen)
        if pclose is None:
            continue
        inner_m, inner_t = m[popen + 1:pclose], src.text[popen + 1:pclose]
        _js_handler(src, res, inner_m, inner_t, c.start(), promise=True)

    for cat, rx in _JS_RISKY:
        for r in rx.finditer(m):
            res.inc("risky_total")
            res.inc("risky_" + cat)
            tail = m[r.end(): r.end() + 400]
            semi = re.search(r";|\n\s*\n", tail)
            stmt_tail = tail[: semi.start()] if semi else tail
            if _in_ranges(r.start(), try_ranges) or ".catch(" in stmt_tail:
                res.inc("risky_covered")
                res.inc("riskycov_" + cat)
            else:
                res.add("unprotected_call", src.line(r.start()), f"{r.group().strip('( ')} ({cat}) is not inside try/catch")
            if cat == "net":
                res.inc("net_total")
                pc = src.parens.get(r.end() - 1)
                args = m[r.end(): pc] if pc else tail
                if not re.search(r"\btimeout\b|\bsignal\b", args) and not re.search(
                        r"AbortController|AbortSignal|\btimeout\b", m):
                    res.inc("net_no_timeout")
                    res.add("network_no_timeout", src.line(r.start()), "network call without timeout/abort signal")

    acq = len(_JS_RES.findall(m))
    if acq:
        closers = len(_JS_CLOSE.findall(m)) + res.c.get("tries_finally", 0)
        manual = min(acq, closers)
        res.inc("res_manual", manual)
        if acq > manual:
            res.inc("res_unmanaged", acq - manual)
            res.add("unclosed_resource", 1, f"{acq - manual} stream/handle(s) opened without a visible close")
    res.inc("with_stmts", len(re.findall(r"\busing\s+\w+\s*=|\bawait\s+using\s+\w+\s*=", m)))

    funcs = len(_JS_FUNC.findall(m))
    guards = len(_JS_GUARD.findall(m))
    if funcs and not res.is_test:
        res.inc("funcs_public", funcs)
        res.inc("funcs_validated", min(funcs, guards))
        res.inc("funcs_nontrivial", funcs)
        res.inc("funcs_defensive", min(funcs, guards + len(re.findall(r"\?\.|\?\?|\|\|\s*\{?\s*\}?", m)) // 3))

    for cm_ in _JS_CLASS.finditer(m):
        res.classes.append((cm_.group(1), (cm_.group(2).split(".")[-1],)))
    for tn in _JS_THROW_NEW.finditer(m):
        res.used_names.add(tn.group(1))
    for caught in re.finditer(r"\binstanceof\s+([A-Za-z_$][\w$]*)", m):
        res.used_names.add(caught.group(1))


def _js_handler(src: Src, res: FileResult, m: str, t: str, pos: int, promise: bool = False) -> None:
    flags = _handler_text_flags(m, t)
    stripped = m.strip()
    if promise:
        core = re.sub(r"^\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>\s*", "", stripped)
        trivial = core in ("", "{}", "{ }", "null", "undefined", "void 0", "() => {}") or \
            (core.startswith("{") and core[1:-1].strip() == "")
        if not trivial and not re.search(r"\(|\bthrow\b", core):
            trivial = True
    else:
        trivial = stripped == ""
    narrow = bool(_JS_NARROW.search(m))
    record_handler(res, "specific" if narrow else "untyped", line=src.line(pos),
                   trivial=trivial, uses_exc=bool(re.search(r"\b(?:e|err|error|ex)\b", m)) and not trivial,
                   label="promise .catch" if promise else "", **flags)


# ------------------------------------------------------------------ Java

_J_TRY = re.compile(r"\btry\s*(\()?")
_J_CATCH = re.compile(r"\s*catch\s*\(([^)]*)\)\s*\{")
_J_FINALLY = re.compile(r"\s*finally\s*\{")
_J_BROAD = {"Exception", "Throwable", "RuntimeException", "Error"}
_J_LOG = re.compile(r"\b(?:log|logger|LOG|LOGGER|LOGGING|Log|Logger)\w*\s*\.\s*(?:error|warn|warning|fatal|severe|info|debug|trace|log|atError|atWarn)\s*\(|"
                    r"\bLogger\.\w+\s*\(|\bLog\.[ewiv]\s*\(")
_J_PRINT = re.compile(r"\.printStackTrace\s*\(|System\.(?:err|out)\.print|Thread\.currentThread\(\)\.interrupt|System\.exit\s*\(")
_J_RISKY = [
    ("io", re.compile(r"\bFiles\.\w+\s*\(|\bnew\s+(?:FileReader|FileWriter|FileInputStream|FileOutputStream|RandomAccessFile)\s*\(")),
    ("net", re.compile(r"\.openConnection\s*\(|\bHttpClient\b[^;]*\.send\s*\(|\.execute\s*\(\s*new\s+Http|\bnew\s+(?:Socket|ServerSocket)\s*\(")),
    ("parse", re.compile(r"\b(?:Integer|Long|Double|Float|Short|Byte)\.parse\w+\s*\(|\.readValue\s*\(|\.parse\s*\(\s*\w+\s*\)|\bClass\.forName\s*\(|\bUUID\.fromString\s*\(")),
    ("db", re.compile(r"\.(?:executeQuery|executeUpdate|prepareStatement|getConnection)\s*\(")),
    ("proc", re.compile(r"\bRuntime\.getRuntime\(\)\.exec\s*\(|\bnew\s+ProcessBuilder\s*\(")),
]
_J_RES = re.compile(r"\bnew\s+(?:FileReader|FileWriter|FileInputStream|FileOutputStream|BufferedReader|BufferedWriter|"
                    r"InputStreamReader|OutputStreamWriter|PrintWriter|Scanner|Socket|ServerSocket|RandomAccessFile|"
                    r"ObjectInputStream|ObjectOutputStream|ZipFile)\s*\(|\bFiles\.(?:newBufferedReader|newBufferedWriter|newInputStream|newOutputStream|lines|walk|list)\s*\(|\.getConnection\s*\(")
_J_METHOD = re.compile(r"\b(?:public|protected)\s+(?:static\s+|final\s+|synchronized\s+)*[\w<>\[\],.? ]+\s+\w+\s*\([^)]+\)\s*(?:throws\s+[\w., ]+)?\{")
_J_GUARD = re.compile(r"\bObjects\.requireNonNull\s*\(|\bPreconditions\.check\w+\s*\(|\bValidate\.\w+\s*\(|\bAssert\.\w+\s*\(|"
                      r"\bthrow\s+new\s+(?:IllegalArgument|IllegalState|NullPointer|UnsupportedOperation|IndexOutOfBounds|NumberFormat)\w*\s*\(|"
                      r"@(?:NotNull|Nonnull|NonNull|Valid|Validated)\b")
_J_DEFENSIVE = re.compile(r"\b\w+\s*(?:==|!=)\s*null\b|\binstanceof\b|\bOptional\.\w+\s*\(")
_J_CLASS = re.compile(r"\bclass\s+(\w+)(?:<[^{>]*>)?\s+extends\s+([\w.]+)")


def analyze_java(src: Src, res: FileResult) -> None:
    m = src.m
    try_ranges: List[Tuple[int, int]] = []
    twr_ranges: List[Tuple[int, int]] = []
    for t in _J_TRY.finditer(m):
        pos = t.end()
        resources_open = t.group(1)
        if resources_open:
            pclose = src.parens.get(t.end() - 1)
            if pclose is None:
                continue
            twr_ranges.append((t.end() - 1, pclose))
            res.inc("with_stmts")
            res.inc("res_with", max(1, m[t.end():pclose].count(";") + (1 if m[t.end():pclose].strip().rstrip(";") else 0)))
            pos = pclose + 1
        bm = re.compile(r"\s*\{").match(m, pos)
        if not bm:
            continue
        res.inc("tries")
        bopen = bm.end() - 1
        bclose = src.braces.get(bopen)
        if bclose is None:
            continue
        end = bclose + 1
        had_catch = False
        while True:
            cm = _J_CATCH.match(m, end)
            if not cm:
                break
            had_catch = True
            param = cm.group(1).strip()
            toks = param.rsplit(None, 1)
            var = toks[-1] if toks else "e"
            types = [x.strip().split(".")[-1] for x in (toks[0] if len(toks) > 1 else param).replace("final", "").split("|")]
            kind = "broad" if any(x in _J_BROAD for x in types) else "specific"
            hopen = cm.end() - 1
            hm, ht = src.body(hopen)
            for ty in types:
                res.used_names.add(ty)
            raised = bool(re.search(r"\bthrow\b", hm))
            new = len(re.findall(r"\bthrow\s+new\b", hm))
            chained = len(re.findall(r"\bthrow\s+new\b[^;]*\b%s\b" % re.escape(var), hm))
            reraised = bool(re.search(r"\bthrow\s+%s\s*;" % re.escape(var), hm))
            logged = bool(_J_LOG.search(hm))
            printed = bool(_J_PRINT.search(hm))
            uses = bool(re.search(r"\b%s\b" % re.escape(var), hm))
            record_handler(res, kind, line=src.line(cm.start() if cm.start() else t.start()), raised=raised,
                           reraised=reraised, new_raises=new, chained=chained, logged=logged,
                           printed=printed, uses_exc=uses and not (logged or raised),
                           trivial=hm.strip() == "", label=", ".join(types))
            end = src.braces.get(hopen, hopen) + 1
        if had_catch:
            try_ranges.append((bopen, bclose))
        if _J_FINALLY.match(m, end):
            res.inc("tries_finally")

    throws_ranges = [
        (x.start(), src.braces.get(x.end() - 1, x.end()))
        for x in re.finditer(r"\)\s*throws\s+[\w., ]+\{", m)
    ]
    for cat, rx in _J_RISKY:
        for r in rx.finditer(m):
            res.inc("risky_total")
            res.inc("risky_" + cat)
            if _in_ranges(r.start(), try_ranges) or _in_ranges(r.start(), throws_ranges) \
                    or _in_ranges(r.start(), twr_ranges):
                res.inc("risky_covered")
                res.inc("riskycov_" + cat)
            else:
                res.add("unprotected_call", src.line(r.start()), f"{cat} call is neither in try/catch nor in a method declaring `throws`")
            if cat == "net":
                res.inc("net_total")
                if not re.search(r"[Tt]imeout", m):
                    res.inc("net_no_timeout")
                    res.add("network_no_timeout", src.line(r.start()), "network call without any timeout configured in this file")

    twr_total = sum(1 for r in _J_RES.finditer(m) if _in_ranges(r.start(), twr_ranges))
    acq = len(_J_RES.findall(m))
    plain = max(0, acq - twr_total)
    if plain:
        closers = len(re.findall(r"\.close\s*\(", m)) + res.c.get("tries_finally", 0)
        manual = min(plain, closers)
        res.inc("res_manual", manual)
        if plain > manual:
            res.inc("res_unmanaged", plain - manual)
            res.add("unclosed_resource", 1, f"{plain - manual} resource(s) created outside try-with-resources and never closed")

    funcs = len(_J_METHOD.findall(m))
    guards = len(_J_GUARD.findall(m))
    if funcs and not res.is_test:
        res.inc("funcs_public", funcs)
        res.inc("funcs_nontrivial", funcs)
        res.inc("funcs_validated", min(funcs, guards))
        res.inc("funcs_defensive", min(funcs, guards + len(_J_DEFENSIVE.findall(m)) // 2))
    for cm_ in _J_CLASS.finditer(m):
        res.classes.append((cm_.group(1), (cm_.group(2).split(".")[-1],)))
    for tn in re.finditer(r"\bthrow\s+new\s+(\w+)", m):
        res.used_names.add(tn.group(1))
        if tn.group(1) in ("Exception", "Throwable", "RuntimeException"):
            res.inc("raise_generic")
            res.add("raise_generic_exception", src.line(tn.start()), f"throws generic {tn.group(1)}")
        res.inc("raises")
    if re.search(r"\bimplements\s+[^{]*\bAutoCloseable\b|\bimplements\s+[^{]*\bCloseable\b", m):
        res.inc("ctx_defs")


# ------------------------------------------------------------------ Go

_GO_FUNC = re.compile(r"\bfunc\b[^{;]*\{")
_GO_IF_ERR = re.compile(r"\bif\s+(?:[^;{]*;\s*)?(\w*[eE]rr\w*)\s*!=\s*nil\s*\{")
_GO_LOG = re.compile(r"\b(?:log|logger|slog|zap|logrus|klog|glog)\w*\s*\.\s*\w+\s*\(|\bt\.(?:Fatal|Error)\w*\s*\(|\.Err\s*\(|\bLogger\.")
_GO_IGNORED = re.compile(r"^\s*_\s*=\s*[\w.]+\s*\(|,\s*_\s*:?=\s*(?:os|io|ioutil|json|strconv|fmt|http|sql|bufio|exec|net|filepath|xml|yaml|time)\.\w+\s*\(", re.M)
_GO_RISKY = [
    ("io", re.compile(r"\b(?:os\.(?:Open|Create|OpenFile|ReadFile|WriteFile|Remove|RemoveAll|Mkdir|MkdirAll|Rename|ReadDir|Stat)|ioutil\.\w+)\s*\(")),
    ("parse", re.compile(r"\b(?:json|xml|yaml|toml)\.(?:Unmarshal|Marshal|NewDecoder)\s*\(|\bstrconv\.\w+\s*\(|\btime\.Parse\s*\(")),
    ("net", re.compile(r"\bhttp\.(?:Get|Post|Head|NewRequest|PostForm)\s*\(|\bnet\.Dial\w*\s*\(|\.Do\s*\(\s*\w+\s*\)")),
    ("db", re.compile(r"\bsql\.Open\s*\(|\.(?:Query|QueryRow|Exec|QueryContext|ExecContext)\s*\(")),
    ("proc", re.compile(r"\bexec\.Command\w*\([^)]*\)\.(?:Run|Output|CombinedOutput|Start)\s*\(")),
]
_GO_RES = re.compile(r"\b(?:os\.(?:Open|Create|OpenFile)|sql\.Open|net\.Dial\w*|http\.(?:Get|Post)|os\.CreateTemp|ioutil\.TempFile)\s*\(")
_GO_TYPE_ERR = re.compile(r"\bfunc\s*\(\s*\w*\s*\*?(\w+)\s*\)\s*Error\s*\(\s*\)\s*string")
_GO_SENTINEL = re.compile(r"\b(?:var\s+)?(Err\w+)\s*=\s*(?:errors\.New|fmt\.Errorf)\s*\(")
_GO_EXPORTED = re.compile(r"\bfunc\s+(?:\([^)]*\)\s*)?[A-Z]\w*\s*\([^)]+\)")
_GO_GUARD = re.compile(r"\bif\s+[\w.\[\]]+\s*(?:==\s*(?:nil|\"\"|0)|<=?\s*0|==\s*len\([^)]*\))\s*\{\s*(?:return|panic)|\bif\s+len\([^)]*\)\s*(?:==|<)\s*\d+\s*\{\s*return")


def analyze_go(src: Src, res: FileResult) -> None:
    m = src.m
    funcs = []
    for f in _GO_FUNC.finditer(m):
        open_pos = f.end() - 1
        close = src.braces.get(open_pos)
        if close is not None:
            funcs.append((f.start(), open_pos, close))

    for h in _GO_IF_ERR.finditer(m):
        hopen = h.end() - 1
        hm, ht = src.body(hopen)
        wrapped = "%w" in ht or bool(re.search(r"errors\.(?:Wrap|WithStack|Join)|\bwrap\w*\s*\(", hm))
        errorf = bool(re.search(r"fmt\.Errorf\s*\(|errors\.New\s*\(", hm))
        returns_err = bool(re.search(r"\breturn\b[^\n]*\berr\w*\b", hm))
        raised = returns_err or bool(re.search(r"\bpanic\s*\(", hm)) or errorf or bool(re.search(r"\breturn\b[^\n]*\bErr\w+", hm))
        new = 1 if errorf else 0
        chained = 1 if errorf and wrapped else 0
        logged = bool(_GO_LOG.search(hm))
        trivial = hm.strip() == ""
        record_handler(res, "specific", line=src.line(h.start()), raised=raised,
                       reraised=returns_err and not errorf, new_raises=new, chained=chained,
                       logged=logged, printed=bool(re.search(r"fmt\.Print|os\.Exit", hm)),
                       trivial=trivial, swallow_kind="swallowed_error",
                       unchained_kind="error_not_wrapped")
        res.inc("raises", 1 if raised else 0)
    for ig in _GO_IGNORED.finditer(m):
        record_handler(res, "bare", line=src.line(ig.start()), trivial=True, swallow_kind="ignored_error")
    res.c["f.bare_except"] = 0  # `bare` is only a scoring device in Go, not a language construct
    res.findings = [f for f in res.findings if f.kind != "bare_except"]
    res.inc("with_stmts", 0)

    for cat, rx in _GO_RISKY:
        for r in rx.finditer(m):
            res.inc("risky_total")
            res.inc("risky_" + cat)
            ls = m.rfind("\n", 0, r.start()) + 1
            prefix = m[ls:r.start()]
            covered = bool(re.search(r"\berr\w*\b|\breturn\b|\bif\b|\bt\.\w+\(|\brequire\.|\bassert\.", prefix))
            if covered:
                res.inc("risky_covered")
                res.inc("riskycov_" + cat)
            else:
                res.add("unprotected_call", src.line(r.start()), f"{cat} call result is not checked for an error")
            if cat == "net" and ("http.Get" in r.group() or "http.Post" in r.group()):
                res.inc("net_total")
                if not re.search(r"Timeout|WithTimeout|WithDeadline", m):
                    res.inc("net_no_timeout")
                    res.add("network_no_timeout", src.line(r.start()), "http.Get/Post uses the default client with no timeout")

    for fstart, fopen, fclose in funcs:
        fm_ = m[fopen:fclose]
        defers = len(re.findall(r"\bdefer\b", fm_))
        res.inc("tries_finally", defers)
        for r in _GO_RES.finditer(fm_):
            if re.search(r"\bdefer\b[^\n]*\.(?:Close|Body\.Close|Rollback|Cancel)\s*\(", fm_):
                res.inc("res_with")
            elif re.search(r"\.Close\s*\(", fm_):
                res.inc("res_manual")
            else:
                res.inc("res_unmanaged")
                res.add("unclosed_resource", src.line(fopen + r.start()), "opened but never closed or deferred")

    exported = len(_GO_EXPORTED.findall(m))
    if exported and not res.is_test:
        guards = len(_GO_GUARD.findall(m))
        res.inc("funcs_public", exported)
        res.inc("funcs_nontrivial", exported)
        res.inc("funcs_validated", min(exported, guards))
        res.inc("funcs_defensive", min(exported, guards + len(re.findall(r"\bok\b\s*:?=|,\s*ok\s*:?=", m)) // 2))

    for tm in _GO_TYPE_ERR.finditer(m):
        res.classes.append((tm.group(1), ("Error",)))
        if m.count(tm.group(1)) > 2:
            res.used_names.add(tm.group(1))
    for sm in _GO_SENTINEL.finditer(m):
        res.classes.append((sm.group(1), ("Error",)))
        if m.count(sm.group(1)) > 1:
            res.used_names.add(sm.group(1))
    if re.search(r"\bUnwrap\s*\(\s*\)\s*error", m):
        res.inc("ctx_defs")
    res.inc("errors_is_as", len(re.findall(r"\berrors\.(?:Is|As)\s*\(", m)))
