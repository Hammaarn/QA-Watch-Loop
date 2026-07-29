/**
 * passes.mjs — the same flow, run under more than one viewport/device.
 *
 * WHY THIS EXISTS. Every SKILL.md report has carried the same standing limit:
 * "Desktop-width recording overstates zoom-out vs mobile; mobile framing needs
 * its own loop." That sentence was true and useless — it named a gap and left
 * the operator to close it by hand, which means it never got closed. Mobile was
 * a second command with a second output path and no relationship to the first,
 * so the one thing worth knowing (does this item behave DIFFERENTLY on a phone?)
 * was never computed by anything.
 *
 * A pass is a named browser configuration. The loop runs the flow once per pass
 * and then compares the verdicts ACROSS passes.
 *
 * REAL EMULATION, NOT A NARROW WINDOW. agent-browser exposes Playwright's device
 * descriptors via `set device "<name>"`, which carries viewport, deviceScaleFactor,
 * userAgent, isMobile and hasTouch together. That distinction is load-bearing: a
 * 390px-wide desktop Chrome still reports a desktop UA, still has no touch, and
 * still gets hover styles — so a layout that only breaks under a real mobile UA,
 * or a tap handler that never fires without touch, passes a narrow-window test
 * and fails on the phone. Calling that "mobile tested" would be exactly the
 * precise-and-wrong result that is worse than no result at all. So device passes
 * use `set device`, and a bare `WxH` pass is honestly labelled a viewport pass.
 *
 * THE BROWSER IS FULLY CLOSED BETWEEN PASSES. Emulation is context-level state;
 * reusing a context would leak the phone's UA and touch flags into the desktop
 * pass and quietly make both passes measure the same thing.
 */

/**
 * Named profiles. Device names must be strings Playwright knows — agent-browser
 * passes them straight through, and an unknown name fails loudly at `set device`
 * rather than silently falling back to desktop.
 */
export const PROFILES = {
  // Viewport passes: honest about being a resize, not a device.
  desktop: { kind: "viewport", w: 1280, h: 900, label: "desktop 1280x900" },
  "desktop-hd": { kind: "viewport", w: 1920, h: 1080, scale: 2, label: "desktop 1920x1080@2x" },
  laptop: { kind: "viewport", w: 1440, h: 900, label: "laptop 1440x900" },

  // Device passes: real emulation (UA + touch + DPR + viewport).
  "iphone-12": { kind: "device", device: "iPhone 12", label: "iPhone 12" },
  "iphone-se": { kind: "device", device: "iPhone SE", label: "iPhone SE (small)" },
  "pixel-5": { kind: "device", device: "Pixel 5", label: "Pixel 5" },
  ipad: { kind: "device", device: "iPad (gen 7)", label: "iPad" },
};

/** `mobile` is the one alias worth having — it means "the phone we test on". */
PROFILES.mobile = PROFILES["iphone-12"];

/**
 * Parse one pass token into a profile.
 *
 * Accepted forms:
 *   desktop            a named profile from PROFILES
 *   1280x900           an ad-hoc viewport pass
 *   1280x900@2         ... with a deviceScaleFactor
 *   device:iPhone 12   an ad-hoc device pass (any Playwright descriptor)
 *
 * An unrecognised token throws. Silently skipping a pass the operator asked for
 * would produce a report that looks like it covered mobile and did not.
 */
export function parsePass(token) {
  const t = String(token).trim();
  if (!t) throw new Error("empty pass name");

  if (PROFILES[t.toLowerCase()]) {
    const p = PROFILES[t.toLowerCase()];
    return { name: t.toLowerCase(), ...p };
  }

  if (t.toLowerCase().startsWith("device:")) {
    const device = t.slice("device:".length).trim();
    if (!device) throw new Error(`pass "${t}": device: needs a name`);
    return { name: slug(device), kind: "device", device, label: device };
  }

  const m = t.match(/^(\d+)x(\d+)(?:@(\d+(?:\.\d+)?))?$/i);
  if (m) {
    const [, w, h, scale] = m;
    return {
      name: slug(t),
      kind: "viewport",
      w: Number(w),
      h: Number(h),
      ...(scale ? { scale: Number(scale) } : {}),
      label: `viewport ${w}x${h}${scale ? `@${scale}x` : ""}`,
    };
  }

  throw new Error(
    `unknown pass ${JSON.stringify(t)} — use a profile name (${Object.keys(PROFILES).join(", ")}), ` +
      `a viewport (1280x900 or 1280x900@2), or device:<Playwright device name>`,
  );
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * Resolve a `--passes` spec into the ordered pass list.
 *
 * Duplicate names are rejected rather than deduped: two passes writing the same
 * artifact paths would have the second silently overwrite the first, and a
 * comparison of a run against itself reports perfect agreement — the most
 * confidently wrong output this tool could produce.
 */
export function resolvePasses(spec, fallback) {
  if (!spec) return [fallback];
  const passes = String(spec)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parsePass);
  if (passes.length === 0) throw new Error("--passes was given but resolved to nothing");
  const seen = new Set();
  for (const p of passes) {
    if (seen.has(p.name)) throw new Error(`duplicate pass "${p.name}" — each pass needs its own artifacts`);
    seen.add(p.name);
  }
  return passes;
}

/**
 * Apply a pass to the live browser. Called AFTER `open` and BEFORE `record start`,
 * because the recording canvas is fixed at record-start.
 */
export function applyPass(pass, ab) {
  if (pass.kind === "device") {
    ab("set", "device", pass.device);
    return;
  }
  const args = ["set", "viewport", String(pass.w), String(pass.h)];
  if (pass.scale) args.push(String(pass.scale));
  ab(...args);
}

/**
 * Where a pass's artifacts go.
 *
 * A single-pass run keeps the operator's exact `--out` path — the overwhelmingly
 * common case should not grow a suffix just because a feature exists. Multi-pass
 * runs namespace by pass name so nothing collides.
 */
export function passOutPath(out, pass, multi) {
  if (!multi) return out;
  const m = String(out).match(/^(.*?)(\.[^.\/\\]+)$/);
  return m ? `${m[1]}.${pass.name}${m[2]}` : `${out}.${pass.name}`;
}

/**
 * Compare one checklist item's verdicts across passes.
 *
 * DIVERGENCE IS NOT REGRESSION. compare-runs.mjs answers "did this change over
 * TIME" — PASS then FAIL is something you broke. Across passes nothing broke and
 * nothing is older; the finding is that the same claim holds on one device and
 * not on another, which is a fact about the product, not about a change. Using
 * the regression vocabulary here would file every responsive-layout difference
 * as a regression and train the operator to ignore the word.
 *
 * Items that did not apply to a pass (N/A) are excluded — a claim deliberately
 * scoped to desktop must not be reported as diverging on mobile.
 */
export function comparePasses(results) {
  const ids = [];
  for (const r of results) for (const item of r.verdict?.items ?? []) if (!ids.includes(item.id)) ids.push(item.id);

  const rows = ids.map((id) => {
    const cells = results.map((r) => {
      const it = (r.verdict?.items ?? []).find((i) => i.id === id);
      return { pass: r.pass.name, verdict: it?.verdict ?? "ABSENT", why: it?.why ?? "" };
    });
    const claim =
      results.map((r) => (r.verdict?.items ?? []).find((i) => i.id === id)?.claim).find(Boolean) ?? id;
    const judged = cells.filter((c) => c.verdict !== "N/A");
    const verdicts = [...new Set(judged.map((c) => c.verdict))];
    return {
      id,
      claim,
      cells,
      // One distinct verdict among the passes that actually judged it = agreement.
      // Zero (every pass said N/A) is also not a divergence.
      diverged: verdicts.length > 1,
      // The case worth shouting about: it works on one device and not another.
      failsOnSome: verdicts.includes("FAIL") && verdicts.includes("PASS"),
    };
  });

  return {
    passes: results.map((r) => r.pass.name),
    rows,
    diverged: rows.filter((r) => r.diverged),
    failsOnSome: rows.filter((r) => r.failsOnSome),
  };
}

export function formatPassComparison(cmp) {
  const out = [
    `[passes] ${cmp.passes.length} passes (${cmp.passes.join(", ")}) — ` +
      `${cmp.diverged.length} item(s) differ between passes`,
  ];
  for (const r of cmp.diverged) {
    const tag = r.failsOnSome ? "BREAKS-ON" : "differs";
    out.push(`[passes]   ${tag.padEnd(10)} ${r.claim}`);
    for (const c of r.cells) out.push(`[passes]     ${c.pass.padEnd(12)} ${c.verdict.padEnd(11)} ${c.why}`.trimEnd());
  }
  if (cmp.diverged.length === 0) {
    out.push("[passes]   every item held the same verdict on every pass");
  }
  if (cmp.failsOnSome.length > 0) {
    out.push(
      `[passes] ${cmp.failsOnSome.length} item(s) PASS on one pass and FAIL on another. That is the ` +
        "whole reason to run more than one — judge these first.",
    );
  }
  return out;
}
