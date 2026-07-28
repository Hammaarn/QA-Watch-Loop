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
 *   --session <name>     agent-browser session name (optional)
 *
 * Alongside the .webm it writes <out>.evidence.json — console errors, page
 * errors (uncaught exceptions + unhandled rejections, via an injected hook),
 * failed requests, and timestamped CHAPTERS to aim the watch pass at. Sampled
 * every 5s in both drive modes. Reported, never enforced: the verdict stays a
 * human judgement. For --manual runs use scripts/collect-evidence.mjs instead.
 *
 * Exit codes: 0 recorded ok · 1 bad args · 2 browser/recording failure.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createCollector, formatEvidence, makeAgentBrowser } from "./lib/agent-browser.mjs";

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

  ab("record", "stop");
  recording = false;
  evidence.mark("record-stop");
  evidence.collect(); // final drain — late errors still belong to this tape
  cleanup(false);

  const report = evidence.report();
  const evidencePath = `${resolve(out)}.evidence.json`;
  writeFileSync(evidencePath, JSON.stringify(report, null, 2), "utf-8");

  console.log(`[record-loop] saved: ${out}`);
  for (const line of formatEvidence(report)) console.log(line);
  console.log(`[record-loop] evidence: ${evidencePath}`);
  console.log("[record-loop] next: watch it (SKILL.md phase 2) — video_info -> sampled watch -> detail frames.");
} catch (e) {
  console.error(`[record-loop] FAILED: ${e?.message ?? e}`);
  cleanup(true);
  process.exit(2);
}
