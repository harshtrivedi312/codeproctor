"""INT-01 offline tooling for face-match threshold tuning (FR-403, D-05, C-11, C-12).

Offline only: nothing here runs in the API or the worker service. It handles scores, never
embeddings, and never writes photos or demographic data into the repository.
"""
