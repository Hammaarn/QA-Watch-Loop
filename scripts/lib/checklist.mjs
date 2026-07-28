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

/** Case-insensitive regex, same convention as flow.mjs's `waitFor`. */
const re = (pattern) => new RegExp(pattern, "i");

export const PASS = "PASS";
export const FAIL = "FAIL";
export const UNJUDGEABLE = "UNJUDGEABLE";

/**
 * Checks that read the *absence* of something. These are the ones a failed
 * collection silently turns into false good news, so they are named in one
 * place rather than tested for ad hoc.
 */
const ABSENCE_CHECKS = new Set(["noConsoleError", "noPageError", "noFailedRequest"]);

const KNOWN_CHECKS = new Set([...ABSENCE_CHECKS, "chapter", "manual"]);

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

    const type = item.check?.type;
    if (!KNOWN_CHECKS.has(type)) {
      throw new Error(`${where}: unknown check type ${JSON.stringify(type)} (known: ${[...KNOWN_CHECKS].join(", ")})`);
    }
    if (type === "chapter" && !item.check.match) {
      throw new Error(`${where}: a chapter check needs \`match\``);
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
export function resolveChecklist(checklist, evidence) {
  const chapters = evidence?.chapters ?? [];
  const consoleErrors = (evidence?.console ?? []).filter((c) => c.level === "error");
  const pageErrors = evidence?.pageErrors ?? [];
  const failedRequests = evidence?.failedRequests ?? [];
  const collectionFailures = evidence?.collectionFailures ?? [];

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

    // A guard that did not hold makes its dependents UNTESTED, not false.
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
    items: results,
    summary: {
      pass: count(PASS),
      fail: count(FAIL),
      unjudgeable: count(UNJUDGEABLE),
      total: results.length,
      collectionFailures: collectionFailures.length,
    },
  };
}

/** Human-facing verdict table. The loop gates FUNCTION; a human gates TASTE. */
export function formatVerdict(resolved) {
  const out = [];
  const s = resolved.summary;
  out.push(`[checklist] ${resolved.name ?? "checklist"} — ${s.pass} PASS · ${s.fail} FAIL · ${s.unjudgeable} UNJUDGEABLE`);

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
    `# Checklist verdict — ${resolved.name ?? "unnamed"}`,
    "",
    `**${s.pass} PASS · ${s.fail} FAIL · ${s.unjudgeable} UNJUDGEABLE** of ${s.total}.`,
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
