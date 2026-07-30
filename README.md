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
# The whole loop, unattended, one command: a scripted flow drives the app, a
# checklist judges it, and stills land at every step it named.
node scripts/record-loop.mjs --url http://localhost:3000 --out ./qa-run.webm --shots \
  --flow flows/my-flow.json --checklist checklists/my-checklist.json

# Same flow on desktop AND a real emulated phone, compared across both
node scripts/record-loop.mjs --url http://localhost:3000 --out ./qa-run.webm --shots \
  --passes desktop,iphone-12 --flow flows/my-flow.json --checklist checklists/my-checklist.json

# Behind a login (credentials never enter a file — see SKILL.md)
node scripts/record-loop.mjs --url http://localhost:3000/app --out ./qa-run.webm \
  --state ./auth.json --auth-check "Sign out" --flow flows/my-flow.json

# Drive by hand instead
node scripts/record-loop.mjs --url http://localhost:3000 --out ./qa-run.webm --manual

# Postflight — pass the baseline so it can tell YOUR strays from everyone else's
node scripts/sweep-check.mjs --baseline ./qa-run.webm.baseline.json
```

Every run also writes `<out>.evidence.json` — console errors, uncaught page errors (via an
injected hook, because the built-in channels miss them), failed requests, accessibility
snapshots, and timestamped chapters. **Read it before you look at a single frame:** it is free,
and a model watching pixels is blind to that entire class of failure.

## The method (short version — full discipline in [SKILL.md](SKILL.md))

1. **Write the checklist BEFORE recording, as a file.** `checklists/*.json`. Every item must
   declare what would **falsify** it — an item without a falsifier is rejected at load, because
   if you can't say what would disprove it you've written a hope. The loop resolves what it
   actually can and says **UNJUDGEABLE** for the rest, *with the timestamp to look at*.
2. **Video is the exception, not the default.** Ask first: does this change have animated
   elements that need video? If not, `--shots` — one PNG per chapter. Measured: a tape costs
   7–10 MB and gets ~5 frames actually looked at, and stills can be diffed between runs where
   video cannot.
3. **Set the viewport BEFORE starting the recording.** The canvas is fixed at record-start;
   resizing afterwards changes the page, not the tape. (Learned the hard way — twice.)
4. **Watch cheap, then zoom.** Metadata, then a sampled pass (20–30 evenly spaced frames), then
   high-res detail only where it matters. Don't extract 200 full-res frames of a spinner.
5. **Verdict with timestamps**, and UNJUDGEABLE is a real verdict — a permit-null beats a fake
   pass. A green exit code means nothing measurable broke, *not* that the feature works.
6. **A green suite + a dead screen = the tape wins.** File the bug with the timestamp.
7. **Leave no trace.** The loop spawns real processes and isn't done until they're gone.

## What it will not do

- **It gates function; a human gates taste.** It proves a run reached a moment and that nothing
  broke. It does not judge whether the result is good.
- **Its coverage is the checklist's coverage.** A conformance instrument, not a discovery one —
  except the deterministic evidence, which is the only part that finds what nobody thought to ask.
- **It sees the browser only.** Server logs and database rows are out of reach; claims that live
  there are marked `manual` with a `judgeBy` pointer naming the channel.
- **Device emulation is not a device.** `--passes` gives a real mobile UA, touch and DPR — enough
  for layout collapse and tap targets. Not a real phone: no real network, no Safari, no OS chrome.

## Repo layout

```
scripts/record-loop.mjs      # RECORD: passes, flows, checklists, evidence, auth
scripts/check-checklist.mjs  # JUDGE: re-resolve an old tape against an amended checklist
scripts/check-passes.mjs     # compare across DEVICES (--list shows the profiles)
scripts/compare-runs.mjs     # compare across TIME (flake vs regression)
scripts/check-flow.mjs       # validate a flow file without opening a browser
scripts/collect-evidence.mjs # post-hoc evidence drain for --manual runs
scripts/sweep-check.mjs      # leave-no-trace postflight (ownership-aware)
flows/                       # scripted journeys (fill/click/waitFor/scroll)
checklists/                  # Phase 0 as files; _base.json holds the universals
SKILL.md                     # the full discipline (agent-facing)
templates/QA-WATCH-REPORT.md # the verdict scorecard template
```

## Verify the repo

```bash
npm test    # every selftest; each verifies its own logic on known input first
```

## License

MIT
