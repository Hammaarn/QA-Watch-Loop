#!/usr/bin/env node
/**
 * record-loop.mjs — the RECORD arm of the qa-watch loop.
 *
 * Opens a page, applies a pass (viewport or real device emulation) BEFORE
 * recording (the recording canvas is fixed at record-start), records a WebM
 * while the flow under test runs, and always cleans the browser up — including
 * on Ctrl-C and crashes.
 *
 * Usage:
 *   node scripts/record-loop.mjs --url <url> --out <path.webm> [options]
 *
 * Options:
 *   --url <url>          page to open (required)
 *   --out <path.webm>    output video path (required)
 *   --viewport WxH       viewport set BEFORE recording (default 1280x900)
 *   --device <name>      emulate a device instead (e.g. "iPhone 12") — real
 *                        emulation: UA, touch and DPR, not just a narrow window
 *   --passes <a,b,...>   run the SAME flow once per pass and compare across them.
 *                        Names: desktop, laptop, desktop-hd, mobile, iphone-12,
 *                        iphone-se, pixel-5, ipad — or `1280x900`, `1280x900@2`,
 *                        `device:<any Playwright device>`. Artifacts are
 *                        namespaced per pass. See lib/passes.mjs.
 *   --wait <seconds>     record for a fixed duration, then stop (default 60)
 *   --until <regex>      instead of --wait: poll the accessibility snapshot
 *                        every 5s and stop when it matches (e.g. "VERDICT|Done")
 *   --timeout <seconds>  hard cap when using --until (default 600)
 *   --manual             start recording and exit 0, leaving the browser up;
 *                        you drive the flow yourself, then run:
 *                        agent-browser record stop && agent-browser close --all
 *   --flow <file.json>   drive a scripted flow (fill/click/waitFor/scroll), then
 *                        stop. Unattended, and every step becomes a chapter —
 *                        this is what --manual cannot do. See flows/.
 *   --checklist <file>   resolve a Phase 0 checklist against this run's evidence
 *                        and print the verdict table. See checklists/.
 *   --shots              stills instead of video: one PNG per chapter, no webm.
 *                        ASK FIRST: does this change have animated elements that
 *                        need video? If not, use this — it is cheaper, and
 *                        stills diff between runs where a tape cannot.
 *   --session <name>     agent-browser session name (optional)
 *
 * Authentication (all of it borrowed, none of it built — see the note below):
 *   --state <file>       load saved cookies/localStorage before navigating
 *   --save-state <file>  save browser state at the end of the run
 *   --auth <profile>     log in first via agent-browser's credential vault
 *   --auth-check <text>  REQUIRE this text on screen after recording starts;
 *                        the guard that proves the session survived
 *
 * Alongside the .webm it writes <out>.evidence.json — console errors, page
 * errors (uncaught exceptions + unhandled rejections, via an injected hook),
 * failed requests, and timestamped CHAPTERS to aim the watch pass at. Sampled
 * every 5s in both drive modes. Reported, never enforced: the verdict stays a
 * human judgement. For --manual runs use scripts/collect-evidence.mjs instead.
 *
 * Exit codes: 0 recorded ok · 1 bad args, or a checklist FAIL · 2 browser/
 * recording failure. A checklist UNJUDGEABLE never sets a non-zero exit — see
 * check-checklist.mjs for why.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createCollector, formatEvidence, makeAgentBrowser } from "./lib/agent-browser.mjs";
import { loadFlow, runFlow } from "./lib/flow.mjs";
import { formatVerdict, formatVerdictMarkdown, loadChecklistFile, resolveChecklist } from "./lib/checklist.mjs";
import { applyPass, comparePasses, formatPassComparison, parsePass, passOutPath, resolvePasses } from "./lib/passes.mjs";
import { listBrowsers } from "./lib/processes.mjs";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const url = opt("url");
const out = opt("out");
if (!url || !out) {
  console.error("required: --url <url> --out <path.webm>   (see header for options)");
  process.exit(1);
}
const waitS = Number(opt("wait", "60"));
const untilRe = opt("until") ? new RegExp(opt("until"), "i") : null;
const timeoutS = Number(opt("timeout", "600"));
const session = opt("session");
const flowPath = opt("flow");
const checklistPath = opt("checklist");

// ── AUTHENTICATION: WIRED, NOT BUILT ────────────────────────────────────────
// agent-browser already ships the whole of this — `state save/load` for cookies
// and localStorage, an `auth` vault that takes a password on stdin and encrypts
// at rest, and --session-name for auto-restore. The loop's gap was never a
// missing capability, only a missing flag. Building a second credential store on
// top would be machinery over a solved problem, and a worse one: this way the
// secret never passes through this process at all.
const statePath = opt("state");
const saveStatePath = opt("save-state");
const authProfile = opt("auth");
const authCheck = opt("auth-check");

// ── PASSES ──────────────────────────────────────────────────────────────────
// One pass is the default and keeps the operator's exact --out path. --passes
// turns mobile from "run the command again by hand and eyeball both" into a
// computed comparison.
const defaultPass = opt("device")
  ? parsePass(`device:${opt("device")}`)
  : parsePass(opt("viewport", "1280x900"));
let passes;
try {
  passes = resolvePasses(opt("passes"), defaultPass);
} catch (e) {
  console.error(`[record-loop] bad --passes: ${e?.message ?? e}`);
  process.exit(1);
}
const multiPass = passes.length > 1;

// ── VIDEO OR STILLS ─────────────────────────────────────────────────────────
// The question to answer BEFORE every run (Erik's rule): does the change under
// test have animated elements that need video inspection? If not, take stills.
//
// Measured on real runs: a tape costs 7-10 MB and gets five frames looked at,
// while the evidence sidecar does most of the actual work. Stills are cheaper,
// land one per chapter, and can be diffed between runs — video cannot. Motion
// is the exception that earns the tape, not the default that assumes it.
//
// Multi-pass leans further this way: N passes means N tapes, and what you
// actually compare between passes is the verdict table and the framing, both of
// which stills serve better than video.
const shotsMode = has("shots");

// Load the checklist BEFORE touching the browser. It is validated at load (every
// item needs a falsifier, guards must precede dependents), and finding that out
// after a four-minute recording — when the evidence is already collected and the
// only thing missing is the file that judges it — is a needless second run.
let checklist = null;
if (checklistPath) {
  try {
    checklist = loadChecklistFile(checklistPath);
  } catch (e) {
    console.error(`[record-loop] bad checklist: ${e?.message ?? e}`);
    process.exit(1);
  }
}

// Same reasoning for the flow: a missing credential must surface before the
// browser opens, not four minutes into a recording. loadFlow resolves every
// ${ENV_VAR} and throws on an unset one.
let flow = null;
if (flowPath) {
  try {
    flow = loadFlow(readFileSync(flowPath, "utf-8"));
  } catch (e) {
    console.error(`[record-loop] bad flow: ${e?.message ?? e}`);
    process.exit(1);
  }
}

if (has("manual") && multiPass) {
  console.error("[record-loop] --manual drives one browser by hand; it cannot run multiple passes");
  process.exit(1);
}

const { ab, abOut, abDetached } = makeAgentBrowser({ session });
// Evidence reads get their own SHORT timeout. They are all fast queries against
// an already-running daemon, so anything slow means something is wrong — and a
// sample that blocked for the full 120s would stall the recording it is meant to
// be documenting. Fail fast, keep the tape.
const query = makeAgentBrowser({ session, timeoutMs: 15_000 });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Mutable handle so the signal handlers can clean up whichever pass is live. */
const live = { recording: false, cleaned: false };

/**
 * Close our session — and know that this does NOT isolate us.
 *
 * MEASURED S#261, and the measurement killed the obvious fix. This called
 * `close --all`, which closes every agent-browser session, so a bystander session
 * died on every loop run. The apparent fix was to close only our own session.
 * It does not work: with two named sessions alive (11 -> 13 processes), a close
 * scoped to ONE of them took the machine to **0**. agent-browser's sessions share
 * a single browser process tree, so any close tears down all of them.
 *
 * So this is kept scoped because it is the more conservative CALL (and becomes
 * correct if agent-browser ever isolates sessions per process), but it buys no
 * protection today. The protection that actually works is the startup warning
 * below: tell the operator their other sessions will die, BEFORE we take them.
 * A stated foot-gun is survivable; a silent one is what cost a real session.
 */
const cleanup = (stopRecording) => {
  if (live.cleaned) return;
  live.cleaned = true;
  try { if (live.recording && stopRecording) ab("record", "stop"); } catch { /* best-effort */ }
  try { ab("close"); } catch { /* best-effort */ }
};
process.on("SIGINT", () => { cleanup(true); process.exit(2); });
process.on("SIGTERM", () => { cleanup(true); process.exit(2); });

/**
 * Run the flow once under one pass. Returns what happened; never throws, so one
 * pass failing cannot cost you the passes after it — running mobile is the whole
 * point, and losing it because desktop crashed would defeat the feature.
 */
async function runPass(pass) {
  const passOut = passOutPath(out, pass, multiPass);
  const shotsDir = shotsMode ? resolve(passOut).replace(/\.webm$/i, "") + "-shots" : null;
  const evidence = createCollector({ abOut: query.abOut, ab: query.ab, shots: shotsDir });

  live.recording = false;
  live.cleaned = false;

  const writeArtifacts = ({ failed = false } = {}) => {
    const report = evidence.report();
    const evidencePath = `${resolve(passOut)}.evidence.json`;
    writeFileSync(evidencePath, JSON.stringify(report, null, 2), "utf-8");
    for (const line of formatEvidence(report)) console.log(line);
    console.log(`[record-loop] evidence: ${evidencePath}`);

    if (!checklist) return null;
    // The pass name scopes the checklist: items declaring `passes` resolve to N/A
    // anywhere else, so a desktop-only claim never becomes a mobile FAIL.
    const resolved = resolveChecklist(checklist, report, { pass: multiPass ? pass.name : null });
    for (const line of formatVerdict(resolved)) console.log(line);
    const verdictPath = `${resolve(passOut)}.verdict.md`;
    writeFileSync(verdictPath, formatVerdictMarkdown(resolved, { tape: passOut }), "utf-8");
    // The machine-readable twin, for compare-runs.mjs (across time) and the
    // cross-pass comparison below (across devices).
    writeFileSync(`${resolve(passOut)}.verdict.json`, JSON.stringify(resolved, null, 2), "utf-8");
    console.log(`[record-loop] verdict: ${verdictPath}`);
    if (failed) {
      console.log(
        "[record-loop] NOTE: the run FAILED before finishing, so items past the failure " +
          "never ran. Read them as unreached, not as judged.",
      );
    }
    return resolved;
  };

  try {
    mkdirSync(dirname(resolve(passOut)), { recursive: true });

    // Log in BEFORE navigating: `auth login` drives the profile's own login URL,
    // so it has to happen first and the target `open` lands already authenticated.
    if (authProfile) {
      console.log(`[record-loop] auth: logging in as profile "${authProfile}"`);
      ab("auth", "login", authProfile);
      await sleep(1000);
    }

    // 1. navigate FIRST. Saved state is applied as a global flag on `open` so the
    //    cookies exist for the very first request rather than being injected into
    //    a page that already loaded logged-out.
    if (statePath) {
      console.log(`[record-loop] state: loading ${statePath}`);
      ab("--state", statePath, "open", url);
    } else {
      ab("open", url);
    }
    await sleep(1500);

    // 2. pass BEFORE recording — the canvas is fixed at record-start.
    applyPass(pass, ab);
    await sleep(400);

    // Drain anything the navigation produced BEFORE the tape starts, so the first
    // recorded second is not polluted with load-time noise attributed to t=0.
    evidence.collect();

    // 3. record the CURRENT page (no URL arg — a URL here spawns a fresh context
    //    and can drop the pass we just applied).
    // abDetached: the recorder outlives us and would otherwise hold our stderr,
    // wedging any pipe our own output is written to. See abDetached()'s note.
    if (shotsMode) {
      mkdirSync(shotsDir, { recursive: true });
      console.log(`[record-loop] stills [${pass.name}] ${pass.label} -> ${shotsDir}`);
    } else {
      abDetached("record", "start", resolve(passOut));
      live.recording = true;
      console.log(`[record-loop] recording [${pass.name}] ${pass.label} -> ${passOut}`);
    }
    evidence.mark("pass", `${pass.name} — ${pass.label}`);
    evidence.mark("record-start", pass.label);
    // AFTER record start: starting a recording reloads the page, which would wipe
    // a hook installed earlier. See installErrorHook() for why the built-ins are
    // not enough on their own.
    evidence.installErrorHook();
    evidence.captureScreen("start");

    // THE AUTH GUARD, and why it is not optional paranoia. `record start` spawns a
    // fresh context and reloads — the same behaviour that already wipes the error
    // hook and form fills. Whether a loaded session survives that is a property of
    // agent-browser I have NOT verified against a real login, so rather than
    // assume it either way, this makes it a checked fact: name something only a
    // logged-in user sees, and the run stops here with a plain message if it is
    // gone. Without this, a dropped session produces a full recording of a login
    // page and a verdict table full of confident FAILs about features that were
    // never reachable.
    if (authCheck) {
      let snap = "";
      try { snap = String(query.abOut("snapshot")); } catch { /* handled below */ }
      if (!snap.toLowerCase().includes(authCheck.toLowerCase())) {
        throw new Error(
          `--auth-check ${JSON.stringify(authCheck)} not on screen after record start — the session did ` +
            "not survive into the recording context. Nothing past this point would have been a real test.",
        );
      }
      evidence.mark("auth-confirmed", authCheck);
      console.log(`[record-loop] auth confirmed: "${authCheck}" on screen`);
    }

    if (has("manual")) {
      console.log("[record-loop] --manual: browser is yours. Drive the flow, then run:");
      console.log(`  node scripts/collect-evidence.mjs --out ${passOut}   # console/network evidence`);
      console.log("  agent-browser record stop && agent-browser close --all");
      return { pass, manual: true, exit: 0 }; // deliberately NO cleanup — the operator owns the session now
    }

    // --flow: drive the scripted steps, then stop. This is the unattended path —
    // no operator, full sampling, one chapter per step.
    if (flow) {
      console.log(`[record-loop] flow: ${flow.name ?? flowPath} (${flow.steps.length} steps)`);
      await runFlow(flow, {
        ab, abOut: query.abOut, sleep,
        // Capture the screen at every step, not just mark it. This is what makes
        // a content claim decidable — and in stills mode it IS the recording.
        mark: (e, d) => { evidence.mark(e, d); evidence.captureScreen(d ?? e); },
        collect: () => evidence.collect(),
        log: (m) => console.log(m),
      });
    } else {
      // Sample on a fixed 5s beat in BOTH drive modes. --until already polls at
      // that cadence; --wait used to sleep straight through, which meant a
      // fixed-duration recording gathered no evidence at all.
      const SAMPLE_MS = 5000;
      const deadline = Date.now() + (untilRe ? timeoutS : waitS) * 1000;
      let matched = false;
      const t0 = Date.now();

      while (Date.now() < deadline) {
        await sleep(SAMPLE_MS);
        evidence.collect();
        if (!untilRe) continue;
        let snap = "";
        try { snap = abOut("snapshot"); } catch { /* transient — keep polling */ }
        if (untilRe.test(snap)) {
          matched = true;
          evidence.mark("until-matched", String(untilRe));
          break;
        }
      }

      if (untilRe) {
        console.log(matched
          ? `[record-loop] --until matched after ${Math.round((Date.now() - t0) / 1000)}s`
          : `[record-loop] --until TIMED OUT after ${timeoutS}s (tape kept — judge what you have)`);
      }
    }

    evidence.captureScreen("end");
    if (live.recording) { ab("record", "stop"); live.recording = false; }
    evidence.mark("record-stop");
    evidence.collect(); // final drain — late errors still belong to this tape

    // Save state BEFORE closing: once the browser is gone there is nothing to
    // save. Deliberately on the success path only — persisting the state of a run
    // that crashed mid-flow would bank whatever broken session caused it.
    if (saveStatePath) {
      try {
        ab("state", "save", saveStatePath);
        console.log(`[record-loop] state saved: ${saveStatePath}`);
      } catch (e) {
        console.error(`[record-loop] could not save state: ${e?.message ?? e}`);
      }
    }

    cleanup(false);

    console.log(`[record-loop] saved: ${shotsMode ? shotsDir : passOut}`);
    const verdict = writeArtifacts();
    return { pass, verdict, exit: verdict && verdict.summary.fail > 0 ? 1 : 0 };
  } catch (e) {
    console.error(`[record-loop] [${pass.name}] FAILED: ${e?.message ?? e}`);
    // Stop the recording and drain the buffers BEFORE closing the browser —
    // once the daemon is gone there is nothing left to ask. The tape already
    // survived this path (cleanup stops the recorder); the evidence did not.
    try {
      if (live.recording) { ab("record", "stop"); live.recording = false; evidence.mark("record-stop", "after failure"); }
    } catch { /* best-effort */ }
    try { evidence.collect(); } catch { /* the browser may already be gone */ }
    cleanup(false);
    let verdict = null;
    try { verdict = writeArtifacts({ failed: true }); } catch (e2) {
      console.error(`[record-loop] could not write evidence after failure: ${e2?.message ?? e2}`);
    }
    return { pass, verdict, error: e?.message ?? String(e), exit: 2 };
  }
}

// ── OWNERSHIP BASELINE ──────────────────────────────────────────────────────
// Snapshot which automation-driven browsers already exist BEFORE we open ours,
// so the postflight can tell what THIS loop leaked from what was already there.
// Without it, sweep-check flags a bystander's session as our leak and advises a
// `close --all` that kills it (measured S#261: 10 processes from an unrelated
// `sl-board` session, reported as ours, and the advice reaped them).
//
// Captured once for the whole run, not per pass: the question is "what predates
// this loop", and pass 2's baseline would otherwise include pass 1's own browser.
const baselinePath = `${resolve(out)}.baseline.json`;
{
  const before = listBrowsers();
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(
    baselinePath,
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        // null (not []) when the listing itself failed — a failed read is not an
        // empty machine, and sweep-check must not treat it as one.
        browsersAtStart: before === null ? null : before.map((p) => p.pid),
        note: before === null
          ? "process listing FAILED — ownership cannot be attributed for this run"
          : "pids of automation-driven browsers running before this loop opened anything",
      },
      null,
      2,
    ),
    "utf-8",
  );
  console.log(
    before === null
      ? "[record-loop] baseline: process listing failed — postflight ownership will be unknown"
      : `[record-loop] baseline: ${before.length} browser(s) already running (not ours)`,
  );

  // THE WARNING THAT IS THE ACTUAL MITIGATION (S#261).
  //
  // agent-browser sessions share one browser process tree: a close scoped to a
  // single session was measured taking 13 processes to 0. So this loop CANNOT
  // clean up after itself without also closing whatever else is open — and it
  // will do exactly that, at the end of the run, whether or not you knew.
  //
  // The fix is not technical, because the substrate does not offer one. It is to
  // say so before it happens, while the operator can still act. This is the one
  // thing that would have prevented the real incident: a SIGHTLINE board session
  // died mid-session and nobody knew why until it was investigated afterwards.
  if (before !== null && before.length > 0) {
    console.log(
      `[record-loop] ⚠ WARNING: ${before.length} browser process(es) are already running.\n` +
      "[record-loop]   agent-browser shares ONE browser process tree across sessions, so this\n" +
      "[record-loop]   loop's cleanup WILL close them too — measured, not theoretical.\n" +
      "[record-loop]   If any of them matter, Ctrl-C now and finish that work first.",
    );
  }
}

const results = [];
for (const [i, pass] of passes.entries()) {
  if (multiPass) console.log(`\n[record-loop] ══ pass ${i + 1}/${passes.length}: ${pass.name} (${pass.label}) ══`);
  results.push(await runPass(pass));
  if (results[results.length - 1].manual) break;
  // Between passes: close OUR session and let the daemon settle. Device emulation
  // is context state — reusing a context would carry the phone's UA and touch
  // flags into the desktop pass and make both passes measure the same thing.
  // Scoped, not `--all`: resetting our own context must not reap anyone else's.
  if (i < passes.length - 1) {
    try { ab("close"); } catch { /* best-effort */ }
    await sleep(1500);
  }
}

if (results.some((r) => r.manual)) process.exit(0);

if (multiPass) {
  console.log("");
  const failed = results.filter((r) => r.error);
  for (const r of failed) {
    console.log(`[passes] pass "${r.pass.name}" did not complete: ${r.error}`);
  }
  if (checklist) {
    // Only compare passes that produced a verdict. A pass that died has no
    // verdicts to disagree with, and silently treating its absence as agreement
    // would report a clean cross-pass result for a run that half happened.
    const judged = results.filter((r) => r.verdict);
    if (judged.length >= 2) {
      for (const line of formatPassComparison(comparePasses(judged))) console.log(line);
    } else {
      console.log(`[passes] only ${judged.length} pass produced a verdict — nothing to compare across`);
    }
  }
  console.log(
    `[passes] artifacts: ${results.map((r) => passOutPath(out, r.pass, true)).join(", ")}`,
  );
}

const worst = Math.max(0, ...results.map((r) => r.exit ?? 0));
if (results.some((r) => r.verdict)) {
  console.log("[record-loop] next: judge the UNJUDGEABLE items — the verdict says where to look.");
} else {
  console.log("[record-loop] next: watch it (SKILL.md phase 2) — video_info -> sampled watch -> detail frames.");
}
// Hand over the sweep command WITH its baseline. Without the baseline the sweep
// cannot attribute what it finds, and the version of this advice that omitted it
// is what got a bystander's session killed.
console.log(`[record-loop] postflight: node scripts/sweep-check.mjs --baseline ${baselinePath}`);
process.exit(worst);
