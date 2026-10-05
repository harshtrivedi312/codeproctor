# Follow-ups: Integrity track

## From ARC-02 review of PR #16 (code-reviewer)

- **[BE-12 / worker, FR-802] RESET can bypass paste-burst detection.** A client can send a RESET whose text is a finished solution ("restore after reload") and typing-speed or paste-burst analytics will not see it. The worker or API should compare RESET text with server-known state (starter code or the last saved draft) and, on a mismatch, emit evidence (PASTE_BURST or a new signal), never a verdict automatically.

## From ARC-02 review of PR #19 (code-reviewer)

- **[BE-10, security, must do in BE-10] Body limit on POST /candidate/session/keystrokes.** Set a per-route limit of `MAX_KEYSTROKE_BATCH_BODY_BYTES` (2 MiB; the NestJS/Express default of 100 KB would reject valid large batches). Apply it before the HMAC check and before parsing, measure the decompressed size (backend.md Step 10 allows HTTP compression; a zip bomb must not get past it), and add a test for the 413 response. Same for the events route (`MAX_EVENT_BATCH_BODY_BYTES`).
