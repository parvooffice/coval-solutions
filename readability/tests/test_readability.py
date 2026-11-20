import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import readability_scorer as scorer  # noqa: E402

CLEAN_PY = '''
def add_numbers(first, second):
    """Return the sum."""
    return first + second


def describe(value):
    if value > 10:
        return "large"
    return "small"
'''

TANGLED_JS = "function process(a, b) {\n" + "".join(
    f"  if (a > {i}) {{\n    for (const q of b) {{\n      if (q && a || b) {{\n        while (a) {{\n          if (q) {{ a--; }}\n        }}\n      }}\n    }}\n  }}\n"
    for i in range(12)
) + "}\n"


class ReadabilityTests(unittest.TestCase):
    def score(self, files):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name, text in files.items():
                (root / name).write_text(text, encoding="utf-8")
            return scorer.analyze_repository(root)

    def test_clean_code_scores_high(self):
        report = self.score({"clean.py": CLEAN_PY})
        self.assertGreaterEqual(report["final_score"]["score"], 85)
        self.assertEqual(report["stats"]["functions"], 2)

    def test_tangled_code_scores_lower(self):
        clean = self.score({"clean.py": CLEAN_PY})["final_score"]["score"]
        tangled = self.score({"tangled.js": TANGLED_JS})
        self.assertLess(tangled["final_score"]["score"], clean)
        function = tangled["hotspots"][0]
        self.assertGreaterEqual(function["nesting"], 4)
        self.assertGreater(function["complexity"], 12)

    def test_braces_in_strings_are_ignored(self):
        functions, _ = scorer.analyze_brace_language('function a() {\n  const s = "{{{";\n  return s;\n}\n')
        self.assertEqual(len(functions), 1)
        self.assertEqual(functions[0]["length"], 4)

    def test_empty_repository_is_rejected(self):
        with self.assertRaises(ValueError):
            self.score({"README.md": "# docs"})


if __name__ == "__main__":
    unittest.main()
