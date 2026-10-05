# apps/worker

Analysis worker (M8 Integrity Engine): keystroke analytics, code similarity, voice activity wrapper,
risk score. Python 3.12. Standalone modules; the job consumer and storage hand-off arrive with
Backend Steps 10 and 12. Thresholds and known limits: INTEGRITY-CONFIG.md.

```sh
python3.12 -m venv .venv && .venv/bin/pip install -e '.[dev]'
.venv/bin/ruff check src tests && .venv/bin/mypy src tests && .venv/bin/pytest
```

`tests/test_contracts.py` parses packages/shared so the Python mirror in `src/worker/events.py`
fails the build if events.ts, keystroke.ts or code-run.ts drift. Never log request bodies: they hold
candidate code.
