#!/usr/bin/env node
/**
 * check-passes.mjs — the pass registry's own checks, plus a standalone
 * cross-pass comparison for verdicts you already have.
 *
 * Usage:
 *   node scripts/check-passes.mjs --selftest
 *   node scripts/check-passes.mjs <a.verdict.json> <b.verdict.json> [...]
 *   node scripts/check-passes.mjs --list
 *
 * The comparison is the same one record-loop prints at the end of a multi-pass
 * run; it lives here too so you can compare passes recorded separately, or
 * re-compare after amending a checklist.
 *
 * Exit codes: 0 no item breaks on some passes but not others · 1 at least one
 * does · 2 bad args. Divergence alone is not an error — a responsive layout is
 * SUPPOSED to differ; only PASS-here-FAIL-there is a finding.
 */
import { readFileSync } from "node:fs";
import { PROFILES, comparePasses, formatPassComparison, parsePass, passOutPath, resolvePasses } from "./lib/passes.mjs";

if (process.argv.includes("--list")) {
  console.log("Named passes:");
  for (const [name, p] of Object.entries(PROFILES)) {
    console.log(`  ${name.padEnd(12)} ${p.kind.padEnd(8)} ${p.label}`);
  }
  console.log("Ad-hoc: 1280x900 · 1280x900@2 · device:<any Playwright device name>");
  process.exit(0);
}

if (process.argv.includes("--selftest")) {
  const { strict: assert } = await import("node:assert");

  // 1. Named profiles resolve, and a device pass is a DEVICE pass — the whole
  //    point is that mobile is emulated, not merely narrow.
  assert.equal(parsePass("desktop").kind, "viewport");
  assert.equal(parsePass("iphone-12").kind, "device");
  assert.equal(parsePass("iphone-12").device, "iPhone 12");
  assert.equal(parsePass("mobile").device, "iPhone 12"); // the alias
  assert.equal(parsePass("DESKTOP").name, "desktop");    // case-insensitive

  // 2. Ad-hoc forms.
  assert.deepEqual(
    (({ kind, w, h, scale }) => ({ kind, w, h, scale }))(parsePass("1280x900")),
    { kind: "viewport", w: 1280, h: 900, scale: undefined },
  );
  assert.equal(parsePass("1920x1080@2").scale, 2);
  assert.equal(parsePass("device:Galaxy S9+").device, "Galaxy S9+");
  assert.equal(parsePass("device:Galaxy S9+").kind, "device");

  // 3. An unknown pass THROWS. Silently skipping one would produce a report that
  //    reads as having covered mobile when it never opened a phone.
  assert.throws(() => parsePass("phone"), /unknown pass/);
  assert.throws(() => parsePass("device:"), /needs a name/);
  assert.throws(() => parsePass(""), /empty pass/);

  // 4. Duplicates are rejected, not deduped: two passes sharing an --out path
  //    would have the second overwrite the first, and comparing a run to itself
  //    reports perfect agreement — the most confidently wrong output possible.
  assert.throws(() => resolvePasses("desktop,desktop"), /duplicate pass/);
  assert.equal(resolvePasses("desktop,mobile").length, 2);
  // No --passes means exactly the fallback, untouched.
  const fb = parsePass("1280x900");
  assert.deepEqual(resolvePasses(null, fb), [fb]);

  // 5. Artifact paths: single-pass keeps the operator's exact path; multi-pass
  //    namespaces. The common case must not grow a suffix just because a
  //    feature exists.
  assert.equal(passOutPath("out/run.webm", parsePass("desktop"), false), "out/run.webm");
  assert.equal(passOutPath("out/run.webm", parsePass("desktop"), true), "out/run.desktop.webm");
  assert.equal(passOutPath("out/run.webm", parsePass("iphone-12"), true), "out/run.iphone-12.webm");
  assert.equal(passOutPath("out/run", parsePass("desktop"), true), "out/run.desktop");

  // 6. CROSS-PASS COMPARISON.
  const mk = (name, items) => ({ pass: { name }, verdict: { items } });
  const item = (id, verdict, claim = id) => ({ id, claim, verdict, why: "" });

  // Agreement is silent.
  let c = comparePasses([mk("desktop", [item("a", "PASS")]), mk("mobile", [item("a", "PASS")])]);
  assert.equal(c.diverged.length, 0);
  assert.ok(formatPassComparison(c).some((l) => /same verdict on every pass/.test(l)));

  // PASS here, FAIL there is THE finding this feature exists to produce.
  c = comparePasses([mk("desktop", [item("a", "PASS")]), mk("mobile", [item("a", "FAIL")])]);
  assert.equal(c.failsOnSome.length, 1);
  assert.ok(formatPassComparison(c).some((l) => /BREAKS-ON/.test(l)));

  // N/A must NOT count as divergence — an item deliberately scoped to desktop is
  // not "different on mobile", it was never asked there.
  c = comparePasses([mk("desktop", [item("a", "PASS")]), mk("mobile", [item("a", "N/A")])]);
  assert.equal(c.diverged.length, 0, "a scoped-out item must not read as diverging");
  assert.equal(c.failsOnSome.length, 0);

  // Every pass saying N/A is also not a divergence.
  c = comparePasses([mk("desktop", [item("a", "N/A")]), mk("mobile", [item("a", "N/A")])]);
  assert.equal(c.diverged.length, 0);

  // PASS vs UNJUDGEABLE differs but does not "break on" a pass — it means one
  // pass never exercised it. Worth surfacing, not worth alarming.
  c = comparePasses([mk("desktop", [item("a", "PASS")]), mk("mobile", [item("a", "UNJUDGEABLE")])]);
  assert.equal(c.diverged.length, 1);
  assert.equal(c.failsOnSome.length, 0);

  // An item missing from one pass entirely is ABSENT, never silently skipped.
  c = comparePasses([mk("desktop", [item("a", "PASS")]), mk("mobile", [])]);
  assert.deepEqual(c.rows[0].cells.map((x) => x.verdict), ["PASS", "ABSENT"]);
  assert.equal(c.diverged.length, 1);

  console.log("[check-passes] selftest OK");
  process.exit(0);
}

const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (files.length < 2) {
  console.error("need at least two <tape>.verdict.json files from DIFFERENT passes");
  process.exit(2);
}

let results;
try {
  results = files.map((f) => {
    const verdict = JSON.parse(readFileSync(f, "utf-8"));
    // The pass name is written into the verdict by record-loop; fall back to the
    // filename so verdicts recorded before this feature still compare.
    return { pass: { name: verdict.pass ?? f.replace(/\.verdict\.json$/, "").split(/[\\/]/).pop() }, verdict };
  });
} catch (e) {
  console.error(`[check-passes] FAILED to load: ${e?.message ?? e}`);
  process.exit(2);
}

const cmp = comparePasses(results);
for (const line of formatPassComparison(cmp)) console.log(line);
process.exit(cmp.failsOnSome.length > 0 ? 1 : 0);
