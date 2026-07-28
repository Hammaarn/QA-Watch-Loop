#!/usr/bin/env node
/**
 * record-loop.mjs — the RECORD arm of the qa-watch loop.
 *
 * Opens a page, sets the viewport BEFORE recording (the recording canvas is
 * fixed at record-start), records a WebM while the flow under test runs, and
 * always cleans the browser up — including on Ctrl-C and crashes.
 *
 * Usage:
 *   node scripts/record-loop.mjs --url <url> --out <path.webm> [options]
 *
 * Options:
 *   --url <url>          page to open (required)
 *   --out <path.webm>    output video path (required)
 *   --viewport WxH       viewport set BEFORE recording (default 1280x900)
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
 *   --session <name>     agent-browser session name (optional)
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
import { formatVerdict, formatVerdictMarkdown, loadChecklist, resolveChecklist } from "./lib/checklist.mjs";
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
const [vw, vh] = (opt("viewport", "1280x900")).split("x").map(Number);
const waitS = Number(opt("wait", "60"));
const untilRe = opt("until") ? new RegExp(opt("until"), "i") : null;
const timeoutS = Number(opt("timeout", "600"));
const session = opt("session");
const flowPath = opt("flow");
const checklistPath = opt("checklist");

// Load the checklist BEFORE touching the browser. It is validated at load (every
// item needs a falsifier, guards must precede dependents), and finding that out
// after a four-minute recording — when the evidence is already collected and the
// only thing missing is the file that judges it — is a needless second run.
let checklist = null;
if (checklistPath) {
  try {
    checklist = loadChecklist(readFileSync(checklistPath, "utf-8"));
  } catch (e) {
    console.error(`[record-loop] bad checklist: ${e?.message ?? e}`);
    process.exit(1);
  }
}

const { ab, abOut, abDetached } = makeAgentBrowser({ session });
// Evidence reads get their own SHORT timeout. They are all fast queries against
// an already-running daemon, so anything slow means something is wrong — and a
// sample that blocked for the full 120s would stall the recording it is meant to
// be documenting. Fail fast, keep the tape.
const query = makeAgentBrowser({ session, timeoutMs: 15_000 });

// S#259 — the evidence collector. The tape is watched by a model looking at
// pixels; console errors, page errors and failed requests are invisible to it.
// These are deterministic, cost no tokens, and are REPORTED not enforced.
const evidence = createCollector({ abOut: query.abOut, ab: query.ab });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let recording = false;
let cleaned = false;

/**
 * Write the evidence sidecar and (if asked for) the checklist verdict.
 *
 * Called on BOTH the success and the failure path. A flow that dies mid-run is
 * exactly when the evidence is most valuable — the console error or failed
 * request that explains WHY it died is already collected, and the chapters say
 * how far it got. The first version of this only wrote on success, so a failed
 * run threw all of that away and left a bare "step N never matched" to
 * reconstruct from server logs by hand. Silence about a failure is the one
 * thing this loop must never produce.
 */
const writeArtifacts = ({ failed = false } = {}) => {
  const report = evidence.report();
  const evidencePath = `${resolve(out)}.evidence.json`;
  writeFileSync(evidencePath, JSON.stringify(report, null, 2), "utf-8");
  for (const line of formatEvidence(report)) console.log(line);
  console.log(`[record-loop] evidence: ${evidencePath}`);

  if (!checklist) return null;
  const resolved = resolveChecklist(checklist, report);
  for (const line of formatVerdict(resolved)) console.log(line);
  const verdictPath = `${resolve(out)}.verdict.md`;
  writeFileSync(verdictPath, formatVerdictMarkdown(resolved, { tape: out }), "utf-8");
  console.log(`[record-loop] verdict: ${verdictPath}`);
  if (failed) {
    console.log(
      "[record-loop] NOTE: the run FAILED before finishing, so items past the failure " +
        "never ran. Read them as unreached, not as judged.",
    );
  }
  return resolved;
};

const cleanup = (stopRecording) => {
  if (cleaned) return;
  cleaned = true;
  try { if (recording && stopRecording) ab("record", "stop"); } catch { /* best-effort */ }
  try { ab("close", "--all"); } catch { /* best-effort */ }
};
process.on("SIGINT", () => { cleanup(true); process.exit(2); });
process.on("SIGTERM", () => { cleanup(true); process.exit(2); });

try {
  mkdirSync(dirname(resolve(out)), { recursive: true });

  // 1. navigate FIRST, 2. viewport BEFORE recording — the canvas is fixed at record-start.
  ab("open", url);
  await sleep(1500);
  ab("set", "viewport", String(vw), String(vh));
  await sleep(400);

  // Drain anything the navigation produced BEFORE the tape starts, so the first
  // recorded second is not polluted with load-time noise attributed to t=0.
  evidence.collect();

  // 3. record the CURRENT page (no URL arg — a URL here spawns a fresh context
  //    and can drop the viewport we just set).
  // abDetached: the recorder outlives us and would otherwise hold our stderr,
  // wedging any pipe our own output is written to. See abDetached()'s note.
  abDetached("record", "start", resolve(out));
  recording = true;
  evidence.mark("record-start", `${vw}x${vh}`);
  // AFTER record start: starting a recording reloads the page, which would wipe
  // a hook installed earlier. See installErrorHook() for why the built-ins are
  // not enough on their own.
  evidence.installErrorHook();
  console.log(`[record-loop] recording ${vw}x${vh} -> ${out}`);

  if (has("manual")) {
    console.log("[record-loop] --manual: browser is yours. Drive the flow, then run:");
    console.log(`  node scripts/collect-evidence.mjs --out ${out}   # console/network evidence`);
    console.log("  agent-browser record stop && agent-browser close --all");
    process.exit(0); // deliberately NO cleanup — the operator owns the session now
  }

  // --flow: drive the scripted steps, then stop. This is the unattended path —
  // no operator, full sampling, one chapter per step.
  if (flowPath) {
    const flow = loadFlow(readFileSync(flowPath, "utf-8"));
    console.log(`[record-loop] flow: ${flow.name ?? flowPath} (${flow.steps.length} steps)`);
    await runFlow(flow, {
      ab, abOut: query.abOut, sleep,
      mark: (e, d) => evidence.mark(e, d),
      collect: () => evidence.collect(),
      log: (m) => console.log(m),
    });
  } else {
  // Sample on a fixed 5s beat in BOTH drive modes. --until already polls at that
  // cadence; --wait used to sleep straight through, which meant a fixed-duration
  // recording gathered no evidence at all.
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

  ab("record", "stop");
  recording = false;
  evidence.mark("record-stop");
  evidence.collect(); // final drain — late errors still belong to this tape
  cleanup(false);

  console.log(`[record-loop] saved: ${out}`);
  const resolved = writeArtifacts();

  if (resolved) {
    console.log("[record-loop] next: judge the UNJUDGEABLE items — the verdict says where to look.");
    // A machine-checkable claim came back false. Everything else stays exit 0,
    // including UNJUDGEABLE: the loop gates FUNCTION, a human gates TASTE.
    if (resolved.summary.fail > 0) process.exit(1);
  } else {
    console.log("[record-loop] next: watch it (SKILL.md phase 2) — video_info -> sampled watch -> detail frames.");
  }
} catch (e) {
  console.error(`[record-loop] FAILED: ${e?.message ?? e}`);
  // Stop the recording and drain the buffers BEFORE closing the browser —
  // once the daemon is gone there is nothing left to ask. The tape already
  // survived this path (cleanup stops the recorder); the evidence did not.
  try {
    if (recording) { ab("record", "stop"); recording = false; evidence.mark("record-stop", "after failure"); }
  } catch { /* best-effort */ }
  try { evidence.collect(); } catch { /* the browser may already be gone */ }
  cleanup(false);
  try { writeArtifacts({ failed: true }); } catch (e2) {
    console.error(`[record-loop] could not write evidence after failure: ${e2?.message ?? e2}`);
  }
  process.exit(2);
}
