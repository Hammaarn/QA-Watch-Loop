#!/usr/bin/env node
/**
 * check-checklist.mjs — the JUDGE arm of the qa-watch loop.
 *
 * Resolves a Phase 0 checklist against a run's `<tape>.evidence.json` and
 * prints the verdict table. Separate from record-loop on purpose: you can
 * re-resolve an old tape against an amended checklist without re-recording,
 * which is what you want the first three times you write one.
 *
 * Usage:
 *   node scripts/check-checklist.mjs --checklist <file.json> --tape <path.webm>
 *   node scripts/check-checklist.mjs --checklist <file.json> --evidence <file.json>
 *   node scripts/check-checklist.mjs --selftest
 *
 * Options:
 *   --checklist <file>   the Phase 0 checklist (required)
 *   --tape <path.webm>   reads <path.webm>.evidence.json
 *   --evidence <file>    the evidence json directly (overrides --tape)
 *   --out <file.md>      write the markdown verdict (default: <evidence>.verdict.md)
 *   --selftest           run the built-in checks and exit
 *
 * Exit codes: 0 no FAILs · 1 at least one FAIL · 2 bad args / unreadable input.
 *
 * UNJUDGEABLE never sets a non-zero exit. It is an honest outcome, and a loop
 * that punished it would teach you to stop writing the items it applies to —
 * which are precisely the items worth writing.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  FAIL,
  PASS,
  UNJUDGEABLE,
  formatVerdict,
  formatVerdictMarkdown,
  loadChecklist,
  loadChecklistFile,
  resolveChecklist,
} from "./lib/checklist.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

if (args.includes("--selftest")) {
  const { strict: assert } = await import("node:assert");

  // A checklist used by most cases below. Guard first, per the declared-above rule.
  const base = {
    name: "selftest",
    items: [
      { id: "guard", claim: "flow reached the verdict", falsifiedBy: "chapter absent", check: { type: "chapter", match: "verdict page" } },
      { id: "dependent", claim: "teardown fired", falsifiedBy: "no log line", dependsOn: ["guard"], check: { type: "noConsoleError" } },
      { id: "visual", claim: "receipts render", falsifiedBy: "no receipt line", watch: "receipts in frame", check: { type: "manual" } },
    ],
  };
  const ev = (over = {}) => ({
    chapters: [{ t: 12, event: "flow", detail: "verdict page rendered" }, { t: 20, event: "flow", detail: "receipts in frame" }],
    console: [], pageErrors: [], failedRequests: [], collectionFailures: [],
    ...over,
  });
  const verdictOf = (res, id) => res.items.find((i) => i.id === id).verdict;

  // 1. chapter present passes; absent fails.
  assert.equal(verdictOf(resolveChecklist(base, ev()), "guard"), PASS);
  assert.equal(verdictOf(resolveChecklist(base, ev({ chapters: [] })), "guard"), FAIL);

  // 2. a chapter reached later than its declared budget fails.
  const timed = { items: [{ id: "t", claim: "fast", falsifiedBy: "slow", check: { type: "chapter", match: "verdict page", withinS: 5 } }] };
  assert.equal(verdictOf(resolveChecklist(timed, ev()), "t"), FAIL);

  // 3. THE FALSE-CLEAN RULE: an unread channel must never produce a PASS.
  const poisoned = resolveChecklist(base, ev({ collectionFailures: [{ channel: "console", reason: "ETIMEDOUT" }] }));
  assert.equal(verdictOf(poisoned, "dependent"), UNJUDGEABLE);
  assert.match(poisoned.items.find((i) => i.id === "dependent").why, /could not be read/);

  // 4. clean absence passes; a real hit fails.
  assert.equal(verdictOf(resolveChecklist(base, ev()), "dependent"), PASS);
  assert.equal(
    verdictOf(resolveChecklist(base, ev({ console: [{ t: 3, level: "error", message: "boom" }] })), "dependent"),
    FAIL,
  );

  // 5. A BROKEN GUARD POISONS ITS DEPENDENTS — and as UNJUDGEABLE, never FAIL.
  const guardFailed = resolveChecklist(base, ev({ chapters: [] }));
  assert.equal(verdictOf(guardFailed, "guard"), FAIL);
  assert.equal(verdictOf(guardFailed, "dependent"), UNJUDGEABLE);
  assert.match(guardFailed.items.find((i) => i.id === "dependent").why, /never exercised/);

  // 6. manual is always UNJUDGEABLE, and carries the timestamp to watch.
  const withVisual = resolveChecklist(base, ev());
  assert.equal(verdictOf(withVisual, "visual"), UNJUDGEABLE);
  assert.equal(withVisual.items.find((i) => i.id === "visual").at, 20);
  // Even with a clean run and a matching chapter, it must not drift into PASS.
  assert.notEqual(verdictOf(withVisual, "visual"), PASS);

  // 7. load-time contracts.
  assert.throws(() => loadChecklist({ items: [{ id: "a", claim: "c", check: { type: "manual" } }] }), /falsifiedBy/);
  assert.throws(
    () => loadChecklist({ items: [{ id: "a", claim: "c", falsifiedBy: "x", dependsOn: ["later"], check: { type: "manual" } }] }),
    /declared ABOVE/,
  );
  assert.throws(() => loadChecklist({ items: [{ id: "a", claim: "c", falsifiedBy: "x", check: { type: "vibes" } }] }), /unknown check type/);
  assert.throws(() => loadChecklist({ items: [] }), /non-empty/);

  // 8. a FAIL anywhere is what the exit code keys on; UNJUDGEABLE alone is not a failure.
  assert.equal(resolveChecklist(base, ev()).summary.fail, 0);
  assert.ok(resolveChecklist(base, ev()).summary.unjudgeable >= 1);

  // 9. SNAPSHOT CONTENT CHECKS — the ones that turn "a human must look" into a
  //    decided verdict. These are string assertions over a tree the loop already
  //    holds; the first version of this file had none, so they get real cover.
  const snapList = {
    items: [
      { id: "has", claim: "case number on screen", falsifiedBy: "placeholder", check: { type: "snapshotContains", match: "CASE NO\\. JM-" } },
      { id: "hasnt", claim: "no SaaS register", falsifiedBy: "quota copy", check: { type: "snapshotAbsent", match: "quota exceeded" } },
      { id: "scoped", claim: "offer visible at the offer chapter", falsifiedBy: "absent there", check: { type: "snapshotContains", match: "chambers", at: "offered" } },
    ],
  };
  const withSnaps = (snaps) => ({ ...ev(), snapshots: snaps });
  let r = resolveChecklist(snapList, withSnaps([
    { t: 3, label: "offered", text: "Take it in chambers" },
    { t: 9, label: "verdict", text: "CASE NO. JM-ABC123" },
  ]));
  assert.equal(verdictOf(r, "has"), PASS);
  assert.equal(verdictOf(r, "hasnt"), PASS);
  assert.equal(verdictOf(r, "scoped"), PASS);

  // present-when-it-must-not-be is a FAIL, not a pass-by-silence
  r = resolveChecklist(snapList, withSnaps([{ t: 1, label: "x", text: "your quota exceeded, upgrade to Pro" }]));
  assert.equal(verdictOf(r, "hasnt"), FAIL);
  assert.equal(verdictOf(r, "has"), FAIL);

  // NOTHING CAPTURED IS NOT NOTHING PRESENT — with no snapshots, both
  // directions must withhold rather than invent a verdict.
  r = resolveChecklist(snapList, withSnaps([]));
  assert.equal(verdictOf(r, "has"), UNJUDGEABLE);
  assert.equal(verdictOf(r, "hasnt"), UNJUDGEABLE);

  // a scoped check whose chapter never happened is UNJUDGEABLE, not FAIL
  r = resolveChecklist(snapList, withSnaps([{ t: 1, label: "somewhere-else", text: "chambers" }]));
  assert.equal(verdictOf(r, "scoped"), UNJUDGEABLE);

  // an unreadable snapshot channel poisons the ABSENCE direction
  r = resolveChecklist(snapList, {
    ...withSnaps([{ t: 1, label: "x", text: "nothing" }]),
    collectionFailures: [{ channel: "snapshot", reason: "ETIMEDOUT" }],
  });
  assert.equal(verdictOf(r, "hasnt"), UNJUDGEABLE);

  // 10. `extends` composition — base items come first, and a task item with the
  //     same id REPLACES the base one rather than duplicating it.
  const files = {
    "/c/task.json": JSON.stringify({
      name: "task", extends: "_base",
      items: [
        { id: "base-no-console-errors", claim: "overridden", falsifiedBy: "x", check: { type: "manual" } },
        { id: "task-only", claim: "task", falsifiedBy: "y", check: { type: "manual" } },
      ],
    }),
    "/c/_base.json": JSON.stringify({
      name: "base",
      items: [
        { id: "base-no-console-errors", claim: "from base", falsifiedBy: "x", check: { type: "noConsoleError" } },
        { id: "base-no-page-errors", claim: "from base", falsifiedBy: "x", check: { type: "noPageError" } },
      ],
    }),
  };
  const merged = loadChecklistFile("/c/task.json", {
    readFile: (p) => files[p],
    resolvePath: (_from, ext) => `/c/${ext}.json`,
  });
  assert.deepEqual(merged.items.map((i) => i.id), ["base-no-page-errors", "base-no-console-errors", "task-only"]);
  assert.equal(merged.items.find((i) => i.id === "base-no-console-errors").claim, "overridden");

  console.log("[check-checklist] selftest OK");
  process.exit(0);
}

const checklistPath = opt("checklist");
const tape = opt("tape");
const evidencePath = opt("evidence") ?? (tape ? `${resolve(tape)}.evidence.json` : null);
if (!checklistPath || !evidencePath) {
  console.error("required: --checklist <file.json> and one of --tape <path.webm> / --evidence <file.json>");
  process.exit(2);
}

let checklist;
let evidence;
try {
  checklist = loadChecklistFile(checklistPath);
  evidence = JSON.parse(readFileSync(evidencePath, "utf-8"));
} catch (e) {
  console.error(`[check-checklist] FAILED to load: ${e?.message ?? e}`);
  process.exit(2);
}

const resolved = resolveChecklist(checklist, evidence);
for (const line of formatVerdict(resolved)) console.log(line);

const outPath = opt("out") ?? `${evidencePath.replace(/\.evidence\.json$/, "")}.verdict.md`;
writeFileSync(outPath, formatVerdictMarkdown(resolved, { tape: tape ?? undefined }), "utf-8");
console.log(`[check-checklist] verdict: ${outPath}`);

process.exit(resolved.summary.fail > 0 ? 1 : 0);
