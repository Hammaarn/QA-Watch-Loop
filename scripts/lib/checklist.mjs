/**
 * checklist.mjs — resolve a Phase 0 checklist against a run's evidence.
 *
 * WHY THIS EXISTS. Phase 0 says: write down what the tape must prove or falsify
 * BEFORE recording. That worked, but the checklist was prose and *I* resolved it
 * — I read the evidence, I decided each verdict, I wrote the table. The
 * discipline lived in the operator, which means it degrades exactly when
 * attention does, and "looks fine" creeps back in through the side door.
 *
 * This makes the checklist a FILE and the resolution a function. What the
 * machine can decide, it decides. What it cannot, it says so — loudly, by name,
 * with a timestamp to aim the human pass at.
 *
 * THE ONE RULE THAT MATTERS: this must never invent a PASS.
 *
 * Everything below follows from it:
 *
 *   - Three verdicts, and UNJUDGEABLE is first-class. It is not a soft failure
 *     and it never gates. A checklist that can only say PASS/FAIL will lie on
 *     every item it had no evidence for, and those are the items that matter.
 *
 *   - Only checks with actual evidence behind them may PASS or FAIL. A visual
 *     claim ("the band rendered") is `manual` — permanently UNJUDGEABLE here,
 *     because pixels are not in this file's reach. It still earns its place: it
 *     carries the chapter to jump to, so the watch pass is aimed rather than
 *     guessed.
 *
 *   - AN UNREAD CHANNEL IS NOT AN EMPTY CHANNEL. If the collector failed to read
 *     console/errors/network, every absence-based check becomes UNJUDGEABLE
 *     rather than PASS. This is the S#259 FALSE CLEAN bug — a channel that could
 *     not be read was reported as one with nothing in it — promoted from a bug
 *     fixed once into a rule the resolver cannot forget.
 *
 *   - A FAILED GUARD POISONS WHAT DEPENDS ON IT. If the VM path never engaged,
 *     "the teardown works" is not FALSE, it is UNTESTED, and recording it as a
 *     failure is as wrong as recording it as a pass. Dependents go UNJUDGEABLE.
 *
 *   - EVERY ITEM MUST DECLARE ITS FALSIFIER. An item with no `falsifiedBy` is
 *     rejected at load. If you cannot say what would disprove it, you have
 *     written a hope, not a checklist item — and that is the exact failure Phase
 *     0 exists to prevent.
 */

import { readFileSync as nodeReadFileSync } from "node:fs";
import { dirname as nodeDirname, resolve as nodeResolve } from "node:path";

/** Case-insensitive regex, same convention as flow.mjs's `waitFor`. */
const re = (pattern) => new RegExp(pattern, "i");

export const PASS = "PASS";
export const FAIL = "FAIL";
export const UNJUDGEABLE = "UNJUDGEABLE";
/**
 * Declared not to apply to THIS pass — see `passes` on an item.
 *
 * It is deliberately NOT a fourth flavour of unjudgeable. UNJUDGEABLE means "this
 * still needs a human", and it is the number the operator works through; folding
 * scoped-out items into it would inflate that number with work that does not
 * exist and blunt the one signal Phase 3 runs on. N/A means "nobody should look
 * at this here", so it is counted separately and never gates.
 */
export const NOT_APPLICABLE = "N/A";

/**
 * Checks that read the *absence* of something. These are the ones a failed
 * collection silently turns into false good news, so they are named in one
 * place rather than tested for ad hoc.
 */
const ABSENCE_CHECKS = new Set(["noConsoleError", "noPageError", "noFailedRequest", "snapshotAbsent"]);

const KNOWN_CHECKS = new Set([...ABSENCE_CHECKS, "chapter", "snapshotContains", "manual"]);

/**
 * Load a checklist FILE, resolving `extends` against a shared base.
 *
 * WHY: every checklist re-declared the same three items — no console errors, no
 * page errors, no failed requests. Re-typing a universal check per task is how
 * one of them quietly gets left out of the file where it mattered, and it makes
 * a checklist read as bespoke when most of it is not. So the universals live in
 * ONE file and a task checklist declares only what is task-specific.
 *
 * Base items come FIRST so they can guard task items, and a task item may
 * OVERRIDE a base one by reusing its id — the task always wins, since the whole
 * point of a base is to be a sensible default rather than a straitjacket.
 */
export function loadChecklistFile(path, { readFile, resolvePath } = {}) {
  const read = readFile ?? ((p) => nodeReadFileSync(p, "utf-8"));
  const list = JSON.parse(read(path));
  if (!list.extends) return loadChecklist(list);

  const basePath = resolvePath
    ? resolvePath(path, list.extends)
    : nodeResolve(nodeDirname(path), list.extends.endsWith(".json") ? list.extends : `${list.extends}.json`);
  const base = JSON.parse(read(basePath));

  const overridden = new Set((list.items ?? []).map((i) => i.id));
  const merged = [...(base.items ?? []).filter((i) => !overridden.has(i.id)), ...(list.items ?? [])];
  return loadChecklist({ ...list, items: merged, extends: undefined });
}

export function loadChecklist(json) {
  const list = typeof json === "string" ? JSON.parse(json) : json;
  if (!Array.isArray(list?.items) || list.items.length === 0) {
    throw new Error("checklist needs a non-empty `items` array");
  }

  const seen = new Set();
  for (const [i, item] of list.items.entries()) {
    const where = `item ${i + 1}${item.id ? ` (${item.id})` : ""}`;
    if (!item.id) throw new Error(`${where}: every item needs an \`id\``);
    if (seen.has(item.id)) throw new Error(`${where}: duplicate id`);
    if (!item.claim) throw new Error(`${where}: every item needs a \`claim\``);

    // The Phase 0 doctrine, enforced rather than encouraged.
    if (!item.falsifiedBy) {
      throw new Error(
        `${where}: every item needs \`falsifiedBy\` — if you cannot say what would ` +
          "disprove this, it is not a checklist item",
      );
    }

    // Pass scoping. A responsive app legitimately hides the sidebar on a phone,
    // so "the sidebar is visible" must not become a FAIL there — a check that is
    // wrong by design on one pass is worse than no check, because it trains the
    // operator to skim past red.
    if (item.passes !== undefined) {
      if (!Array.isArray(item.passes) || item.passes.length === 0 || item.passes.some((p) => typeof p !== "string")) {
        throw new Error(`${where}: \`passes\` must be a non-empty array of pass names`);
      }
    }

    const type = item.check?.type;
    if (!KNOWN_CHECKS.has(type)) {
      throw new Error(`${where}: unknown check type ${JSON.stringify(type)} (known: ${[...KNOWN_CHECKS].join(", ")})`);
    }
    if (type === "chapter" && !item.check.match) {
      throw new Error(`${where}: a chapter check needs \`match\``);
    }
    if ((type === "snapshotContains" || type === "snapshotAbsent") && !item.check.match) {
      throw new Error(`${where}: a ${type} check needs \`match\``);
    }

    // Guards must be declared before what they guard. This keeps resolution a
    // single forward pass and makes a dependency cycle unrepresentable rather
    // than something to detect at runtime.
    for (const dep of item.dependsOn ?? []) {
      if (!seen.has(dep)) {
        throw new Error(`${where}: dependsOn "${dep}" is not an item declared ABOVE this one`);
      }
    }
    seen.add(item.id);
  }
  return list;
}

/**
 * Resolve every item against one evidence report (the `<tape>.evidence.json`
 * written by record-loop).
 *
 * Returns verdicts only — printing and exit codes live in the CLI, so this
 * stays testable with plain objects and no I/O.
 */
export function resolveChecklist(checklist, evidence, { pass = null } = {}) {
  const chapters = evidence?.chapters ?? [];
  const consoleErrors = (evidence?.console ?? []).filter((c) => c.level === "error");
  const pageErrors = evidence?.pageErrors ?? [];
  const failedRequests = evidence?.failedRequests ?? [];
  const collectionFailures = evidence?.collectionFailures ?? [];
  // Accessibility snapshots captured at each chapter (deduped). This is what
  // lets a content claim be DECIDED rather than handed to a human — the first
  // version of this file had no such check, so "the verdict shows a real case
  // number, not the placeholder" was filed as a visual judgement when it is a
  // string assertion over a tree the loop was already holding.
  const snapshots = evidence?.snapshots ?? [];

  /** `flow charges + receipts in frame` — event and detail searched as one line. */
  const chapterText = (c) => `${c.event ?? ""} ${c.detail ?? ""}`.trim();
  const findChapter = (pattern) => chapters.find((c) => re(pattern).test(chapterText(c)));

  const verdicts = new Map();
  const results = [];

  for (const item of checklist.items) {
    const result = {
      id: item.id,
      claim: item.claim,
      falsifiedBy: item.falsifiedBy,
      verdict: UNJUDGEABLE,
      why: "",
      at: null,
    };

    // Scoped out of this pass. Checked BEFORE guards: an item that does not
    // apply here should read as out-of-scope, not as blocked by a guard that
    // also did not apply.
    if (pass && Array.isArray(item.passes) && !item.passes.includes(pass)) {
      result.verdict = NOT_APPLICABLE;
      result.why = `not declared for pass "${pass}" (applies to: ${item.passes.join(", ")})`;
      verdicts.set(item.id, result.verdict);
      results.push(result);
      continue;
    }

    // A guard that did not hold makes its dependents UNTESTED, not false. This
    // covers a guard that was N/A on this pass too — a claim resting on
    // something never exercised here is untested, whatever the reason.
    const brokenGuard = (item.dependsOn ?? []).find((d) => verdicts.get(d) !== PASS);
    if (brokenGuard) {
      result.verdict = UNJUDGEABLE;
      result.why = `guard "${brokenGuard}" did not pass — this claim was never exercised`;
      verdicts.set(item.id, result.verdict);
      results.push(result);
      continue;
    }

    const { type, match, matching } = item.check;

    // An unread channel is not an empty one.
    if (ABSENCE_CHECKS.has(type) && collectionFailures.length > 0) {
      result.verdict = UNJUDGEABLE;
      result.why =
        `${collectionFailures.length} evidence channel(s) could not be read ` +
        `(${collectionFailures.map((f) => f.channel).join(", ")}) — absence of findings proves nothing here`;
      verdicts.set(item.id, result.verdict);
      results.push(result);
      continue;
    }

    switch (type) {
      case "chapter": {
        const hit = findChapter(match);
        if (!hit) {
          result.verdict = FAIL;
          result.why = `no chapter matching /${match}/i — the run never reached this point`;
          break;
        }
        if (item.check.withinS != null && hit.t > item.check.withinS) {
          result.verdict = FAIL;
          result.why = `reached at +${hit.t}s, later than the declared budget of ${item.check.withinS}s`;
          result.at = hit.t;
          break;
        }
        result.verdict = PASS;
        result.why = `chapter "${chapterText(hit)}" at +${hit.t}s`;
        result.at = hit.t;
        break;
      }

      case "noConsoleError":
      case "noPageError":
      case "noFailedRequest": {
        const pool =
          type === "noConsoleError" ? consoleErrors : type === "noPageError" ? pageErrors : failedRequests;
        const describe = (h) =>
          type === "noFailedRequest" ? `${h.status} ${h.method} ${h.url}` : h.message ?? "";
        const hits = matching ? pool.filter((h) => re(matching).test(describe(h))) : pool;
        if (hits.length > 0) {
          result.verdict = FAIL;
          result.why = `${hits.length} hit(s), first at +${hits[0].t}s: ${describe(hits[0]).slice(0, 120)}`;
          result.at = hits[0].t;
        } else {
          result.verdict = PASS;
          result.why = matching ? `no match for /${matching}/i across ${pool.length} entr(ies)` : "none recorded";
        }
        break;
      }

      case "snapshotContains":
      case "snapshotAbsent": {
        // NOTHING CAPTURED IS NOT NOTHING PRESENT. With no snapshots there is
        // no evidence either way, so both directions are UNJUDGEABLE — the
        // absent-channel rule applied to presence as well, because "we never
        // looked" must never read as "we looked and it was fine".
        if (snapshots.length === 0) {
          result.verdict = UNJUDGEABLE;
          result.why = "no accessibility snapshots were captured — nothing to search";
          break;
        }
        const scope = item.check.at
          ? snapshots.filter((s) => re(item.check.at).test(s.label ?? ""))
          : snapshots;
        if (scope.length === 0) {
          result.verdict = UNJUDGEABLE;
          result.why = `no snapshot captured at a chapter matching /${item.check.at}/i — that moment was never reached`;
          break;
        }
        const hit = scope.find((s) => re(match).test(s.text ?? ""));
        const where = item.check.at ? ` at /${item.check.at}/i` : "";
        if (type === "snapshotContains") {
          result.verdict = hit ? PASS : FAIL;
          result.at = hit?.t ?? null;
          result.why = hit
            ? `found on screen at +${hit.t}s ("${hit.label ?? "?"}")`
            : `never on screen${where} across ${scope.length} snapshot(s)`;
        } else {
          result.verdict = hit ? FAIL : PASS;
          result.at = hit?.t ?? null;
          result.why = hit
            ? `present at +${hit.t}s ("${hit.label ?? "?"}") — it must not be`
            : `absent${where} across ${scope.length} snapshot(s)`;
        }
        break;
      }

      case "manual": {
        // Never PASS, never FAIL. Its whole job is to aim the judging pass.
        //
        // `judgeBy` names the channel, because not every un-machine-decidable
        // claim is a visual one. Two of the four claims this file was built
        // against lived in Vercel runtime logs — a tape cannot see a teardown
        // log line, and calling that item "visual" would send the next reader
        // hunting for it in frames it can never appear in.
        const hit = item.watch ? findChapter(item.watch) : null;
        const channel = item.judgeBy ?? "the tape";
        result.verdict = UNJUDGEABLE;
        result.judgeBy = channel;
        result.at = hit?.t ?? null;
        result.why = hit
          ? `judge on ${channel} — at +${hit.t}s ("${chapterText(hit)}")`
          : item.watch
            ? `judge on ${channel} — chapter /${item.watch}/i never fired, so the moment to judge was never reached`
            : `judge on ${channel}`;
        break;
      }
    }

    verdicts.set(item.id, result.verdict);
    results.push(result);
  }

  const count = (v) => results.filter((r) => r.verdict === v).length;
  return {
    name: checklist.name ?? null,
    ...(pass ? { pass } : {}),
    items: results,
    summary: {
      pass: count(PASS),
      fail: count(FAIL),
      unjudgeable: count(UNJUDGEABLE),
      // Kept out of the other three on purpose — see NOT_APPLICABLE. `total`
      // stays the item count so the numbers still reconcile against the file.
      notApplicable: count(NOT_APPLICABLE),
      total: results.length,
      collectionFailures: collectionFailures.length,
    },
  };
}

/** Human-facing verdict table. The loop gates FUNCTION; a human gates TASTE. */
export function formatVerdict(resolved) {
  const out = [];
  const s = resolved.summary;
  out.push(
    `[checklist] ${resolved.name ?? "checklist"}${resolved.pass ? ` [${resolved.pass}]` : ""} — ` +
      `${s.pass} PASS · ${s.fail} FAIL · ${s.unjudgeable} UNJUDGEABLE` +
      (s.notApplicable ? ` · ${s.notApplicable} N/A` : ""),
  );

  if (s.collectionFailures > 0) {
    out.push(
      `[checklist] ⚠ ${s.collectionFailures} evidence channel(s) unreadable — absence-based items were ` +
        "withheld rather than passed",
    );
  }

  for (const r of resolved.items) {
    const at = r.at == null ? "" : ` +${r.at}s`;
    out.push(`[checklist]   ${r.verdict.padEnd(11)}${at.padStart(6)}  ${r.claim}`);
    out.push(`[checklist]   ${" ".repeat(11)}${" ".repeat(6)}  ↳ ${r.why}`);
  }

  if (s.unjudgeable > 0) {
    // Name the channels rather than saying "the tape" — some of these live in
    // server logs, and sending the reader to look for them in frames wastes the
    // one pass this line exists to aim.
    const channels = [...new Set(
      resolved.items.filter((r) => r.verdict === UNJUDGEABLE && r.judgeBy).map((r) => r.judgeBy),
    )];
    out.push(
      `[checklist] ${s.unjudgeable} item(s) still need a human — they are NOT passes, and the run is ` +
        `not verified until someone looks${channels.length ? ` (${channels.join(", ")})` : ""}`,
    );
  }
  return out;
}

/** Markdown for the QA report — same content, pasteable into Phase 3. */
export function formatVerdictMarkdown(resolved, { tape } = {}) {
  const s = resolved.summary;
  // `null` marks a line that does not apply; "" is a REAL blank line. Filtering
  // on "" (the obvious shortcut) also eats the blank line a markdown table needs
  // in front of it, and the table then renders as a wall of pipes.
  const lines = [
    `# Checklist verdict — ${resolved.name ?? "unnamed"}${resolved.pass ? ` (pass: ${resolved.pass})` : ""}`,
    "",
    `**${s.pass} PASS · ${s.fail} FAIL · ${s.unjudgeable} UNJUDGEABLE${
      s.notApplicable ? ` · ${s.notApplicable} N/A` : ""
    }** of ${s.total}.`,
    "",
    tape ? `**Tape:** \`${tape}\`` : null,
    tape ? "" : null,
    s.collectionFailures > 0
      ? `> ⚠ ${s.collectionFailures} evidence channel(s) could not be read. Absence-based items were withheld, not passed.`
      : null,
    s.collectionFailures > 0 ? "" : null,
    "| Verdict | At | Claim | Judge by | Why | Would be falsified by |",
    "|---|---|---|---|---|---|",
  ];
  for (const r of resolved.items) {
    const at = r.at == null ? "—" : `+${r.at}s`;
    lines.push(`| **${r.verdict}** | ${at} | ${r.claim} | ${r.judgeBy ?? "—"} | ${r.why} | ${r.falsifiedBy} |`);
  }
  if (s.unjudgeable > 0) {
    lines.push(
      "",
      "UNJUDGEABLE is a real verdict, not a soft pass — these items were not exercised, not machine-" +
        "decidable, or live in a channel this resolver cannot read. The **Judge by** column says where to " +
        "look; the run is not verified until someone does.",
    );
  }
  return lines.filter((l) => l !== null).join("\n") + "\n";
}
