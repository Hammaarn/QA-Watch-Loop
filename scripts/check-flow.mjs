#!/usr/bin/env node
/**
 * check-flow.mjs — the flow loader's own checks.
 *
 * These exist mostly for ONE thing: credentials. `${VAR}` interpolation is the
 * mechanism that keeps a password out of a committed flow file, and a security
 * path gets a runnable check even when the logic looks obvious (shipping-quality
 * #30's calibrated middle — one check, not a harness).
 *
 * Usage:  node scripts/check-flow.mjs --selftest
 *         node scripts/check-flow.mjs <flow.json>    # validate + dry-run a file
 */
import { readFileSync } from "node:fs";
import { hasInterpolation, interpolate, loadFlow, resolveRef, runFlow } from "./lib/flow.mjs";

if (process.argv.includes("--selftest")) {
  const { strict: assert } = await import("node:assert");
  const env = { JM_USER: "erik@example.com", JM_PASS: "hunter2", EMPTY: "" };

  // 1. Interpolation resolves from the environment, not from the file.
  assert.equal(interpolate("${JM_USER}", env), "erik@example.com");
  assert.equal(interpolate("pre-${JM_PASS}-post", env), "pre-hunter2-post");
  assert.equal(interpolate("no vars here", env), "no vars here");
  assert.equal(interpolate(42, env), 42);

  // 2. A MISSING VARIABLE IS A HARD ERROR, never an empty string. Filling a login
  //    form with "" produces a run that looks like it exercised the auth path,
  //    dies on a validation message, and reports whatever it found after.
  assert.throws(() => interpolate("${NOPE}", env), /NOPE.*unset or empty/);
  assert.throws(() => interpolate("${EMPTY}", env), /unset or empty/);

  // 3. `requires` is checked at LOAD, before the browser opens.
  assert.throws(
    () => loadFlow({ name: "f", requires: ["NOPE"], steps: [{ do: "press", key: "Enter" }] }, { env }),
    /requires environment variable NOPE/,
  );
  assert.doesNotThrow(() =>
    loadFlow({ name: "f", requires: ["JM_PASS"], steps: [{ do: "press", key: "Enter" }] }, { env }));

  // 4. Values are resolved at load, and the step remembers it came from the
  //    environment so the runner can label it without printing the secret.
  const f = loadFlow(
    { name: "login", steps: [{ do: "fill", match: "Password", value: "${JM_PASS}" }] },
    { env },
  );
  assert.equal(f.steps[0].value, "hunter2");
  assert.equal(f.steps[0].valueFromEnv, true);
  assert.equal(hasInterpolation("${X}"), true);
  assert.equal(hasInterpolation("plain"), false);

  // 5. THE ONE THAT MATTERS: the secret must not reach a chapter label, because
  //    chapters land in the evidence JSON, the verdict table and pasted reports.
  const marks = [];
  const logs = [];
  await runFlow(f, {
    ab: () => {},
    abOut: () => `- textbox "Password" [ref=e7]`,
    sleep: async () => {},
    mark: (event, detail) => marks.push(`${event} ${detail ?? ""}`),
    collect: () => {},
    log: (m) => logs.push(m),
  });
  const emitted = [...marks, ...logs].join("\n");
  assert.ok(!emitted.includes("hunter2"), `secret leaked into output:\n${emitted}`);
  assert.ok(emitted.includes("(from env)"), "an env-sourced fill should say so");

  // 6. An unresolvable step is a HARD failure — a flow that quietly skips a click
  //    still produces a tape, and that tape shows a flow that never ran.
  await assert.rejects(
    runFlow(
      { steps: [{ do: "click", match: "Nonexistent" }] },
      { ab: () => {}, abOut: () => "- button \"Other\" [ref=e1]", sleep: async () => {}, mark: () => {}, collect: () => {}, log: () => {} },
    ),
    /no element matching/,
  );

  // 7. Ref resolution is on-screen TEXT, never a pinned ref.
  assert.equal(resolveRef('- button "SUBMIT" [ref=e14]', "submit"), "e14");
  assert.equal(resolveRef('- button "SUBMIT" [ref=e14]', "missing"), null);

  console.log("[check-flow] selftest OK");
  process.exit(0);
}

const file = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (!file) {
  console.error("usage: check-flow.mjs <flow.json> | --selftest");
  process.exit(2);
}
try {
  const flow = loadFlow(readFileSync(file, "utf-8"));
  console.log(`[check-flow] ${flow.name ?? file}: ${flow.steps.length} steps, contracts OK`);
  for (const [i, s] of flow.steps.entries()) {
    console.log(`  ${String(i + 1).padStart(2)}. ${s.do.padEnd(14)} ${s.match ?? s.key ?? s.dir ?? ""}${s.valueFromEnv ? "  <- from env" : ""}`);
  }
} catch (e) {
  console.error(`[check-flow] INVALID: ${e?.message ?? e}`);
  process.exit(1);
}
