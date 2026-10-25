"""Unit and end-to-end tests (standard library unittest; no network needed)."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from modularity.analyzers import AnalysisLimits, analyze_entry, mask_source  # noqa: E402
from modularity.graph import _tarjan, build_graph  # noqa: E402
from modularity.models import AnalysisOptions, FileEntry  # noqa: E402
from modularity.pipeline import NoSourceFilesError, run  # noqa: E402
from modularity.repo import InvalidRepoSpec, RepoWorkspace, parse_github_spec, secure_rmtree  # noqa: E402
from modularity.scanner import is_test_path, scan_repository  # noqa: E402
from modularity.scoring import WEIGHTS, lin_down, lin_up, name_style  # noqa: E402

LIMITS = AnalysisLimits()


def write(root: str, rel: str, content: str) -> str:
    path = os.path.join(root, *rel.split("/"))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(textwrap.dedent(content))
    return path


def analyze_snippet(tmp: str, rel: str, content: str, language: str):
    path = write(tmp, rel, content)
    entry = FileEntry(path, rel, language, os.path.getsize(path))
    return analyze_entry(entry, LIMITS)


class WeightsTest(unittest.TestCase):
    def test_weights_sum_to_one(self):
        self.assertAlmostEqual(sum(WEIGHTS.values()), 1.0)

    def test_interpolation(self):
        self.assertEqual(lin_down(5, 10, 20), 1.0)
        self.assertEqual(lin_down(25, 10, 20), 0.0)
        self.assertAlmostEqual(lin_down(15, 10, 20), 0.5)
        self.assertAlmostEqual(lin_up(15, 10, 20), 0.5)

    def test_name_style(self):
        self.assertEqual(name_style("my_func", False), "snake")
        self.assertEqual(name_style("myFunc", False), "camel")
        self.assertEqual(name_style("MyFunc", True), "camel/pascal")
        self.assertIsNone(name_style("run", False))


class RepoSpecTest(unittest.TestCase):
    def test_accepted_forms(self):
        for spec in (
            "https://github.com/psf/requests",
            "https://github.com/psf/requests.git",
            "http://www.github.com/psf/requests/tree/main/src",
            "github.com/psf/requests",
            "git@github.com:psf/requests.git",
            "psf/requests",
        ):
            repo = parse_github_spec(spec)
            self.assertIsNotNone(repo, spec)
            self.assertEqual((repo.owner, repo.name), ("psf", "requests"))

    def test_rejected_forms(self):
        for spec in ("https://gitlab.com/a/b", "justaword", "-x/y", "a/b/c", "https://github.com/onlyowner"):
            self.assertIsNone(parse_github_spec(spec), spec)

    def test_invalid_spec_raises(self):
        with self.assertRaises(InvalidRepoSpec):
            with RepoWorkspace("https://gitlab.com/a/b"):
                pass
        with self.assertRaises(InvalidRepoSpec):
            with RepoWorkspace("definitely-not-a-path-or-repo"):
                pass


class MaskTest(unittest.TestCase):
    def test_comments_and_strings_blanked_offsets_kept(self):
        src = 'int a = 1; // x { y\nchar *s = "}{ //"; /* ( */ int b;\n'
        masked = mask_source(src, "c")
        self.assertEqual(len(masked), len(src))
        self.assertEqual(masked.count("\n"), src.count("\n"))
        self.assertNotIn("{", masked)
        self.assertNotIn("}", masked)
        self.assertNotIn("(", masked)


class PythonAnalysisTest(unittest.TestCase):
    def test_ast_metrics(self):
        with tempfile.TemporaryDirectory() as tmp:
            fm = analyze_snippet(tmp, "m.py", '''
                import os
                from . import sibling
                from .pkg import thing

                __all__ = ["f"]

                def f(a, b, c=1):
                    if a and b or c:
                        for i in range(3):
                            pass
                    return [x for x in range(4) if x]

                def _hidden():
                    return 1

                class K:
                    def m(self, x):
                        try:
                            return x
                        except ValueError:
                            return None

                if __name__ == "__main__":
                    f(1, 2)
            ''', "python")
        self.assertEqual(fm.parse_mode, "ast")
        by_name = {fn.name: fn for fn in fm.functions}
        self.assertEqual(set(by_name), {"f", "_hidden", "m"})
        self.assertEqual(by_name["f"].params, 3)
        self.assertEqual(by_name["m"].params, 1)  # self excluded
        # 1 + if + (and, or) + for + comprehension(1 + 1 if)
        self.assertEqual(by_name["f"].complexity, 1 + 1 + 2 + 1 + 2)
        self.assertEqual(by_name["m"].complexity, 2)
        self.assertTrue(by_name["_hidden"].private)
        self.assertTrue(fm.is_entry_point)
        self.assertEqual(fm.classes, 1)
        self.assertEqual(len(fm.imports), 3)
        self.assertEqual(fm.public_members, 3)  # f, K, K.m
        self.assertEqual(fm.private_members, 1)  # _hidden

    def test_syntax_error_falls_back(self):
        with tempfile.TemporaryDirectory() as tmp:
            fm = analyze_snippet(tmp, "old.py", """
                import os
                def legacy(x):
                    print "hello", x
                    if x:
                        return 1
            """, "python")
        self.assertEqual(fm.parse_mode, "fallback")
        self.assertEqual([f.name for f in fm.functions], ["legacy"])

    def test_generated_file_skipped(self):
        with tempfile.TemporaryDirectory() as tmp:
            fm = analyze_snippet(tmp, "g.py", "# Code generated by tool. DO NOT EDIT.\nx = 1\n", "python")
        self.assertEqual(fm.skipped, "generated")


class BraceLanguageTest(unittest.TestCase):
    def test_javascript(self):
        with tempfile.TemporaryDirectory() as tmp:
            fm = analyze_snippet(tmp, "a.js", """
                import fs from 'fs';
                import { x } from './util';
                const y = require('../lib/y');
                // function commented() { }
                export function alpha(a, b) {
                  if (a && b) { return 1; }
                  const s = "function fake() {}";
                  return a ? b : 0;
                }
                export const beta = (v) => {
                  for (const i of v) { if (i) continue; }
                  return v;
                };
                const gamma = (z) => z + 1;
                class Widget {
                  #secret = 1;
                  render(props) {
                    return props.x || 2;
                  }
                  _helper() { return 1; }
                }
            """, "javascript")
        names = sorted(f.name for f in fm.functions)
        self.assertEqual(names, ["_helper", "alpha", "beta", "gamma", "render"])
        alpha = next(f for f in fm.functions if f.name == "alpha")
        self.assertEqual(alpha.params, 2)
        self.assertEqual(alpha.complexity, 1 + 1 + 1 + 1)  # if, &&, ternary
        self.assertEqual({r.spec for r in fm.imports}, {"fs", "./util", "../lib/y"})
        self.assertEqual(fm.classes, 1)
        self.assertGreaterEqual(fm.private_members, 2)
        self.assertEqual(fm.public_members, 2)

    def test_java(self):
        with tempfile.TemporaryDirectory() as tmp:
            fm = analyze_snippet(tmp, "src/main/java/com/acme/Svc.java", """
                package com.acme;
                import java.util.List;
                import com.acme.model.User;
                import static com.acme.util.Strings.join;

                public class Svc implements Runnable {
                    private int count;
                    public Svc() { count = 0; }
                    @Override public void run() {
                        if (count > 1 && count < 5) { count++; }
                        for (int i = 0; i < 3; i++) { count += i; }
                    }
                    private int helper(int a, List<String> b) {
                        try { return a; } catch (Exception e) { return 0; }
                    }
                    public static void main(String[] args) { new Svc().run(); }
                }
                interface Shape { double area(); double perimeter(); }
            """, "java")
        self.assertEqual(sorted(f.name for f in fm.functions), ["Svc", "helper", "main", "run"])
        helper = next(f for f in fm.functions if f.name == "helper")
        self.assertTrue(helper.private)
        self.assertEqual(helper.params, 2)
        self.assertEqual(helper.complexity, 2)
        self.assertEqual(fm.package, "com.acme")
        self.assertEqual(len(fm.imports), 3)
        self.assertTrue(fm.is_entry_point)
        self.assertEqual(fm.classes, 1)
        self.assertEqual(len(fm.interface_sizes), 1)

    def test_go(self):
        with tempfile.TemporaryDirectory() as tmp:
            fm = analyze_snippet(tmp, "main.go", """
                package main

                import (
                    "fmt"
                    util "example.com/app/util"
                )

                type Server struct{ port int }
                type handler interface {
                    Serve() error
                }

                func (s *Server) Start(a, b int) error {
                    if a > b {
                        return nil
                    }
                    return nil
                }

                func helper() {}

                func main() {
                    fmt.Println("hi")
                }
            """, "go")
        self.assertEqual(sorted(f.name for f in fm.functions), ["Start", "helper", "main"])
        self.assertEqual({r.spec for r in fm.imports}, {"fmt", "example.com/app/util"})
        self.assertTrue(fm.is_entry_point)
        self.assertEqual(fm.classes, 1)
        self.assertEqual(len(fm.interface_sizes), 1)
        self.assertEqual(fm.public_members, 2)   # Start, Server
        self.assertEqual(fm.private_members, 3)  # helper, main, handler

    def test_c_and_cpp(self):
        with tempfile.TemporaryDirectory() as tmp:
            fm = analyze_snippet(tmp, "x.c", """
                #include <stdio.h>
                #include "local.h"

                static int helper(int a) {
                    if (a > 0 && a < 10) { return 1; }
                    return 0;
                }

                int compute(int a, int b) {
                    while (a < b) { a++; }
                    return helper(a);
                }

                int main(void) {
                    printf("%d", compute(1, 2));
                    return 0;
                }
            """, "c")
            cpp = analyze_snippet(tmp, "y.cpp", """
                #include "y.h"
                class Base { public: virtual void run() = 0; virtual int id() = 0; };
                int Widget::size() const {
                    return 1;
                }
            """, "cpp")
        self.assertEqual(sorted(f.name for f in fm.functions), ["compute", "helper", "main"])
        self.assertTrue(next(f for f in fm.functions if f.name == "helper").private)
        self.assertEqual({(r.spec, r.level) for r in fm.imports}, {("stdio.h", 1), ("local.h", 0)})
        self.assertTrue(fm.is_entry_point)
        self.assertEqual([f.name for f in cpp.functions], ["size"])
        self.assertEqual(cpp.interface_sizes, [2])

    def test_no_false_positives_for_control_flow(self):
        with tempfile.TemporaryDirectory() as tmp:
            fm = analyze_snippet(tmp, "z.c", """
                void f(void) {
                    if (x) { y(); }
                    for (;;) { z(1) ; }
                    while (q) { }
                    switch (k) { case 1: break; }
                }
            """, "c")
        self.assertEqual([f.name for f in fm.functions], ["f"])


class GraphTest(unittest.TestCase):
    def test_tarjan_finds_cycles(self):
        adj = [[1], [2], [0], [0], []]
        comps = sorted(sorted(c) for c in _tarjan(adj))
        self.assertIn([0, 1, 2], comps)
        self.assertIn([3], comps)

    def test_deep_chain_does_not_recurse(self):
        n = 5000
        adj = [[i + 1] for i in range(n - 1)] + [[]]
        self.assertEqual(len(_tarjan(adj)), n)

    def test_python_resolution_cycles_and_depth(self):
        with tempfile.TemporaryDirectory() as tmp:
            write(tmp, "pkg/__init__.py", "")
            write(tmp, "pkg/a.py", "from . import b\nfrom pkg.c import thing\n")
            write(tmp, "pkg/b.py", "from .a import x\n")
            write(tmp, "pkg/c.py", "import os\nthing = 1\n")
            scan = scan_repository(tmp, AnalysisOptions())
            metrics = [analyze_entry(e, LIMITS) for e in scan.entries]
            scored = [m for m in metrics if m.loc > 0]
            graph = build_graph(metrics, scored, {})
        self.assertEqual(graph.adj["pkg/a.py"], {"pkg/b.py", "pkg/c.py"})
        self.assertEqual(graph.adj["pkg/b.py"], {"pkg/a.py"})
        self.assertEqual(graph.cyclic_nodes, {"pkg/a.py", "pkg/b.py"})
        self.assertEqual(graph.depth, 2)

    def test_js_java_go_c_resolution(self):
        with tempfile.TemporaryDirectory() as tmp:
            write(tmp, "web/a.js", "import x from './lib/b';\nimport y from '../util';\nexport const a = 1;\n")
            write(tmp, "web/lib/b.ts", "export const b = 1;\n")
            write(tmp, "util/index.js", "module.exports = {};\n")
            write(tmp, "j/src/main/java/com/acme/A.java",
                  "package com.acme;\nimport com.acme.sub.B;\npublic class A {}\n")
            write(tmp, "j/src/main/java/com/acme/sub/B.java", "package com.acme.sub;\npublic class B {}\n")
            write(tmp, "go.mod", "module example.com/app\n")
            write(tmp, "cmd/main.go", 'package main\nimport "example.com/app/internal/svc"\nfunc main() {}\n')
            write(tmp, "internal/svc/svc.go", "package svc\nfunc Run() {}\n")
            write(tmp, "c/a.c", '#include "a.h"\n#include <stdio.h>\nint main(void) { return 0; }\n')
            write(tmp, "c/a.h", "int f(void);\n")
            scan = scan_repository(tmp, AnalysisOptions())
            metrics = [analyze_entry(e, LIMITS) for e in scan.entries]
            scored = [m for m in metrics if m.loc > 0]
            graph = build_graph(metrics, scored, scan.go_modules)
        self.assertEqual(graph.adj["web/a.js"], {"web/lib/b.ts", "util/index.js"})
        self.assertEqual(graph.adj["j/src/main/java/com/acme/A.java"], {"j/src/main/java/com/acme/sub/B.java"})
        self.assertEqual(graph.adj["cmd/main.go"], {"internal/svc/svc.go"})
        self.assertEqual(graph.adj["c/a.c"], {"c/a.h"})


class ScannerTest(unittest.TestCase):
    def test_ignores_and_limits(self):
        with tempfile.TemporaryDirectory() as tmp:
            write(tmp, "src/a.py", "x = 1\n")
            write(tmp, "node_modules/x/index.js", "var a;\n")
            write(tmp, ".git/hooks/h.py", "x=1\n")
            write(tmp, "build/gen.py", "x=1\n")
            write(tmp, "src/deep/er/b.py", "x = 2\n")
            write(tmp, "app.min.js", "var a=1;\n")
            with open(os.path.join(tmp, "blob.py"), "wb") as fh:
                fh.write(b"\0" * 100)
            scan = scan_repository(tmp, AnalysisOptions())
            self.assertEqual({e.rel_path for e in scan.entries}, {"src/a.py", "src/deep/er/b.py", "blob.py"})
            shallow = scan_repository(tmp, AnalysisOptions(max_depth=1))
            self.assertEqual({e.rel_path for e in shallow.entries}, {"src/a.py", "blob.py"})
            capped = scan_repository(tmp, AnalysisOptions(max_files=1))
            self.assertEqual(len(capped.entries), 1)
            self.assertTrue(capped.truncated_by_max_files)
            metrics = analyze_entry(next(e for e in scan.entries if e.rel_path == "blob.py"), LIMITS)
            self.assertEqual(metrics.skipped, "binary")

    def test_symlinks_not_followed(self):
        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as outside:
            write(outside, "secret.py", "x = 1\n")
            write(tmp, "real.py", "y = 1\n")
            try:
                os.symlink(outside, os.path.join(tmp, "linkdir"))
                os.symlink(os.path.join(outside, "secret.py"), os.path.join(tmp, "link.py"))
            except (OSError, NotImplementedError):
                self.skipTest("symlinks unavailable")
            scan = scan_repository(tmp, AnalysisOptions())
            self.assertEqual([e.rel_path for e in scan.entries], ["real.py"])

    def test_is_test_path(self):
        for p in ("tests/a.py", "pkg/test_x.py", "a_test.go", "src/a.spec.ts", "FooTest.java"):
            self.assertTrue(is_test_path(p), p)
        for p in ("src/a.py", "contest.py", "latest.js"):
            self.assertFalse(is_test_path(p), p)


class CleanupTest(unittest.TestCase):
    def test_secure_rmtree_handles_readonly(self):
        base = tempfile.mkdtemp()
        sub = os.path.join(base, "d", "objects")
        os.makedirs(sub)
        f = os.path.join(sub, "pack.idx")
        with open(f, "w") as fh:
            fh.write("x")
        os.chmod(f, 0o400)
        os.chmod(sub, 0o500)
        self.assertTrue(secure_rmtree(base))
        self.assertFalse(os.path.exists(base))


@unittest.skipUnless(shutil.which("git"), "git not installed")
class EndToEndTest(unittest.TestCase):
    def _make_origin(self, parent: str) -> str:
        origin = os.path.join(parent, "origin")
        write(origin, "app/__init__.py", "")
        write(origin, "app/core.py", """
            def add(a, b):
                return a + b

            def sub(a, b):
                return a - b

            def mul(a, b):
                return a * b
        """)
        write(origin, "app/cli.py", "from app.core import add\n\ndef main():\n    return add(1, 2)\n\nif __name__ == '__main__':\n    main()\n")
        write(origin, "tests/test_core.py", "from app.core import add\n\ndef test_add():\n    assert add(1, 1) == 2\n")
        env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t", GIT_COMMITTER_NAME="t",
                   GIT_COMMITTER_EMAIL="t@t")
        for cmd in (["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "init"]):
            subprocess.run(["git", *cmd], cwd=origin, check=True, env=env, capture_output=True)
        return origin

    def test_local_run_produces_report_and_leaves_repo_untouched(self):
        with tempfile.TemporaryDirectory() as parent:
            origin = self._make_origin(parent)
            before = sorted(os.listdir(origin))
            result = run(origin, AnalysisOptions(show_progress=False))
            self.assertEqual(sorted(os.listdir(origin)), before)
        rep = result.report
        self.assertEqual(rep["repository"]["source"], "local")
        self.assertEqual(len(rep["repository"]["commit"]), 40)
        self.assertIsNotNone(rep["overall"]["score"])
        self.assertEqual(rep["metrics"]["test_files"], 1)
        self.assertEqual(rep["metrics"]["files_scored"], 2)  # core.py, cli.py (empty __init__ has no LOC)
        self.assertIsNone(rep["dimensions"]["code_organization"]["score"])  # needs >= 3 files
        self.assertFalse(result.used_temp_clone)
        json.dumps(rep)  # serialisable

    def test_clone_is_deleted_afterwards(self):
        created = []
        real_mkdtemp = tempfile.mkdtemp

        def spy(*a, **kw):
            d = real_mkdtemp(*a, **kw)
            created.append(d)
            return d

        with tempfile.TemporaryDirectory() as parent:
            origin = self._make_origin(parent)
            tempfile.mkdtemp = spy
            try:
                result = run("owner/repo", AnalysisOptions(show_progress=False),
                             clone_url_override="file://" + origin)
            finally:
                tempfile.mkdtemp = real_mkdtemp
        self.assertTrue(result.used_temp_clone)
        self.assertTrue(result.cleanup_ok)
        self.assertEqual(len(created), 1)
        self.assertFalse(os.path.exists(created[0]), "temporary clone must be removed")
        self.assertTrue(result.report["cleanup"]["temporary_clone_removed"])

    def test_clone_deleted_even_when_analysis_fails(self):
        created = []
        real_mkdtemp = tempfile.mkdtemp

        def spy(*a, **kw):
            d = real_mkdtemp(*a, **kw)
            created.append(d)
            return d

        with tempfile.TemporaryDirectory() as parent:
            origin = os.path.join(parent, "origin")
            write(origin, "README.md", "no code here\n")
            env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t", GIT_COMMITTER_NAME="t",
                       GIT_COMMITTER_EMAIL="t@t")
            for cmd in (["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "x"]):
                subprocess.run(["git", *cmd], cwd=origin, check=True, env=env, capture_output=True)
            tempfile.mkdtemp = spy
            try:
                with self.assertRaises(NoSourceFilesError):
                    run("owner/repo", AnalysisOptions(show_progress=False),
                        clone_url_override="file://" + origin)
            finally:
                tempfile.mkdtemp = real_mkdtemp
        self.assertEqual(len(created), 1)
        self.assertFalse(os.path.exists(created[0]))

    def test_cli_exit_codes(self):
        script = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "analyze_modularity.py")
        with tempfile.TemporaryDirectory() as parent:
            origin = self._make_origin(parent)
            out = os.path.join(parent, "r.json")
            ok = subprocess.run([sys.executable, script, origin, "-o", out, "-q"], capture_output=True, text=True)
            self.assertEqual(ok.returncode, 0, ok.stderr)
            with open(out, encoding="utf-8") as fh:
                data = json.load(fh)
            for key in ("overall", "dimensions", "metrics", "top_offenders", "repository", "warnings", "limitations"):
                self.assertIn(key, data)
            bad = subprocess.run([sys.executable, script, "https://gitlab.com/a/b", "-o", out, "-q"],
                                 capture_output=True, text=True)
            self.assertEqual(bad.returncode, 3)
            empty = os.path.join(parent, "empty")
            os.makedirs(empty)
            none = subprocess.run([sys.executable, script, empty, "-o", out, "-q"], capture_output=True, text=True)
            self.assertEqual(none.returncode, 4)


if __name__ == "__main__":
    unittest.main()
