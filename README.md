# Release Review

Release Review verifies a camera and lens reservation desk in real Chrome before granting a release approval. It connects Kane CLI's browser verdicts and evidence to the exact policy and code revision being reviewed.

## Run locally

Use Node 22.13 or newer, Chrome, and `unzip` on your path. The application listens on loopback and uses local SQLite files with fictional demo users.

```sh
npm ci
npm run dev
```

Open <http://127.0.0.1:4173>. **Reservation desk** opens the booking UI. **Open scenario** starts an independent browser session with known starting data. The board's **0 minutes** and **30 minutes** choices set the camera inspection policy for new desk sessions and update open desks.

```sh
npm install -g @testmuai/kane-cli@0.10.9
kane-cli login --oauth
npm run verify:kane
```

The server should stay running. For a single scenario, use `npm run verify:kane -- 9`. For an alternate server port, set `RELEASE_REVIEW_URL` for the verification command and `PORT` for the server. The board keeps the final verdict, browser screenshot, observed browser values, database comparison, and diagnostic records locally in `.local/verification`. Separate Chrome profiles and SQLite databases let the runner check two scenarios at a time. Set `KANE_WORKERS=1` when running on a low-memory machine.

```sh
npm test
```

This is the deterministic Chrome regression suite. It runs separately from the live Kane CLI suite and checks the exact visible outcomes for all 12 browser scenarios.

## What the checks cover

| Case | Check |
| --- | --- |
| 1 | A restore conflict displays the error and preserves the replacement reservation. |
| 2 | A live inspection-policy update affects time options and overlapping edits keep the saved slot. |
| 3 | A freed slot allows a restore with the original booking ID. |
| 4 | Kit promotion is all-or-nothing, and the reservation and inventory views agree. |
| 5 | Two competing requests create one confirmation and one waitlist entry. |
| 6 | Parallel replays return the same booking ID; a reused key with changed input returns 409. |
| 7 | A post-commit connection loss can be retried even after the booking has been promoted. |
| 8 | Both cancellation and promotion orders end with the same eligible owner. |
| 9 | An open confirmation keeps its booking ID when the waitlist moves. |
| 10 | A late response cannot overwrite a newer browser state. |
| 11 | Closing a reduced-motion notification restores pointer access. |
| 12 | The reservation owner keeps their booking and other demo users lack modification controls. |

The `defects` tag demonstrates deliberately seeded UI regressions in cases 1, 2, 4, 9, 10 and 11. The ownership check exercises the authorization boundary on both revisions. The server checks ownership before each change.

## From Kane evidence to a fix

The runner consumes Kane's NDJSON `run_end` result and checks the invariant verdict array from a second Kane call in the same Chrome session. Selected cases compare values extracted from the browser against SQLite. The board exposes the failure screenshot and local network evidence. A failed product check creates a local `codex.json` with the objective, available evidence, and relevant source paths for the next Codex prompt.

The release approval is local. It requires all 12 live results for the active policy and code fingerprint. Policy changes and new builds require fresh verification.
