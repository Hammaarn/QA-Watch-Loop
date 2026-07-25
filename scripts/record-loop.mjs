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

/**
 * Resolve how to invoke agent-browser.
 *
 * POSIX is unchanged: the bare name is a real executable, spawned directly.
 *
 * Windows needs a shell, and the reasoning is recorded inside the function
 * because it is counter-intuitive enough that a future cleanup would otherwise
 * undo it. Short version: three of the four plausible spawn shapes fail, two of
 * them by HANGING rather than erroring.
 */
function resolveAgentBrowser() {
  // Explicit override always wins — an unusual install, a local build, a wrapper.
  if (process.env.AGENT_BROWSER_BIN) {
    return { bin: process.env.AGENT_BROWSER_BIN, prefix: [], shell: false };
  }
  // POSIX: the bare name is a real executable. Unchanged behaviour.
  if (process.platform !== "win32") {
    return { bin: "agent-browser", prefix: [], shell: false };
  }
  // Windows: go through a shell. This is not laziness — it is the only shape
  // that both RESOLVES and RETURNS. Measured on Node v24.12.0 / agent-browser
  // 0.27.3:
  //
  //   execFileSync("agent-browser", …)            ENOENT — Node cannot spawn the
  //                                               extensionless npm wrapper
  //   execFileSync("agent-browser.cmd", …)        EINVAL — Node refuses .cmd/.bat
  //                                               without a shell (CVE-2024-27980)
  //   execFileSync(node, [bin/agent-browser.js])  ETIMEDOUT with piped stdio —
  //                                               agent-browser leaves a daemon
  //                                               holding the pipe, so the call
  //                                               never sees EOF. `stdio:"inherit"`
  //                                               returns instantly but yields no
  //                                               captured output, and --until
  //                                               polling needs the stdout.
  //   shell:true                                  resolves and returns
  //
  // Resolution is only half the problem — see abRun() for the other half, which
  // is that a COLD `open` wedges any PIPED stdout regardless of how it was
  // spawned. Both halves must hold, which is why the working combination is
  // shell:true AND a discarded stdout.
  //
  // Do NOT "clean this up" into a direct spawn without re-checking both — that
  // is exactly how the hang comes back.
  //
  // Node warns (DEP0190) that shell args are concatenated, not escaped. That
  // matters when arguments come from an untrusted source; here every argument
  // originates from the operator's own command line, so it grants no capability
  // they do not already have. Do not feed this function untrusted input.
  return { bin: "agent-browser", prefix: [], shell: true };
}

const AB = resolveAgentBrowser();

/**
 * Run an agent-browser command.
 *
 * `capture` is OFF by default, and that default is load-bearing rather than a
 * micro-optimisation. A COLD `open` launches the browser daemon, and the daemon
 * inherits whatever stdout it is given — so with a PIPE it holds the write end
 * open forever and execFileSync never sees EOF. Measured: cold `open` with piped
 * stdio times out; every subsequent command returns in ~0s because it only talks
 * to the daemon that is now running.
 *
 * That is why this script could appear to "work flawlessly" and then hang for no
 * apparent reason: if a browser session already happened to be alive, the cold
 * path never ran. Discarding stdout removes the pipe entirely, so there is
 * nothing for the daemon to hold. stderr stays inherited so real errors surface.
 *
 * Only `snapshot` needs its output, and it is safe to pipe: it spawns no daemon,
 * it just queries the one already up.
 */
const abRun = (args, capture) => {
  // Session goes through the ENVIRONMENT, not argv. Measured against
  // agent-browser 0.27.3: the flag is `--session-name` (not `--session`), and
  // usage is `agent-browser <command> [args] [options]` — options come AFTER the
  // command. The old code emitted `--session <name> <command> …`, an unknown flag
  // in the leading position, which does not error — it HANGS until the timeout.
  const env = session
    ? { ...process.env, AGENT_BROWSER_SESSION_NAME: session }
    : process.env;
  // windowsHide: npm .cmd shims spawn a visible console per call on Windows otherwise
  return execFileSync(AB.bin, [...AB.prefix, ...args], {
    encoding: "utf-8",
    timeout: 120_000,
    windowsHide: true,
    env,
    stdio: capture ? ["ignore", "pipe", "inherit"] : ["ignore", "ignore", "inherit"],
    ...(AB.shell ? { shell: true } : {}),
  });
};

/** Fire and forget — stdout discarded so a cold `open` cannot wedge the pipe. */
const ab = (...a) => abRun(a, false);
/** Capture stdout — for `snapshot` only, which spawns nothing. */
const abOut = (...a) => abRun(a, true);
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
      try { snap = abOut("snapshot"); } catch { /* transient — keep polling */ }
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
