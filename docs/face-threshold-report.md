# Face-match threshold report (INT-01)

Status: **TEMPLATE. No real data yet.** The volunteer collection has not started (needs the owner-approved form, C-11). Nothing in this file may be used to set the threshold until the tuning run replaces it.

Generate the real report from the volunteer scores, kept outside the repository:

```bash
cd apps/worker && python -m tools.int01.evaluate --scores ~/tuning/scores.csv --demographics ~/tuning/demographics.json --target-fmr 0.001 --out ~/tuning/report.md
```

Then copy the report here (totals and percentages only; no subject codes, no photos). `--synthetic` produces a layout preview marked SYNTHETIC.

The report contains: the data description and model pin (AuraFace `glintr100.onnx`, ADR 0001 section 12); the recommended threshold with its false-match rate and expected manual-review rate (95% upper bounds); the rates across thresholds; per-group results on the volunteers' explicit consent (C-12), with groups under 10 volunteers suppressed; and the sign-off list (owner accepts, threshold set in system configuration, demographic data deleted and the deletion recorded).
