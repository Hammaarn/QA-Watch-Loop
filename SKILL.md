---
name: qa-watch-loop
description: Record the running app to video with agent-browser, watch the tape frame-by-frame with video-vision, and produce a timestamped QA verdict. Use after shipping UI/motion/flow changes, when tests are green but the experience is unverified, or when a human reports "it looks wrong" and you need evidence.
---

# QA Watch Loop — the discipline

You are about to verify a change by **watching it**, not by trusting tests. The tape is the
falsification instrument: every claim in your verdict must carry a timestamp, and "unjudgeable"
is a legitimate verdict.

## Phase 0 — the checklist comes first

Write down WHAT this tape must prove or falsify before recording anything. One line per item:
the feature/fix, what visible behavior confirms it, what visible behavior falsifies it.
No checklist → you will watch the tape and conclude "looks fine." That is the smell, not the proof.

## Phase 1 — record

Use `scripts/record-loop.mjs`, or drive agent-browser yourself:

1. `agent-browser open <url>` — navigate FIRST.
2. Set the viewport BEFORE recording: `agent-browser set viewport <w> <h>`. The recording canvas
   is fixed at `record start`; resizing later changes the page, not the tape. Make the viewport
   tall enough to include every UI zone on your checklist (status bars, toasts, bubbles at the
   bottom edge — cropped zones become unjudgeable items).
3. `agent-browser record start <path.webm>` (no URL — it records the current page; passing a URL
   here creates a fresh context and can drop your viewport).
4. Drive the flow under test (`snapshot` → refs → `click`/`fill`). For long async phases, poll a
   completion marker in a loop — do not guess durations.
5. `agent-browser record stop` then ALWAYS `agent-browser close --all` (also on failure — wrap in
   a finally/trap). One browser instance per loop; never leave zombies.

## Phase 2 — watch (cheap → targeted)

1. `video_info` — duration/resolution first. If a checklist zone is outside the recorded frame,
   mark those items UNJUDGEABLE now, don't pretend later.
2. Sampled pass: `video_watch` with `view_sample` 20–30 frames (evenly spaced) — build the
   timeline: phases, transitions, anomalies. For videos > ~2 min never extract every frame.
3. Targeted pass: `video_detail` with full-resolution segments ONLY at the moments that matter
   (the fix's expected effect, any anomaly from the sampled pass, text you must read).
4. While watching, hunt for what you did NOT expect: stuck overlays, layout jumps, dead time,
   error states. The loop's best catches are the bugs nobody listed.

## Phase 3 — verdict

Fill `templates/QA-WATCH-REPORT.md`. Rules:

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
