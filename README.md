# qa-watch-loop

**Give your AI agent eyes on its own work: record the app on video, let the agent watch the tape, get a verdict backed by real visual evidence.**

Most AI coding agents verify their work with type checks and test suites — and then ship features that are green in CI and dead on screen. This loop closes that gap:

```
┌──────────────┐     ┌──────────────┐     ┌──────────────────┐
│ 1. RECORD     │ →  │ 2. WATCH      │ →  │ 3. VERDICT        │
│ agent-browser │     │ video-vision  │     │ timestamped       │
│ drives the app│     │ frame-by-frame│     │ scorecard w/ tape │
│ to a .webm    │     │ AI watch      │     │ evidence          │
└──────────────┘     └──────────────┘     └──────────────────┘
```

The agent doesn't ask a human "does it look right?" — it drives the flow, records a WebM, extracts and reads the frames itself, and writes a verdict where every claim carries a timestamp you can scrub to.

## Why this makes agents genuinely more autonomous

Real catches from the first three runs of this loop (two projects, one day):

1. **A feature that was a silent no-op.** A scroll-discovery feature shipped with a clean typecheck and a 25/25 test suite. The tape showed *zero scrolling across 100 frames* — a stale page-height snapshot made the loop exit instantly, and error-swallowing `catch {}` blocks hid it. No test caught it. The video did.
2. **A stray dropdown occluding the UI for 45+ seconds.** A cursor glide across a hover-nav opened a menu nothing ever closed. Invisible to unit tests by construction; obvious on tape.
3. **A cookie-consent modal covering an entire session.** The consent auto-dismiss heuristic simply never detected one modal class — every downstream screen played behind it. The tape made the failure (and its exact start timestamp) undeniable.

Pattern: **the tape is the falsification test for "it works."** Tests verify logic; the tape verifies the experience.

## Requirements

- [`agent-browser`](https://github.com/vercel-labs/agent-browser) CLI (drives the browser + records WebM)
- An AI agent runtime that can read video. This loop's WATCH phase uses
  [**claude-video-vision** by jordanrendric](https://github.com/jordanrendric/claude-video-vision) —
  the OG "give Claude eyes on video" Claude Code plugin (`video_info` / `video_watch` / `video_detail`),
  which deserves the credit for making the watch half possible. Our own companion tool
  [`video-vision-cli`](https://github.com/Hammaarn/video-vision-cli) (token-efficient pre-pass:
  audio-first + selective frame drill) pairs well with it for long recordings.
- Node 18+

## Quickstart

```bash
# 1. RECORD — drive a flow while recording
node scripts/record-loop.mjs --url http://localhost:3000 --out ./qa-run.webm --viewport 1280x900 --wait 120

# or drive interactively: start recording, do your agent-browser steps, stop
node scripts/record-loop.mjs --url http://localhost:3000 --out ./qa-run.webm --manual

# 2. WATCH — the agent reads the tape (see SKILL.md for the exact method)
#    video_info → sampled watch (20-30 frames) → targeted high-res detail frames

# 3. VERDICT — fill templates/QA-WATCH-REPORT.md with timestamped findings
```

## The method (short version — full discipline in [SKILL.md](SKILL.md))

1. **Record with intent.** Know the checklist BEFORE recording: which features/fixes is this tape supposed to falsify? A recording without a checklist becomes "looks fine" — the smell, not the proof.
2. **Set the viewport BEFORE starting the recording.** The recording canvas is fixed at start; resizing afterwards changes the page, not the tape. (Learned the hard way — twice.)
3. **Watch cheap, then zoom.** Metadata first, then a sampled pass (20–30 evenly spaced frames), then high-resolution detail frames only at the moments that matter. Don't extract 200 full-res frames of a loading spinner.
4. **Verdict with timestamps.** Every PASS/FAIL cites the frame time. Every unjudgeable item is declared unjudgeable (crop, resolution, not-exercised) — a permit-null verdict beats a fake pass.
5. **A green suite + a dead screen = the tape wins.** File the bug with the timestamp.

## Repo layout

```
scripts/record-loop.mjs     # the recording arm (browser hygiene built in)
SKILL.md                    # the watch + verdict discipline (agent-facing)
templates/QA-WATCH-REPORT.md# the verdict scorecard template
```

## License

MIT
