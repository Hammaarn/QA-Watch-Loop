#!/usr/bin/env node
/**
 * sweep-check.mjs — "leave no trace" postflight for the qa-watch loop.
 *
 * A QA loop spawns real browser processes. This checks whether any linger after
 * `record stop` + `agent-browser close --all`. Report-only by design — it tells
 * you what is there; killing is your call.
 *
 * OWNERSHIP IS THE WHOLE POINT (S#261). This used to list every automation-driven
 * browser and call them leftovers "from the loop", then advise `close --all`. It
 * could not know whose they were, and on a real run it flagged 10 processes from
 * an unrelated session and advised a command that killed them. So:
 *
 *   - With `--baseline`, it diffs against what already existed before the loop
 *     started and reports MINE vs PRE-EXISTING. Only MINE affects the exit code.
 *   - Without one, ownership is UNKNOWN and it says so. It will not claim the
 *     processes are the loop's, and it will not tell you to run `close --all`
 *     without naming what that also reaps.
 *
 * Usage:
 *   node scripts/sweep-check.mjs [--baseline <file.baseline.json>] [--json]
 *   node scripts/sweep-check.mjs --selftest
 *
 * record-loop writes `<out>.baseline.json` automatically; pass it here.
 *
 * Exit: 0 = clean, or nothing attributable to this loop · 1 = leftovers THIS LOOP
 *       started · 2 = processes found but ownership unknown (no baseline), or the
 *       listing itself failed. Exit 2 means "look at this yourself", which is
 *       different from both clean and dirty.
 */
import { readFileSync } from "node:fs";
import { classify, filterBrowsers, listBrowsers } from "./lib/processes.mjs";

const args = process.argv.slice(2);
const opt = (n, d = null) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };

if (args.includes("--selftest")) {
  const { strict: assert } = await import("node:assert");
  const p = (pid, name, cmd) => ({ pid, name, cmd });

  // 1. Only automation-driven browsers count. A human's Chrome is not a leak.
  const all = [
    p(1, "chrome.exe", "chrome.exe --remote-debugging-port=0 --headless"),
    p(2, "chrome.exe", "chrome.exe https://news.example.com"),   // a real person's browser
    p(3, "node.exe", "node script.mjs --headless"),              // not a browser
    p(4, "firefox", "firefox --marionette playwright"),
  ];
  assert.deepEqual(filterBrowsers(all).map((x) => x.pid), [1, 4]);

  // 2. THE FIX: a process that existed BEFORE the loop is not the loop's, however
  //    much it looks like one. This is the sl-board case that motivated the file.
  const current = filterBrowsers(all);
  let c = classify(current, [1]);
  assert.deepEqual(c.preExisting.map((x) => x.pid), [1]);
  assert.deepEqual(c.mine.map((x) => x.pid), [4]);
  assert.equal(c.unknown.length, 0);

  // 3. No baseline => UNKNOWN, never silently "mine" (cries wolf, and the printed
  //    remediation kills bystanders) and never silently "not mine" (hides a leak).
  c = classify(current, null);
  assert.equal(c.mine.length, 0);
  assert.equal(c.preExisting.length, 0);
  assert.deepEqual(c.unknown.map((x) => x.pid), [1, 4]);

  // 4. Everything pre-existing => genuinely clean for THIS loop.
  c = classify(current, [1, 4]);
  assert.equal(c.mine.length, 0);
  assert.equal(c.preExisting.length, 2);

  // 5. An empty baseline is a REAL baseline (nothing was running), distinct from
  //    a missing one. Everything found is then mine.
  c = classify(current, []);
  assert.deepEqual(c.mine.map((x) => x.pid), [1, 4]);
  assert.equal(c.unknown.length, 0);

  // 6. THE `??` TRAP, pinned. record-loop writes browsersAtStart:null when its own
  //    process listing failed. `(x ?? [])` turns that into an EMPTY baseline, which
  //    reads as "nothing was running, so all of this is mine" — the false-clean bug
  //    inverted into a false-blame. null and [] must not collapse.
  const parse = (json) => {
    const raw = json.browsersAtStart !== undefined ? json.browsersAtStart : json.pids;
    return raw === null || !Array.isArray(raw) ? null : raw.map(Number);
  };
  assert.equal(parse({ browsersAtStart: null }), null, "a failed listing must not become an empty baseline");
  assert.deepEqual(parse({ browsersAtStart: [] }), [], "an empty baseline is a real baseline");
  assert.deepEqual(parse({ browsersAtStart: [7, 8] }), [7, 8]);
  assert.equal(classify(current, parse({ browsersAtStart: null })).unknown.length, 2);
  assert.equal(classify(current, parse({ browsersAtStart: [] })).mine.length, 2);

  console.log("[sweep-check] selftest OK");
  process.exit(0);
}

let baselinePids = null;
let baselineNote = "no baseline given";
const baselineFile = opt("baseline");
if (baselineFile) {
  try {
    const b = JSON.parse(readFileSync(baselineFile, "utf-8"));
    const raw = b.browsersAtStart !== undefined ? b.browsersAtStart : b.pids;
    if (raw === null) {
      // record-loop writes null when its OWN process listing failed. That is not
      // an empty baseline — treating it as one would make every running browser
      // look like this loop's leak. `??` would have done exactly that.
      baselineNote = `baseline ${baselineFile} records a FAILED listing — ownership unattributable`;
    } else if (!Array.isArray(raw)) {
      baselineNote = `baseline ${baselineFile} has no usable pid list`;
    } else {
      baselinePids = raw.map(Number);
      baselineNote = `baseline ${baselineFile} (${baselinePids.length} browser(s) already running)`;
    }
  } catch (e) {
    // A baseline we cannot read is not an empty baseline.
    console.error(`sweep-check: could not read baseline ${baselineFile}: ${e?.message ?? e}`);
    console.error("sweep-check: continuing WITHOUT one — ownership will be reported as unknown");
  }
}

const current = listBrowsers();
if (current === null) {
  console.error("sweep-check: could not list processes on this platform — check manually");
  process.exit(2);
}

const { mine, preExisting, unknown } = classify(current, baselinePids);

if (args.includes("--json")) {
  console.log(JSON.stringify({ baseline: baselineNote, mine, preExisting, unknown }, null, 2));
}

if (mine.length === 0 && unknown.length === 0) {
  const tail = preExisting.length ? ` (${preExisting.length} pre-existing, not this loop's)` : "";
  console.log(`sweep-check: clean — this loop left nothing behind${tail}`);
  process.exit(0);
}

if (mine.length > 0) {
  console.log(`sweep-check: ${mine.length} process(es) THIS LOOP started are still running:`);
  for (const p of mine) console.log(`  pid=${p.pid}  ${p.name}  ${p.cmd.slice(0, 100)}`);
  if (preExisting.length) {
    console.log(`  (plus ${preExisting.length} that predate this loop — leave those alone)`);
  }
  console.log("\nclean up:  agent-browser close        # this loop's session");
  console.log("           agent-browser close --all  # EVERY session, including other work's");
  console.log("then re-run this check (a kill you did not verify is a kill you cannot claim).");
  process.exit(1);
}

// Unknown: processes exist, no baseline to attribute them. Say exactly that.
console.log(`sweep-check: ${unknown.length} automation-driven browser(s) running, OWNERSHIP UNKNOWN (${baselineNote}):`);
for (const p of unknown) console.log(`  pid=${p.pid}  ${p.name}  ${p.cmd.slice(0, 100)}`);
console.log("\nThese may or may not be this loop's — without a baseline this cannot tell.");
console.log("Pass --baseline <out>.baseline.json (record-loop writes it) for a real answer.");
console.log("`agent-browser close --all` WOULD clear them, and would also close any other");
console.log("session running right now. Check before you swing.");
process.exit(2);
