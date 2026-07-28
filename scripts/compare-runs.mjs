#!/usr/bin/env node
/**
 * compare-runs.mjs — what changed between runs of the SAME loop.
 *
 * WHY THIS IS SCOPED THE WAY IT IS. The obvious design is a baseline store: keep
 * every run, diff each new one against the last. Erik's call, and it is the
 * right one — history only earns its keep when the same loop is run 2+ times in
 * a row. A journey run once has nothing to compare against, so a baseline store
 * would spend disk, ceremony and trust on a comparison nobody asked for, and
 * would rot the moment the app legitimately changed.
 *
 * So this tool keeps NO state. You point it at the verdict files you already
 * have, and it tells you what moved. Two uses, both real:
 *
 *   FLAKE      run the same loop N times unchanged. Any item that is not stable
 *              across all N is flaky, and a flaky check is worse than no check —
 *              it teaches you to ignore the instrument.
 *   REGRESSION run before a change and after it. Items that went PASS -> FAIL
 *              are what you broke; FAIL -> PASS is what you fixed.
 *
 * Usage:
 *   node scripts/compare-runs.mjs <a.verdict.json> <b.verdict.json> [more...]
 *   node scripts/compare-runs.mjs --selftest
 *
 * Exit codes: 0 nothing regressed · 1 at least one item went PASS -> not-PASS
 *             · 2 bad args.
 */
import { readFileSync } from "node:fs";

/**
 * Compare N resolved verdicts, oldest first.
 *
 * Pure: takes parsed objects, returns a plain report. An item missing from a run
 * is reported as ABSENT rather than silently skipped — a checklist that lost an
 * item between runs is itself a change worth seeing.
 */
export function compareRuns(runs) {
  const ids = [];
  for (const run of runs) for (const item of run.items ?? []) if (!ids.includes(item.id)) ids.push(item.id);

  const rows = ids.map((id) => {
    const verdicts = runs.map((r) => (r.items ?? []).find((i) => i.id === id)?.verdict ?? "ABSENT");
    const claim = runs.map((r) => (r.items ?? []).find((i) => i.id === id)?.claim).find(Boolean) ?? id;
    const stable = verdicts.every((v) => v === verdicts[0]);
    const first = verdicts[0];
    const last = verdicts[verdicts.length - 1];
    return {
      id,
      claim,
      verdicts,
      stable,
      regressed: first === "PASS" && last !== "PASS",
      fixed: first !== "PASS" && last === "PASS",
      // Flaky means it moved WITHOUT settling — it ended where it started but
      // wandered in between. A clean PASS->FAIL is a regression, not flake, and
      // conflating the two would hide real breakage inside "it's just flaky".
      flaky: !stable && first === last,
    };
  });

  return {
    runs: runs.length,
    rows,
    regressed: rows.filter((r) => r.regressed),
    fixed: rows.filter((r) => r.fixed),
    flaky: rows.filter((r) => r.flaky),
  };
}

export function formatComparison(cmp) {
  const out = [`[compare] ${cmp.runs} runs — ${cmp.regressed.length} regressed · ${cmp.fixed.length} fixed · ${cmp.flaky.length} flaky`];
  for (const r of cmp.rows) {
    const tag = r.regressed ? "REGRESSED" : r.fixed ? "FIXED" : r.flaky ? "FLAKY" : r.stable ? "stable" : "moved";
    if (tag === "stable") continue; // only report what MOVED — a wall of "stable" buries the signal
    out.push(`[compare]   ${tag.padEnd(10)} ${r.verdicts.join(" -> ")}  ${r.claim}`);
  }
  if (cmp.regressed.length === 0 && cmp.fixed.length === 0 && cmp.flaky.length === 0) {
    out.push("[compare]   every item held the same verdict across all runs");
  }
  if (cmp.flaky.length > 0) {
    out.push("[compare] FLAKY items moved and came back. A check you cannot trust is worse than no check — fix or delete it.");
  }
  return out;
}

if (process.argv.includes("--selftest")) {
  const { strict: assert } = await import("node:assert");
  const run = (...vs) => ({ items: vs.map((v, i) => ({ id: `i${i}`, claim: `claim ${i}`, verdict: v })) });

  // PASS -> FAIL is a regression, and it is NOT flake.
  let c = compareRuns([run("PASS"), run("FAIL")]);
  assert.equal(c.regressed.length, 1);
  assert.equal(c.flaky.length, 0);

  // FAIL -> PASS is a fix.
  c = compareRuns([run("FAIL"), run("PASS")]);
  assert.equal(c.fixed.length, 1);
  assert.equal(c.regressed.length, 0);

  // Moved and came back = flaky, and must NOT be reported as regressed.
  c = compareRuns([run("PASS"), run("FAIL"), run("PASS")]);
  assert.equal(c.flaky.length, 1);
  assert.equal(c.regressed.length, 0);
  assert.equal(c.fixed.length, 0);

  // Stable across N is silent.
  c = compareRuns([run("PASS"), run("PASS"), run("PASS")]);
  assert.equal(c.regressed.length + c.fixed.length + c.flaky.length, 0);
  assert.ok(formatComparison(c).some((l) => /held the same verdict/.test(l)));

  // An item present in one run and missing from another is ABSENT, not skipped.
  c = compareRuns([run("PASS"), { items: [] }]);
  assert.deepEqual(c.rows[0].verdicts, ["PASS", "ABSENT"]);
  assert.equal(c.regressed.length, 1);

  // UNJUDGEABLE -> PASS counts as fixed; PASS -> UNJUDGEABLE as regressed,
  // because an item that stopped being exercised stopped being verified.
  assert.equal(compareRuns([run("UNJUDGEABLE"), run("PASS")]).fixed.length, 1);
  assert.equal(compareRuns([run("PASS"), run("UNJUDGEABLE")]).regressed.length, 1);

  console.log("[compare-runs] selftest OK");
  process.exit(0);
}

const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (files.length < 2) {
  console.error("need at least two <tape>.verdict.json files — a single run has nothing to compare to");
  process.exit(2);
}

let runs;
try {
  runs = files.map((f) => JSON.parse(readFileSync(f, "utf-8")));
} catch (e) {
  console.error(`[compare-runs] FAILED to load: ${e?.message ?? e}`);
  process.exit(2);
}

const cmp = compareRuns(runs);
for (const line of formatComparison(cmp)) console.log(line);
process.exit(cmp.regressed.length > 0 ? 1 : 0);
