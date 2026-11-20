import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import test_coverage_scorer as scorer  # noqa: E402

SOURCE = "def total(items):\n    result = 0\n    for item in items:\n        result += item\n    return result\n"


def write(root: Path, files: dict) -> None:
    for name, text in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")


class TestCoverageTests(unittest.TestCase):
    def analyze(self, files):
        with tempfile.TemporaryDirectory() as directory:
            write(Path(directory), files)
            return scorer.analyze_repository(Path(directory))

    def test_untested_repository_scores_low(self):
        report = self.analyze({"app/billing.py": SOURCE, "app/orders.py": SOURCE})
        self.assertLessEqual(report["final_score"]["score"], 15)
        self.assertEqual(len(report["untested_modules"]), 2)

    def test_tested_repository_scores_high(self):
        test = "from app.billing import total\n\ndef test_total():\n    assert total([1, 2]) == 3\n    assert total([]) == 0\n" * 2
        report = self.analyze({
            "app/billing.py": SOURCE,
            "tests/test_billing.py": test,
            "pyproject.toml": "[tool.pytest.ini_options]\naddopts = \"--cov=app --cov-fail-under=80\"\n",
            ".github/workflows/ci.yml": "jobs:\n  test:\n    steps:\n      - run: pytest\n",
        })
        self.assertGreaterEqual(report["final_score"]["score"], 85)
        self.assertEqual(report["categories"]["module_coverage"]["score"], 100)
        self.assertEqual(report["categories"]["test_infrastructure"]["score"], 100)

    def test_javascript_imports_count_as_coverage(self):
        report = self.analyze({
            "src/cart.js": "export function add(a, b) {\n  return a + b;\n}\nexport const x = 1;\nexport const y = 2;\n",
            "src/cart.test.js": "import { add } from './cart';\ntest('adds', () => {\n  expect(add(1, 2)).toBe(3);\n});\n",
            "package.json": json.dumps({"scripts": {"test": "vitest run --coverage"}}),
        })
        self.assertEqual(report["stats"]["test_files"], 1)
        self.assertEqual(report["categories"]["module_coverage"]["score"], 100)
        self.assertGreater(report["categories"]["coverage_tooling"]["score"], 0)

    def test_empty_repository_is_rejected(self):
        with self.assertRaises(ValueError):
            self.analyze({"README.md": "# docs"})


if __name__ == "__main__":
    unittest.main()
