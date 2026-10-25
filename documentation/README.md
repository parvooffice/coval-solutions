# Documentation Quality Scorer

A simple command-line Python tool that evaluates the documentation quality of a GitHub repository and produces a weighted score plus a detailed JSON report.

## Features

- Accepts any public GitHub repository URL
- Performs a shallow clone for speed
- Evaluates five dimensions:
  - **README** quality (presence, length, common sections)
  - **Docstring** coverage (Python AST analysis)
  - **Comment** density in source files
  - **docs/** folder richness
  - Supporting files (LICENSE, CONTRIBUTING, CHANGELOG, etc.)
- Outputs a single JSON file containing the overall score, breakdown, summary, highlights, and issues
- Pure CLI – no web UI or GUI required

## Requirements

- Python 3.8+
- `git` available in PATH

No third-party Python packages are required (uses only the standard library).

## Installation

```bash
# Clone or download this repository, then:
cd docs_quality_scorer
# Optional: make the script executable
chmod +x docs_scorer.py
```

## Usage

```bash
python docs_scorer.py https://github.com/owner/repo

# Custom output file
python docs_scorer.py https://github.com/psf/requests -o requests_docs_score.json

# Keep the temporary clone for inspection
python docs_scorer.py https://github.com/owner/repo --keep-clone

# Clone into a specific directory
python docs_scorer.py https://github.com/owner/repo --clone-dir /tmp/my-analysis
```

## Example Output

```
Analyzing documentation quality for: https://github.com/psf/requests
Cloning repository (shallow)...
Running analysis...

Score: 86.4/100
Summary: Overall documentation quality score: 86.4/100 (Excellent). ...

Highlights:
  + README is substantial (… characters).
  + Strong docstring coverage: …
  …

Issues:
  - …

Full report written to: /path/to/docs_quality_score.json
```

### JSON structure

```json
{
  "repo_url": "https://github.com/…",
  "repo_name": "…",
  "analyzed_at": "2026-…",
  "score": 86.4,
  "max_score": 100.0,
  "breakdown": {
    "readme": 92.0,
    "docstrings": 78.5,
    "comments": 85.0,
    "docs_folder": 90.0,
    "supporting_docs": 95.0
  },
  "summary": "…",
  "highlights": ["…"],
  "issues": ["…"],
  "details": { … }
}
```

## Scoring Weights

| Criterion          | Weight |
|--------------------|--------|
| README             | 30 %   |
| Docstrings         | 25 %   |
| Comments           | 15 %   |
| docs/ folder       | 15 %   |
| Supporting docs    | 15 %   |

Weights and heuristics can be adjusted in the source (`WEIGHTS` and the individual `score_*` functions).

## Limitations

- Optimized for Python projects (docstring analysis uses the `ast` module). Other languages still receive comment-density and README scoring.
- Shallow clone only – does not fetch full history.
- Large binary files and common ignore directories (`node_modules`, `.git`, etc.) are skipped.
- Heuristics are intentionally simple; they are not a substitute for human review.

## License

MIT
