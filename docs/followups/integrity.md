# Follow-ups: Integrity track

## From ARC-02 review of PR #16 (code-reviewer)

- **[BE-12 / worker, FR-802] RESET can bypass paste-burst detection.** A client can send a RESET whose text is a finished solution ("restore after reload") and typing-speed or paste-burst analytics will not see it. The worker or API should compare RESET text with server-known state (starter code or the last saved draft) and, on a mismatch, emit evidence (PASTE_BURST or a new signal), never a verdict automatically.
