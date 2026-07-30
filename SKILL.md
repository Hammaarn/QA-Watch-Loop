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
- **Write only what is task-specific.** `"extends": "_base"` pulls in the criteria every run owes
  (no page errors, no console errors, no failed requests, the run finished). Reusing a base item's
  id overrides it — that is how you say "this flow legitimately expects a 402".
- **The machine decides what it actually can**, and says UNJUDGEABLE for everything else *with the
  timestamp to look at*. It resolves `chapter` (did the run REACH this moment, and by when),
  `noConsoleError` / `noPageError` / `noFailedRequest`, and — the ones that matter most —
  `snapshotContains` / `snapshotAbsent` over the accessibility tree captured at every chapter.
  **Reach for those before you write `manual`.** "The verdict shows a real case number", "nothing
  says *quota exceeded*", "no unlock teaser" all *look* like visual judgements and are actually
  string assertions. `manual` is for genuine taste, and for claims living somewhere this cannot see
  (a server log, a database row) — those carry `judgeBy` to name the channel.
- **Guards cascade.** An item can `dependsOn` an earlier one. If the guard did not pass, the
  dependent goes UNJUDGEABLE, never FAIL — a claim that was never exercised is untested, not false,
  and recording it as a failure is exactly as wrong as recording it as a pass.

Two invariants the resolver will not let you break:

1. **It never invents a PASS.** A `manual` item cannot drift into PASS no matter how clean the run.
2. **An unread channel is not an empty one.** If evidence collection failed, every absence-based
   item is withheld as UNJUDGEABLE rather than passed. (This is the false-clean bug that once
   reported an unreadable channel as a clean one, promoted into a rule.) The same applies to
   content: **nothing captured is not nothing present** — with no snapshots, `snapshotContains` and
   `snapshotAbsent` both withhold rather than guess.

`node scripts/check-checklist.mjs --selftest` proves all of that still holds.

## Phase 1 — record

**Ask this first, every time: does the change under test have animated elements that need video
inspection?** Motion, transitions, a cursor synced to narration, a curtain — those earn a tape.
Everything else takes **stills** (`--shots`): one PNG per chapter, no webm.

This is not a micro-optimisation. Measured on real runs, a tape costs 7–10 MB and gets about five
frames actually looked at, while the evidence sidecar does most of the work. Stills are cheaper,
land exactly at the moments you named, and **can be diffed between runs** — a video cannot. Video is
the exception that earns itself, not the default that assumes it.

**Then ask the second question: does this change need to hold on a phone?** If yes, run it as
passes rather than as two unrelated commands:

```bash
node scripts/record-loop.mjs --url <url> --out out/run.webm --shots \
  --passes desktop,iphone-12 --flow flows/<f>.json --checklist checklists/<c>.json
```

The flow runs once per pass, the browser is fully reset between them, and at the end you get the
thing a second command by hand never produced: **a cross-pass report naming every item whose verdict
DIFFERS between devices**. `BREAKS-ON` — passes on one, fails on another — is the finding the whole
feature exists for; judge those first.

`device:` passes use real Playwright emulation (UA, touch, DPR), not a narrow window. That
distinction is load-bearing: a 390px desktop Chrome still sends a desktop UA and still gets hover
styles, so a UA-gated layout or a tap-only handler passes a resize test and fails on the phone.
`node scripts/check-passes.mjs --list` shows the profiles.

**Scope items that a responsive layout is *supposed* to change.** An item's `passes: ["desktop"]`
makes it **N/A** elsewhere — not FAIL, and not folded into UNJUDGEABLE (which is your work queue).
A check that is wrong by design on one pass is worse than no check: it teaches you to skim past red.

### Behind a login

The loop wires agent-browser's own auth; it does not implement any of its own.

```bash
# once, by hand — the password never touches a file you commit
echo "$PASS" | agent-browser auth save myapp --url https://app/login --username me --password-stdin
agent-browser auth login myapp && agent-browser state save ./auth.json

# then, every run
node scripts/record-loop.mjs --url https://app/dash --out out/r.webm \
  --state ./auth.json --auth-check "Sign out" --flow flows/x.json
```

- `--state <file>` loads cookies/localStorage at context creation · `--save-state <file>` writes them
  back after a successful run · `--auth <profile>` logs in through the vault first.
- **`--auth-check <text>` is not optional paranoia.** `record start` spawns a fresh context and
  reloads — the same behaviour that already wipes the injected error hook and form fills. Name
  something only a logged-in user sees and the run stops with a plain message if the session did not
  survive. Without it, a dropped session records a login page and produces a verdict table full of
  confident FAILs about features that were never reachable.
- **Never put a credential in a flow file.** Use `"value": "${MY_PASSWORD}"` and declare
  `"requires": ["MY_PASSWORD"]`; an unset variable fails at load, before the browser opens, and a
  resolved value never reaches a chapter label, the evidence JSON or the verdict table. A missing
  variable is a hard error rather than an empty string, because filling a login form with `""`
  produces a run that *looks* like it exercised auth. `node scripts/check-flow.mjs <file>` validates
  one without running it.

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

**Running the same loop more than once?** Then, and only then, compare:
`node scripts/compare-runs.mjs a.webm.verdict.json b.webm.verdict.json [...]`. Run it N times
unchanged to find **flake** (an item that moves and comes back is worse than no check — it teaches
you to ignore the instrument); run it before and after a change to find **regressions**. The loop
keeps no history of its own on purpose: a journey run once has nothing to compare against, so a
baseline store would spend disk and trust on a comparison nobody asked for.

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

**Pass `--baseline <out>.baseline.json`** (record-loop writes it, and prints the exact command).
Without it the sweep cannot attribute what it finds, and will say so rather than guess — it used
to announce every automation-driven browser as the loop's own leak and advise `close --all`.

> **⚠ DO NOT RUN THIS LOOP ALONGSIDE OTHER BROWSER WORK.**
> **Measured S#261:** agent-browser sessions share ONE browser process tree. With two named
> sessions alive (13 processes), a close scoped to a *single* session took the machine to **0**.
> So the loop cannot clean up after itself without closing every other session too, and there is
> no flag that changes this — `close` and `close --all` behave the same way here.
> The loop now warns at startup when browsers are already running. Heed it: a real SIGHTLINE
> board session was killed this way, and the cause was only found afterwards.

## Known limits (state them in every report)

- **Device emulation is not a device.** `--passes` gives you a real mobile UA, touch flags and DPR,
  which is enough to catch layout collapse, tap targets and UA-gated code paths. It is not a real
  phone: no actual network conditions, no real GPU, no OS chrome eating viewport height, no Safari.
  A pass is a strong filter, not a substitute for holding the thing.
- The recording shows the viewport only — background tabs, console, and network are invisible;
  pair the tape with server logs when the failure could be non-visual.
- Frame sampling can miss sub-second events; if a checklist item is a fast animation, use a
  high-fps `video_detail` segment on that moment specifically.
- **The checklist resolver sees browser-side evidence only.** Server logs, database rows and
  deploy-platform output are outside its reach, so claims that live there are `manual` with a
  `judgeBy` pointer — never machine-decided. On a real run this was half the claims, and the
  resolver's job was to prove the run had EXERCISED them, which is the half that used to be assumed.
