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
 * Exit codes: 0 recorded ok · 1 bad args · 2 browser/recording failure.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

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

const ab = (...a) => {
  const argv = session ? ["--session", session, ...a] : a;
  return execFileSync("agent-browser", argv, { encoding: "utf-8", timeout: 120_000 });
};
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

  // 3. record the CURRENT page (no URL arg — a URL here spawns a fresh context
  //    and can drop the viewport we just set).
  ab("record", "start", resolve(out));
  recording = true;
  console.log(`[record-loop] recording ${vw}x${vh} -> ${out}`);

  if (has("manual")) {
    console.log("[record-loop] --manual: browser is yours. Drive the flow, then run:");
    console.log("  agent-browser record stop && agent-browser close --all");
    process.exit(0); // deliberately NO cleanup — the operator owns the session now
  }

  if (untilRe) {
    const t0 = Date.now();
    let matched = false;
    while (Date.now() - t0 < timeoutS * 1000) {
      await sleep(5000);
      let snap = "";
      try { snap = ab("snapshot"); } catch { /* transient — keep polling */ }
      if (untilRe.test(snap)) { matched = true; break; }
    }
    console.log(matched
      ? `[record-loop] --until matched after ${Math.round((Date.now() - t0) / 1000)}s`
      : `[record-loop] --until TIMED OUT after ${timeoutS}s (tape kept — judge what you have)`);
  } else {
    console.log(`[record-loop] recording for ${waitS}s...`);
    await sleep(waitS * 1000);
  }

  ab("record", "stop");
  recording = false;
  cleanup(false);
  console.log(`[record-loop] saved: ${out}`);
  console.log("[record-loop] next: watch it (SKILL.md phase 2) — video_info -> sampled watch -> detail frames.");
} catch (e) {
  console.error(`[record-loop] FAILED: ${e?.message ?? e}`);
  cleanup(true);
  process.exit(2);
}
