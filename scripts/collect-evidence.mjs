#!/usr/bin/env node
/**
 * collect-evidence.mjs — the evidence arm for MANUAL sessions.
 *
 * `record-loop --manual` hands the browser to the operator (or an agent) to
 * drive a flow too complex to express in flags — which is the realistic path for
 * anything with forms, multi-step navigation or a long async phase. That mode
 * exits immediately, so nothing is sampling the console while the flow runs.
 * This drains it afterwards.
 *
 *   node scripts/collect-evidence.mjs --out <path.webm>   # writes <path>.evidence.json
 *   node scripts/collect-evidence.mjs                     # print only
 *
 * HONEST LIMITATION: this is a post-hoc drain, so it tells you WHAT happened but
 * not WHEN. Every entry carries t=0 because the buffer has no timestamps of its
 * own. For a navigable timeline you need the sampled path (--wait / --until),
 * which stamps each drain as it goes. Use this to answer "did anything break?",
 * not "when did it break?".
 *
 * Run it BEFORE `agent-browser close --all` — closing the session discards the
 * buffers this reads.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createCollector, formatEvidence, makeAgentBrowser } from "./lib/agent-browser.mjs";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};

const out = opt("out");
const session = opt("session");

// Short timeout: with no live browser session these queries can try to start
// one, and a cold start wedges a piped read. Fail fast and say so instead of
// hanging the operator's terminal for two minutes.
const { ab, abOut } = makeAgentBrowser({ session, timeoutMs: 15_000 });
const evidence = createCollector({ abOut, ab });

// WARM-UP, and it is not optional. Every read below is PIPED, and a piped read
// against a cold agent-browser wedges: the daemon it starts inherits the pipe
// and holds it open, and execFileSync's `timeout` cannot rescue that — killing
// the child does not close a pipe a grandchild still owns, so spawnSync keeps
// reading forever. A NON-piped call has no pipe to hold, so it is safe and its
// timeout works. Run one first; after it, a daemon exists and piping is safe.
try { ab("session"); } catch { /* nothing to warm — reads below will come back empty */ }

evidence.collect();
const report = evidence.report();

const s = report.summary;
if (!s.consoleErrors && !s.consoleWarnings && !s.pageErrors && !s.totalRequests) {
  console.log("[evidence] nothing captured — is a browser session still open?");
  console.log("[evidence] run this BEFORE `agent-browser close --all`.");
}
report.postHoc = true; // the timeline is not meaningful — see the header note

for (const line of formatEvidence(report)) console.log(line.replace("[record-loop]", "[evidence]"));

if (out) {
  const path = `${resolve(out)}.evidence.json`;
  writeFileSync(path, JSON.stringify(report, null, 2), "utf-8");
  console.log(`[evidence] written: ${path}`);
} else {
  console.log("[evidence] no --out given; not written to disk");
}

// Always exit 0. Evidence is REPORTED, not enforced — the verdict is a human
// judgement, and a console error is a fact to weigh, not an automatic failure.
process.exit(0);
