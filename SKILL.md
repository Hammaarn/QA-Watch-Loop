---
name: qa-watch-loop
description: Record the running app to video with agent-browser, watch the tape frame-by-frame with video-vision, and produce a timestamped QA verdict. Use after shipping UI/motion/flow changes, when tests are green but the experience is unverified, or when a human reports "it looks wrong" and you need evidence.
---

# QA Watch Loop — the discipline

You are about to verify a change by **watching it**, not by trusting tests. The tape is the
falsification instrument: every claim in your verdict must carry a timestamp, and "unjudgeable"
is a legitimate verdict.

## Phase 0 — the checklist comes first, and it is a FILE

Write down WHAT this tape must prove or falsify before recording anything. One item per claim:
what it asserts, and what would disprove it.
No checklist → you will watch the tape and conclude "looks fine." That is the smell, not the proof.

Write it as `checklists/<name>.json` and the loop resolves it for you (`--checklist`, or
`check-checklist.mjs` against an existing tape). Prose works, but a file gets you three things
prose cannot:

- **`falsifiedBy` is mandatory** — an item without one is rejected at load. If you cannot say what
  would disprove a claim, you have written a hope, not a checklist item.
- **The machine decides what it actually can**, and says UNJUDGEABLE for everything else *with the
  timestamp to look at*. It resolves `chapter` (did the run REACH this moment, and by when),
  `noConsoleError` / `noPageError` / `noFailedRequest`. Anything visual, or living in a server log,
  is `manual` — permanently unjudgeable here, and pointed at its channel via `judgeBy`.
- **Guards cascade.** An item can `dependsOn` an earlier one. If the guard did not pass, the
  dependent goes UNJUDGEABLE, never FAIL — a claim that was never exercised is untested, not false,
  and recording it as a failure is exactly as wrong as recording it as a pass.

Two invariants the resolver will not let you break:

1. **It never invents a PASS.** A `manual` item cannot drift into PASS no matter how clean the run.
2. **An unread channel is not an empty one.** If evidence collection failed, every absence-based
   item is withheld as UNJUDGEABLE rather than passed. (This is the false-clean bug that once
   reported an unreadable channel as a clean one, promoted into a rule.)

`node scripts/check-checklist.mjs --selftest` proves all of that still holds.

## Phase 1 — record

Use `scripts/record-loop.mjs`, or drive agent-browser yourself:

1. `agent-browser open <url>` — navigate FIRST.
2. Set the viewport BEFORE recording: `agent-browser set viewport <w> <h>`. The recording canvas
   is fixed at `record start`; resizing later changes the page, not the tape. Make the viewport
   tall enough to include every UI zone on your checklist (status bars, toasts, bubbles at the
   bottom edge — cropped zones become unjudgeable items).
3. `agent-browser record start <path.webm>` (no URL — it records the current page; passing a URL
   here creates a fresh context and can drop your viewport).
4. Drive the flow under test (`snapshot` → refs → `click`/`fill`) — **AFTER `record start`, and
   re-do any page state from scratch**: `record start` spawns a fresh context that reloads the
   page, silently wiping form fills and client state you set beforehand. A pre-filled form +
   post-start click on a now-disabled button = a 0.4-second recording of a static page (learned
   the hard way). For long async phases, poll a completion marker — do not guess durations.
5. `agent-browser record stop` then ALWAYS `agent-browser close --all` (also on failure — wrap in
   a finally/trap). One browser instance per loop; never leave zombies.

## Phase 2 — watch (cheap → targeted)

0. **Read the evidence sidecar FIRST — it is free.** `record-loop` writes
   `<tape>.evidence.json` beside the video and prints a summary when it finishes.
   It carries console errors, page errors (uncaught exceptions + unhandled
   rejections), failed requests, and **chapters** — timestamped jump-points.

   Why before the frames: a model watching pixels is blind to this entire class.
   A console error is invisible on video, a 404 for a background asset is
   invisible, and a feature that silently emits nothing looks identical to one
   that works. The sidecar costs no tokens and answers "did anything break?"
   before you spend anything answering "how did it look?".

   Use the chapters to aim Phase 2's targeted pass — `+168s until-matched` tells
   you exactly where the thing you were waiting for arrived, instead of guessing
   at a five-minute tape.

   **Evidence is reported, never enforced.** A console error is a fact to weigh,
   not an automatic FAIL — plenty of pages log errors that do not matter. You
   decide; the sidecar only makes sure you decide knowing.

   For `--manual` runs, nothing is sampling while you drive, so run
   `node scripts/collect-evidence.mjs --out <tape>` BEFORE `close --all`. That is
   a post-hoc drain: it tells you WHAT happened, not WHEN.

1. `video_info` — duration/resolution first. If a checklist zone is outside the recorded frame,
   mark those items UNJUDGEABLE now, don't pretend later.
2. Sampled pass: `video_watch` with `view_sample` 20–30 frames (evenly spaced) — build the
   timeline: phases, transitions, anomalies. For videos > ~2 min never extract every frame.
3. Targeted pass: `video_detail` with full-resolution segments ONLY at the moments that matter
   (the fix's expected effect, any anomaly from the sampled pass, text you must read).
4. While watching, hunt for what you did NOT expect: stuck overlays, layout jumps, dead time,
   error states. The loop's best catches are the bugs nobody listed.

## Phase 3 — verdict

If you ran with `--checklist`, the mechanical half is already done: `<tape>.verdict.md` holds the
table, and the exit code is 1 only if a machine-checkable claim came back FALSE. **UNJUDGEABLE items
are now your entire job** — the run is not verified until you judge them, and the verdict's
**Judge by** column says where to look. Do not let a green exit code read as a verified run; it
means nothing measurable broke, not that the feature works.

Then fill `templates/QA-WATCH-REPORT.md`. Rules:

- Every PASS/FAIL cites frame timestamps.
- **PASS requires the positive evidence on screen** — absence of a failure is not a pass if the
  feature's effect was never visible (that's NOT EXERCISED / permit-null).
- A FAIL includes the failure's first timestamp and, where visible, the mechanism hypothesis.
- Items the recording cannot judge (crop, resolution, not exercised by this flow) are declared
  UNJUDGEABLE with the reason and what a follow-up loop needs (taller viewport, different
  target site, different flow).
- If the tape contradicts a green test suite, **the tape wins** — file the bug, quote the
  timestamp, and say plainly that the tests missed it.

## Phase 4 — leave no trace

The loop spawns real browser processes; the loop is not DONE until the machine is clean.
After `record stop` + `agent-browser close --all`, run:

```bash
node scripts/sweep-check.mjs   # exit 0 = clean, exit 1 = lingering browser instances listed
```

Agents orphan processes more often than humans do — a crashed drive step or an impatient exit
leaves headless browsers (or worse, full-disk scans) running with no consumer. Strict rule:
**every completed loop ends with a sweep, and a kill is only claimed after re-querying that it
landed.** If your agent runtime spawns other helpers (search tools, servers), sweep those too —
scoped to what THIS loop started; report-first, kill deliberately.

## Known limits (state them in every report)

- Desktop-width recording overstates zoom-out vs mobile; mobile framing needs its own loop.
- The recording shows the viewport only — background tabs, console, and network are invisible;
  pair the tape with server logs when the failure could be non-visual.
- Frame sampling can miss sub-second events; if a checklist item is a fast animation, use a
  high-fps `video_detail` segment on that moment specifically.
- **The checklist resolver sees browser-side evidence only.** Server logs, database rows and
  deploy-platform output are outside its reach, so claims that live there are `manual` with a
  `judgeBy` pointer — never machine-decided. On a real run this was half the claims, and the
  resolver's job was to prove the run had EXERCISED them, which is the half that used to be assumed.
