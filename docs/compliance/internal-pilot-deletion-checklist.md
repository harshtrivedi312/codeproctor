# Internal pilot: checks before the trial, and the deletion checklist

Prepared 2026-10-09 by the compliance reviewer (D-84). For the person running the trial (the owner). This is an operational checklist for a trial on the owner's own machine, not legal advice from a licensed lawyer. The consent text is [internal-pilot-consent.md](internal-pilot-consent.md); the volunteer briefing is [internal-pilot-briefing.md](internal-pilot-briefing.md).

## A. Before anyone signs (the consent must be true)

The consent says things about the system that must be true on the trial day. Please confirm each one; if any is false, either fix the machine or change the consent text before loading it.

1. **Contact and names are filled in.** The consent has three bracketed fill-ins: other reviewers, if any (section 4), and the contact email (sections 6 and 7). The text contains square brackets until they are filled in, which makes the candidate flow refuse to show it. That is deliberate.
2. **Everything stays on this machine.** The local stack uses Postgres, Redis and MinIO in Docker, with mail caught by Mailpit. Confirm that nothing sends candidate data out: the API does not point at a real S3 or SES; no error tracker is configured; browser downloads of models come from the local site. If any external service is configured, remove it or name it in section 5.
3. **No backups.** Docker volumes are not backed up by the stack, but the computer might be: check that Time Machine, iCloud Drive or Desktop sync, or any other backup or sync tool does **not** include the Docker data directory, the MinIO data, or any exported files. Switch it off or exclude it. The `codeproctor-backup` bucket in MinIO is for the database dump script; do not run it for the trial, or delete it afterwards (step C4).
4. **The screen is not shared with other tools.** No screen-recording or remote-support tool runs on the machine; no assistant tool is given the recordings.
5. **Who can see it.** The staff accounts that can open recordings are only the named reviewers. The seeded demo accounts (admin, recruiter, author, reviewer) share one known password, so either remove them from the trial database or change that password, or add the people who can use them to section 4.
6. **Disk encryption.** FileVault (or the equivalent) is on. The consent does not promise it, but biometric data on an unencrypted laptop is a risk worth removing.
7. **The capture the consent describes is the capture that runs.** Per the QA build facts: the detectors that run are browser events (focus, full-screen, paste, screen share), recording of screen, webcam and audio, and keystrokes; the in-browser face, gaze and object detectors are placeholders that report "unavailable", and face matching is off unless the owner approves the model download, in which case identity goes to manual review. The consent says exactly this. If the owner turns face matching on, or a detector or extra capture (a second camera, a room scan) starts to run, update section 2 first.
8. **The consent record.** Section 5 says the signed consent record is kept for 3 years, consistent with C-04 and C-17. If you prefer that everything, including the consent record, is deleted within 30 days (nothing is kept longer), delete that sentence and the matching line in the briefing. That is the owner's choice.
9. **Declining.** The consent offers only "decline the whole trial", because no identity waiver or video-call alternative is built. Do not promise one.
10. **Age.** Volunteers must be 18 or older. The consent asks for this by a statement in the signature, not by a separate tick box; add the 18+ tick box if the build has it (C-30).

## B. During the trial

- Run it on one machine, one volunteer at a time, in a quiet room.
- Keep a simple log: volunteer code (not name), date and time, what went wrong. Do not put names, face descriptions or recording content in the log.
- If a volunteer asks to stop or withdraw, stop at once; do the withdrawal deletion (C3) within 7 days.
- Do not copy recordings or photos off the machine, and do not screenshot them into chat, a document or a ticket.

## C. Deletion checklist (no later than 9 November 2026, sooner if the trial is done)

Do these in order, and write the date and who did it at the end.

1. **Finish the trial.** Confirm every volunteer's test has ended and uploads have finished.
2. **Delete the object storage.** In MinIO, empty and delete the media bucket (`codeproctor-media`) and, if it was used, the backup bucket (`codeproctor-backup`). Remember MinIO is versioned only if you turned it on; if it is, remove the versions too.
3. **Delete withdrawn volunteers first** (within 7 days of any request), then everyone else: delete their ID images, selfies, recordings and snapshots from MinIO.
4. **Delete the database.** Use the repository's own reset path, run by the owner (agents never run it; ADR 0009): `pnpm dev:infra:reset` (this drops the Docker volumes for Postgres, Redis and MinIO). Do not use a different tool to delete only some rows; a reset is simpler and leaves nothing behind.
5. **Check the disk.** Search the machine for leftover files: the `.demo/` folder (logs), Docker volumes (`docker volume ls`), Downloads, the Desktop, and the browser's downloads and cache. Delete any recording or image.
6. **Check mail.** Mailpit holds the volunteers' emails and codes. Delete all messages (`DELETE` on the Mailpit UI, or remove the Mailpit volume).
7. **Check backups again.** Time Machine, iCloud and other copies made after step A3 must not hold any of it. If any did, delete those copies too.
8. **Check logs.** Application logs under `.demo/` and Docker logs may contain IP addresses and session references. Delete them.
9. **Keep only** the signed consent records (if the owner chose to, A8), and the trial log from section B. Store the consent records somewhere private, not in the repository.
10. **Confirm to the volunteers.** Send each volunteer a one-line message: "Your trial data was deleted on [date]." Do not attach anything.
11. **Record it.** Write the date, who did it, and what was deleted in the trial log. The Delivery Lead can note it in `docs/status.md`.

## D. If something goes wrong

- A recording or image was seen by someone not named in section 4, or copied somewhere it should not be: tell the affected volunteers within 72 hours, delete the copies, and tell the compliance reviewer.
- A volunteer's device or the trial machine was lost or stolen: tell the affected volunteers at once and delete what you can reach.
- A volunteer later asks to see or correct their data: show it to them on the machine, or after deletion, tell them what was held and when it was deleted.

## E. What this trial does not cover

It is not a pilot with candidates, and it does not replace the consent v0.5, retention schedule, privacy notice and DPIA for the real pilot (#353, #354, #355, #370). Do not reuse this consent text for candidates.
