"""Tests (stdlib unittest, no network)."""

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

from ehscorer.analyzer import analyze_entry  # noqa: E402
from ehscorer.pipeline import NoSourceFilesError, Options, run  # noqa: E402
from ehscorer.repo import parse_github_spec  # noqa: E402
from ehscorer.scanner import FileEntry, scan_repository  # noqa: E402
from ehscorer.scoring import WEIGHTS, Aggregate, resolve_custom_exceptions, score_categories  # noqa: E402


def analyze(lang: str, rel: str, code: str):
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, *rel.split("/"))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(textwrap.dedent(code))
        return analyze_entry(FileEntry(path, rel, lang, os.path.getsize(path), False))


def kinds(res):
    return {f.kind for f in res.findings}


class WeightsTest(unittest.TestCase):
    def test_sum(self):
        self.assertAlmostEqual(sum(WEIGHTS.values()), 1.0)


class SpecTest(unittest.TestCase):
    def test_parse(self):
        self.assertEqual(parse_github_spec("https://github.com/psf/requests.git").name, "requests")
        self.assertIsNone(parse_github_spec("https://gitlab.com/a/b"))


class PythonTest(unittest.TestCase):
    def test_handlers(self):
        r = analyze("python", "m.py", '''
            import logging
            log = logging.getLogger(__name__)

            def a():
                try:
                    x()
                except:
                    pass

            def b():
                try:
                    x()
                except Exception:
                    pass

            def c():
                try:
                    x()
                except ValueError as e:
                    log.error("bad %s", e)
                    raise RuntimeError("wrapped") from e

            def d():
                try:
                    x()
                except KeyError:
                    raise ValueError("no cause")

            def e():
                try:
                    import foo
                except ImportError:
                    pass
        ''')
        self.assertEqual(r.parse_mode, "ast")
        self.assertEqual(r.c["handlers"], 5)
        self.assertEqual(r.c["h_bare"], 1)
        self.assertEqual(r.c["h_broad"], 1)
        self.assertEqual(r.c["h_specific"], 3)
        self.assertEqual(r.c["h_silent"], 2)       # bare pass + broad pass; ImportError is idiomatic
        self.assertEqual(r.c["h_idiomatic"], 1)
        self.assertEqual(r.c["h_new_raise"], 2)
        self.assertEqual(r.c["h_new_chained"], 1)
        self.assertEqual(r.c["h_log"], 1)
        self.assertTrue({"bare_except", "swallowed_exception", "raise_without_cause"} <= kinds(r))

    def test_resources_and_risky_calls(self):
        r = analyze("python", "m.py", '''
            import json, requests

            def good(p):
                with open(p) as f:
                    return f.read()

            def bad(p):
                f = open(p)
                data = f.read()
                return data

            def closed(p):
                f = open(p)
                try:
                    return f.read()
                finally:
                    f.close()

            def net():
                try:
                    return requests.get("http://x", timeout=3)
                except requests.RequestException as e:
                    raise
            def net2():
                return requests.get("http://x")
            def parse(s):
                return json.loads(s)
        ''')
        self.assertEqual(r.c["res_with"], 1)
        self.assertEqual(r.c["res_unmanaged"], 1)
        self.assertEqual(r.c["res_manual"], 1)
        self.assertEqual(r.c["net_total"], 2)
        self.assertEqual(r.c["net_no_timeout"], 1)
        self.assertEqual(r.c["risky_covered"], 2)  # try/except + `with open`
        self.assertIn("unclosed_resource", kinds(r))
        self.assertIn("network_no_timeout", kinds(r))

    def test_validation_and_custom_exceptions(self):
        r = analyze("python", "m.py", '''
            class AppError(Exception):
                pass

            class ConfigError(AppError):
                pass

            def validated(a, b):
                if not isinstance(a, int):
                    raise ConfigError("a")
                x = a + b
                y = x * 2
                return y

            def unvalidated(a, b):
                x = a + b
                y = x * 2
                z = y - 1
                return z
        ''')
        self.assertEqual(r.c["funcs_public"], 2)
        self.assertEqual(r.c["funcs_validated"], 1)
        custom, children = resolve_custom_exceptions([(n, b, "m.py") for n, b in r.classes])
        self.assertEqual(set(custom), {"AppError", "ConfigError"})
        self.assertEqual(children, {"ConfigError"})
        self.assertIn("ConfigError", r.used_names)

    def test_syntax_error_is_not_fatal(self):
        r = analyze("python", "old.py", 'print "hello"\n')
        self.assertEqual(r.parse_mode, "failed")

    def test_try_in_caller_does_not_cover_nested_function(self):
        r = analyze("python", "m.py", '''
            import json
            def outer(s):
                try:
                    def inner():
                        return json.loads(s)
                    return inner
                except ValueError:
                    return None
        ''')
        self.assertEqual(r.c["risky_total"], 1)
        self.assertEqual(r.c["risky_covered"], 0)


class OtherLanguagesTest(unittest.TestCase):
    def test_javascript(self):
        r = analyze("javascript", "a.js", """
            async function load(p) {
              try {
                const d = JSON.parse(await fs.promises.readFile(p));
                return d;
              } catch (err) {
                console.error("failed", err);
                throw new Error("load failed", { cause: err });
              }
            }
            function quiet() {
              try { risky(); } catch (e) { }
            }
            function net() { return fetch("http://x"); }
            fetch("http://y").catch(() => {});
            class AppError extends Error {}
        """)
        self.assertEqual(r.c["handlers"], 3)          # 2 catch + 1 .catch
        self.assertEqual(r.c["h_silent"], 2)
        self.assertEqual(r.c["h_new_chained"], 1)
        self.assertEqual(r.c["net_no_timeout"], 2)
        self.assertEqual(r.classes, [("AppError", ("Error",))])

    def test_java(self):
        r = analyze("java", "src/A.java", """
            package a;
            public class A {
                public void run(String p) throws IOException {
                    Files.readAllLines(null);
                }
                public int parse(String s) {
                    try (BufferedReader r = new BufferedReader(new FileReader(s))) {
                        return Integer.parseInt(r.readLine());
                    } catch (NumberFormatException e) {
                        throw new AppException("bad", e);
                    } catch (Exception e) {
                        e.printStackTrace();
                    } finally {
                        cleanup();
                    }
                    return 0;
                }
            }
            class AppException extends RuntimeException {}
        """)
        self.assertEqual(r.c["handlers"], 2)
        self.assertEqual(r.c["h_specific"], 1)
        self.assertEqual(r.c["h_broad"], 1)
        self.assertEqual(r.c["h_new_chained"], 1)
        self.assertEqual(r.c["tries_finally"], 1)
        self.assertEqual(r.c["with_stmts"], 1)
        self.assertEqual(r.c["risky_covered"], r.c["risky_total"])  # throws + try-with-resources

    def test_go(self):
        r = analyze("go", "a.go", """
            package a
            import ("os"; "fmt")
            var ErrNope = errors.New("nope")
            func Read(p string) error {
                f, err := os.Open(p)
                if err != nil {
                    return fmt.Errorf("open: %w", err)
                }
                defer f.Close()
                _ = os.Remove(p)
                return nil
            }
            func Bad(p string) {
                g, err := os.Open(p)
                if err != nil {
                }
                _ = g
            }
        """)
        self.assertEqual(r.c["handlers"], 3)         # 2 if-err + 1 ignored
        self.assertEqual(r.c["h_new_chained"], 1)
        self.assertEqual(r.c["res_with"], 1)
        self.assertEqual(r.c["res_unmanaged"], 1)
        self.assertIn("ignored_error", kinds(r))
        self.assertEqual(r.classes, [("ErrNope", ("Error",))])


class ScoringTest(unittest.TestCase):
    def _score(self, code: str):
        r = analyze("python", "m.py", code)
        r.loc = max(r.loc, 600)
        return score_categories(Aggregate.build([r]))

    def test_good_beats_bad(self):
        bad = "\n".join(f"def f{i}():\n    try:\n        x()\n    except:\n        pass\n" for i in range(6))
        good = "\n".join(
            f"def f{i}():\n    try:\n        x()\n    except ValueError as e:\n        log.error('x %s', e)\n        raise\n"
            for i in range(6))
        sb = self._score(bad)["exception_specificity"].score
        sg = self._score(good)["exception_specificity"].score
        self.assertLess(sb, 0.1)
        self.assertGreater(sg, 0.9)
        self.assertLess(self._score(bad)["handler_quality"].score, 0.1)

    def test_insufficient_data_is_none(self):
        cats = self._score("x = 1\n")
        self.assertIsNone(cats["exception_specificity"].score)


class ScannerTest(unittest.TestCase):
    def test_skips_and_unsupported(self):
        with tempfile.TemporaryDirectory() as tmp:
            for rel, body in {
                "src/a.py": "x=1\n", "tests/test_a.py": "x=1\n", "node_modules/x.js": "x\n",
                "lib/a.rb": "puts 1\n", "build/b.py": "x=1\n",
            }.items():
                p = os.path.join(tmp, *rel.split("/"))
                os.makedirs(os.path.dirname(p), exist_ok=True)
                with open(p, "w") as fh:
                    fh.write(body)
            scan = scan_repository(tmp, None, 10_000)
        self.assertEqual({e.rel_path for e in scan.entries}, {"src/a.py", "tests/test_a.py"})
        self.assertTrue(next(e for e in scan.entries if "test_a" in e.rel_path).is_test)
        self.assertEqual(scan.unsupported["Ruby"], 1)


@unittest.skipUnless(shutil.which("git"), "git not installed")
class EndToEndTest(unittest.TestCase):
    ENV = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t", GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t")

    def _repo(self, parent, files):
        origin = os.path.join(parent, "origin")
        os.makedirs(origin)
        for rel, body in files.items():
            p = os.path.join(origin, *rel.split("/"))
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, "w") as fh:
                fh.write(body)
        for cmd in (["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "i", "--allow-empty"]):
            subprocess.run(["git", *cmd], cwd=origin, check=True, env=self.ENV, capture_output=True)
        return origin

    def test_clone_report_and_cleanup(self):
        created, real = [], tempfile.mkdtemp

        def spy(*a, **k):
            d = real(*a, **k)
            created.append(d)
            return d

        code = "\n".join(
            f"def f{i}(a, b):\n    if a is None:\n        raise ValueError('a')\n    try:\n        return open(a).read()\n"
            f"    except OSError as e:\n        raise RuntimeError('x') from e\n" for i in range(6))
        with tempfile.TemporaryDirectory() as parent:
            origin = self._repo(parent, {"pkg/m.py": code})
            tempfile.mkdtemp = spy
            try:
                res = run("o/r", Options(progress=False), clone_url_override="file://" + origin)
            finally:
                tempfile.mkdtemp = real
        self.assertTrue(res.cleanup_ok)
        self.assertEqual(len(created), 1)
        self.assertFalse(os.path.exists(created[0]))
        rep = res.report
        self.assertIsNotNone(rep["final_score"]["score"])
        for key in ("summary", "categories", "highlights", "issues", "repository", "warnings"):
            self.assertIn(key, rep)
        self.assertEqual(len(rep["repository"]["commit"]), 40)
        json.dumps(rep)

    def test_empty_and_unsupported_repos(self):
        with tempfile.TemporaryDirectory() as parent:
            origin = self._repo(parent, {"README.md": "hi\n"})
            with self.assertRaises(NoSourceFilesError):
                run(origin, Options(progress=False))
        with tempfile.TemporaryDirectory() as parent:
            origin = self._repo(parent, {"a.rb": "puts 1\n"})
            with self.assertRaises(NoSourceFilesError) as cm:
                run(origin, Options(progress=False))
            self.assertIn("Ruby", str(cm.exception))

    def test_cli_exit_codes(self):
        script = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "error_handling_scorer.py")
        with tempfile.TemporaryDirectory() as parent:
            origin = self._repo(parent, {"a.py": "def f(x):\n    try:\n        return int(x)\n    except ValueError:\n        return 0\n"})
            out = os.path.join(parent, "o.json")
            ok = subprocess.run([sys.executable, script, origin, "-o", out, "-q"], capture_output=True, text=True)
            self.assertEqual(ok.returncode, 0, ok.stderr)
            self.assertTrue(os.path.exists(out))
            bad = subprocess.run([sys.executable, script, "https://gitlab.com/a/b", "-o", out, "-q"], capture_output=True, text=True)
            self.assertEqual(bad.returncode, 3)


if __name__ == "__main__":
    unittest.main()
