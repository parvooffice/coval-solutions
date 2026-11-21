"""Tests for the Performance, Maintainability, Scalability, and Standards compliance agents."""

import json
import runpy
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def load(agent: str):
    return runpy.run_path(str(ROOT / agent / f"{agent}_scorer.py"))["analyze_repository"]


def make_repo(files: dict) -> tempfile.TemporaryDirectory:
    directory = tempfile.TemporaryDirectory()
    for name, text in files.items():
        path = Path(directory.name) / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    return directory


CLEAN_JS = "export function add(first, second) {\n  return first + second;\n}\n\nexport function label(name) {\n  return `Hello ${name}`;\n}\n"


class PerformanceTests(unittest.TestCase):
    def test_io_in_loop_is_flagged(self):
        slow = "async function load(ids) {\n  const out = [];\n  for (const id of ids) {\n    out.push(await fetch(`/items/${id}`));\n  }\n  return out;\n}\n"
        with make_repo({"src/slow.js": slow}) as clean_dir, make_repo({"src/ok.js": CLEAN_JS}) as ok_dir:
            slow_report = load("performance")(Path(clean_dir))
            ok_report = load("performance")(Path(ok_dir))
        self.assertLess(slow_report["categories"]["io_in_loops"]["score"], 50)
        self.assertEqual(slow_report["fixes"][0]["location"], "src/slow.js:4")
        self.assertEqual(ok_report["categories"]["io_in_loops"]["score"], 100)


class MaintainabilityTests(unittest.TestCase):
    def test_duplication_and_missing_lock_are_flagged(self):
        block = "".join(f"  const value{i} = compute({i}) * factor + offset;\n" for i in range(8))
        files = {
            "a.js": f"function first() {{\n{block}}}\n",
            "b.js": f"function second() {{\n{block}}}\n",
            "package.json": json.dumps({"dependencies": {"left-pad": "*"}}),
        }
        with make_repo(files) as directory:
            report = load("maintainability")(Path(directory))
        self.assertLess(report["categories"]["duplication"]["score"], 50)
        titles = {item["title"] for item in report["fixes"]}
        self.assertIn("Missing lock file", titles)
        self.assertIn("Wildcard dependency versions", titles)


class ScalabilityTests(unittest.TestCase):
    def test_timeouts_and_hardcoded_hosts(self):
        risky = "const API = 'http://localhost:4000';\nexport async function get() {\n  return fetch(API + '/data');\n}\n"
        safe = "const API = process.env.API_URL;\nexport async function get() {\n  return fetch(API, { signal: AbortSignal.timeout(5000) });\n}\n"
        with make_repo({"api/risky.js": risky}) as risky_dir, make_repo({"api/safe.js": safe}) as safe_dir:
            risky_report = load("scalability")(Path(risky_dir))
            safe_report = load("scalability")(Path(safe_dir))
        self.assertEqual(risky_report["categories"]["network_resilience"]["score"], 0)
        self.assertEqual(safe_report["categories"]["network_resilience"]["score"], 100)
        self.assertGreater(safe_report["categories"]["config_externalized"]["score"], risky_report["categories"]["config_externalized"]["score"])


class StandardsTests(unittest.TestCase):
    def test_tooling_and_docs_raise_score(self):
        bare = {"src/app.js": CLEAN_JS}
        complete = {
            **bare,
            "eslint.config.js": "export default [];\n",
            ".prettierrc": "{}\n",
            "README.md": "# App\n", "LICENSE": "MIT\n", "CONTRIBUTING.md": "How to help\n", "SECURITY.md": "Report privately\n",
            ".github/workflows/ci.yml": "jobs:\n  check:\n    steps:\n      - run: npm run lint\n      - run: npm test\n",
        }
        with make_repo(bare) as bare_dir, make_repo(complete) as complete_dir:
            bare_report = load("standards")(Path(bare_dir))
            complete_report = load("standards")(Path(complete_dir))
        self.assertLess(bare_report["final_score"]["score"], 30)
        self.assertGreater(complete_report["final_score"]["score"], 75)
        self.assertEqual(complete_report["categories"]["ci_quality_gates"]["score"], 100)


if __name__ == "__main__":
    unittest.main()


class IgnoreRulesTests(unittest.TestCase):
    def test_coval_yml_ignores_nested_folders_and_globs(self):
        kit = runpy.run_path(str(ROOT / "agent-kit" / "coval_agent_kit.py"))
        files = {".coval.yml": "ignore:\n  - legacy/\n  - '**/*.gen.js'\n", "legacy/a/deep/old.js": CLEAN_JS, "src/app.js": CLEAN_JS, "src/api.gen.js": CLEAN_JS}
        with make_repo(files) as directory:
            paths = list(kit["walk_files"](Path(directory)))
        self.assertIn("src/app.js", paths)
        self.assertNotIn("legacy/a/deep/old.js", paths)
        self.assertNotIn("src/api.gen.js", paths)
