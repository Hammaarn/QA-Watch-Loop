/**
 * agent-browser.mjs — everything that talks to agent-browser, in one place.
 *
 * Two exports: a spawn helper that survives Windows, and an evidence collector.
 * They live together because the collector is only safe if it uses the spawn
 * helper's capture mode — see the stdio note below.
 */

import { execFileSync } from "node:child_process";

/**
 * Resolve how to invoke agent-browser.
 *
 * POSIX: the bare name is a real executable, spawned directly.
 *
 * Windows needs a shell. Measured on Node v24.12.0 / agent-browser 0.27.3:
 *   execFileSync("agent-browser", …)            ENOENT — Node cannot spawn the
 *                                               extensionless npm wrapper
 *   execFileSync("agent-browser.cmd", …)        EINVAL — Node refuses .cmd/.bat
 *                                               without a shell (CVE-2024-27980)
 *   execFileSync(node, [bin/agent-browser.js])  resolves, then HANGS on piped
 *                                               stdout (see the stdio note)
 *   shell:true                                  resolves and returns
 *
 * Node warns (DEP0190) that shell args are concatenated rather than escaped.
 * That matters for untrusted input; here every argument comes from the
 * operator's own command line. Do not feed these helpers untrusted strings.
 */
export function resolveAgentBrowser() {
  if (process.env.AGENT_BROWSER_BIN) {
    return { bin: process.env.AGENT_BROWSER_BIN, shell: false };
  }
  if (process.platform !== "win32") {
    return { bin: "agent-browser", shell: false };
  }
  return { bin: "agent-browser", shell: true };
}

/**
 * Build the command helpers for a session.
 *
 * THE STDIO RULE, which is load-bearing: a COLD `open` launches the browser
 * daemon, and the daemon inherits whatever stdout it is handed. With a PIPE it
 * holds the write end open forever, so execFileSync never sees EOF and dies at
 * the timeout. Every later command returns in ~0s because it only talks to the
 * daemon that is now running — which is exactly why this bug hides: if any
 * session happened to be alive already, the cold path never ran.
 *
 * So `ab()` discards stdout, and only `abOut()` captures. Capture is safe for
 * commands that merely query the running daemon (snapshot, console, errors,
 * network requests) and unsafe for anything that may start one.
 */
export function makeAgentBrowser({ session, timeoutMs = 120_000 } = {}) {
  const AB = resolveAgentBrowser();
  // Session goes through the ENVIRONMENT, not argv: the flag is `--session-name`
  // (not `--session`) and options come AFTER the command. An unknown flag in the
  // leading position does not error — it HANGS until the timeout.
  const env = session
    ? { ...process.env, AGENT_BROWSER_SESSION_NAME: session }
    : process.env;

  // With shell:true Node concatenates argv into one command line and does NOT
  // quote it, so any argument containing a space silently splits into two. That
  // breaks an --out path with a space in it, and makes `eval <js>` impossible.
  // Quote them ourselves. (This is also what DEP0190 warns about — we are doing
  // the escaping Node declines to do, for arguments we control.)
  const quote = (a) => {
    const s = String(a);
    if (!AB.shell) return s;
    if (s.length && !/[\s"^&|<>()%!]/.test(s)) return s;
    return `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
  };

  const run = (args, capture) =>
    execFileSync(AB.bin, args.map(quote), {
      encoding: "utf-8",
      timeout: timeoutMs,
      windowsHide: true,
      env,
      // MEASURED: `network requests` against a page that streams base64 frames
      // returned 192 MB. execFileSync's default maxBuffer is 1 MB, so Node killed
      // the child mid-write, agent-browser panicked on the closed pipe, and the
      // read came back empty — reported as "clean". A generous ceiling, and the
      // collector treats hitting it as a FAILURE rather than as no findings.
      maxBuffer: 64 * 1024 * 1024,
      stdio: capture ? ["ignore", "pipe", "inherit"] : ["ignore", "ignore", "inherit"],
      ...(AB.shell ? { shell: true } : {}),
    });

  return {
    /** Fire and forget — stdout discarded so a cold `open` cannot wedge the pipe. */
    ab: (...a) => run(a, false),
    /** Capture stdout — query-only commands. Never use for `open`. */
    abOut: (...a) => run(a, true),
    /**
     * Fully detached: not even stderr is inherited.
     *
     * For commands that leave a LONG-LIVED child behind — in practice
     * `record start`. Such a child inherits our stderr and keeps holding it
     * after we exit, so if our own output is piped anywhere (`| grep`, `| tee`,
     * a captured tool call) that pipe never sees EOF and the CALLER appears to
     * hang forever, even though this process exited 0 seconds ago. Measured:
     * `--manual | grep` looked like an infinite hang; the same command
     * redirected to a file returned in 5s.
     *
     * The cost is losing agent-browser's stderr text for this one call; the exit
     * status still propagates, so a genuine failure still throws.
     */
    abDetached: (...a) =>
      execFileSync(AB.bin, a.map(quote), {
        encoding: "utf-8",
        timeout: timeoutMs,
        windowsHide: true,
        env,
        stdio: ["ignore", "ignore", "ignore"],
        ...(AB.shell ? { shell: true } : {}),
      }),
  };
}

// ── EVIDENCE ────────────────────────────────────────────────────────────────
//
// The loop's blind spot, and why this exists: a tape is watched by a model
// looking at pixels. That is strong for taste, motion and layout, and totally
// blind to console errors, failed requests and silent no-ops. The S#258 JM run
// proved it from both sides — the tape confirmed three visual surfaces, while
// the session's worst bug (a whole feature emitting nothing) was invisible on
// video and only showed up in a persisted record.
//
// So: collect machine-checkable facts alongside the frames. Deterministic, no
// model tokens, and REPORTED rather than enforced — the verdict stays a human
// judgement, this just stops the loop from being blind to a whole class.

const CONSOLE_RE = /^\[(\w+)\]\s*(.*)$/;
// `[id] METHOD url (Type) [status]` — the status is ABSENT for a request that
// never completed (blocked, aborted, cross-origin opaque), so it is optional.
const REQUEST_RE = /^\[[^\]]*\]\s+([A-Z]+)\s+(\S+)\s+\(([^)]*)\)(?:\s+(\d+))?/;
// agent-browser prefixes its own status output with ✓ / ✗ — "✗" alone is how it
// says "nothing here". Those lines are chrome, not data, and parsing them as
// findings invents page errors that never happened.
const STATUS_GLYPH_RE = /^[✓✗]/;

export function createCollector({ abOut, ab, now = () => Date.now() }) {
  const t0 = now();
  const elapsed = () => Math.round((now() - t0) / 1000);

  const chapters = [];
  const consoleLines = [];
  const pageErrors = [];
  const requests = [];
  /** Channels that could not be read. Distinct from "read, found nothing". */
  const failures = [];

  /** Timestamped jump-point. Chapters are what make a 5-minute tape navigable. */
  const mark = (event, detail) => {
    chapters.push({ t: elapsed(), event, ...(detail ? { detail } : {}) });
  };

  /**
   * Read a buffer, then clear it — as TWO calls, deliberately.
   *
   * `--clear` is not read-and-clear. It only clears, returning
   * "✓ Console log cleared" and discarding everything unread. Draining with it
   * silently loses every entry, and the loop reports a confident zero.
   *
   * So: read bare, then clear separately, so the next sample sees only what is
   * genuinely new and each entry's timestamp means something.
   */
  const readAndClear = (cmd) => {
    let raw = "";
    try {
      raw = String(abOut(...cmd));
    } catch (e) {
      // NEVER swallow this. An unread channel is not an empty channel, and
      // reporting "0 errors (clean)" when collection actually failed is worse
      // than reporting nothing at all — it is a confident lie about the run.
      failures.push({ channel: cmd.join(" "), reason: e?.code ?? String(e?.message ?? e).slice(0, 120) });
      return [];
    }
    try {
      (ab ?? abOut)(...cmd, "--clear");
    } catch { /* clearing is best-effort; worst case we re-read next sample */ }
    return raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((l) => !STATUS_GLYPH_RE.test(l));
  };

  /**
   * Install a page-context error hook.
   *
   * MEASURED: agent-browser's own `errors` channel reports nothing for an
   * uncaught page error — it answers "✗" (none) even after a real
   * `Uncaught TypeError`, and such errors do not reach `console` either. So the
   * single most valuable QA signal is invisible to both built-ins. An injected
   * listener does see them, including unhandled promise rejections.
   *
   * Call this AFTER `record start` — starting a recording reloads the page into
   * a fresh context, which wipes the hook. A full navigation mid-flow wipes it
   * too; the built-in console channel survives navigation, so the two are
   * complementary rather than redundant. Best-effort by design: a page with a
   * CSP that blocks evaluation simply yields no hook, and the rest still works.
   */
  const installErrorHook = () => {
    try {
      abOut(
        "eval",
        "window.__qaErr=window.__qaErr||[];" +
          "if(!window.__qaErrHooked){window.__qaErrHooked=1;" +
          "addEventListener('error',function(e){window.__qaErr.push('uncaught: '+(e.message||e.type))});" +
          "addEventListener('unhandledrejection',function(e){window.__qaErr.push('unhandledrejection: '+((e.reason&&e.reason.message)||e.reason))});}" +
          "'ok'",
      );
      return true;
    } catch {
      return false;
    }
  };

  /** Read and empty the injected hook's buffer. */
  const drainHook = () => {
    let raw;
    try {
      raw = String(abOut("eval", "JSON.stringify((window.__qaErr||[]).splice(0))"));
    } catch {
      return [];
    }
    // `eval` prints a JSON-encoded value, so the array arrives double-encoded.
    try {
      const once = JSON.parse(raw.trim());
      const arr = typeof once === "string" ? JSON.parse(once) : once;
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  };

  /** Drain everything the browser has buffered since the last call. */
  const collect = () => {
    const t = elapsed();

    for (const message of drainHook()) {
      pageErrors.push({ t, message, source: "hook" });
      mark("page-error", message.slice(0, 140));
    }

    for (const line of readAndClear(["console"])) {
      const m = line.match(CONSOLE_RE);
      if (!m) continue;
      const [, level, message] = m;
      consoleLines.push({ t, level, message });
      // Warnings are recorded but do not earn a chapter — chapters are for
      // things worth jumping to, and a noisy warning stream would bury them.
      if (level === "error") mark("console-error", message.slice(0, 140));
    }

    for (const message of readAndClear(["errors"])) {
      pageErrors.push({ t, message, source: "builtin" });
      mark("page-error", message.slice(0, 140));
    }

    // FILTER TO REAL NETWORK TRAFFIC. Measured against JudgeMySite, whose live
    // show streams base64 screencast frames: the unfiltered log was 192 MB and
    // blew every buffer. Filtered to http it is 137 lines / 174 KB and instant.
    // `data:` and `blob:` URIs are inline payloads, not network activity, so
    // excluding them loses no signal — and the filter is server-side, so the
    // enormous string is never serialised in the first place.
    for (const line of readAndClear(["network", "requests", "--filter", "http"])) {
      const m = line.match(REQUEST_RE);
      if (!m) continue;
      const [, method, url, type, statusRaw] = m;
      // Absent status = the request did not complete with one: blocked, aborted,
      // cross-origin opaque, or still in flight at sample time. That last case is
      // why it does NOT earn a chapter — crying "failed" at an in-flight request
      // would make the loop noisy, and a noisy instrument gets ignored.
      const status = statusRaw === undefined ? null : Number(statusRaw);
      // A data: URI can be tens of KB; storing it whole makes the evidence file
      // unreadable and tells you nothing you could not get from the prefix.
      const shortUrl = url.length > 200 ? `${url.slice(0, 200)}…[${url.length} chars]` : url;
      requests.push({ t, method, url: shortUrl, type, status });
      if (status !== null && (status === 0 || status >= 400)) {
        mark("request-failed", `${status} ${method} ${shortUrl.slice(0, 110)}`);
      }
    }
  };

  const isFailed = (r) => r.status !== null && (r.status === 0 || r.status >= 400);
  const isIncomplete = (r) => r.status === null;

  const summary = () => ({
    consoleErrors: consoleLines.filter((c) => c.level === "error").length,
    consoleWarnings: consoleLines.filter((c) => c.level === "warning").length,
    pageErrors: pageErrors.length,
    failedRequests: requests.filter(isFailed).length,
    // Reported separately and never as a failure — see the note in collect().
    incompleteRequests: requests.filter(isIncomplete).length,
    totalRequests: requests.length,
    chapters: chapters.length,
    collectionFailures: failures.length,
  });

  const report = () => ({
    recordedAt: new Date(t0).toISOString(),
    durationSeconds: elapsed(),
    summary: summary(),
    chapters,
    collectionFailures: failures,
    console: consoleLines,
    pageErrors,
    // Only the failures are kept: a full request log is mostly noise, and the
    // point of this file is to be read.
    failedRequests: requests.filter(isFailed),
    incompleteRequests: requests.filter(isIncomplete),
  });

  return { mark, collect, summary, report, elapsed, installErrorHook };
}

/** Human-facing lines for the console. The loop reports; it does not gate. */
export function formatEvidence(report) {
  const s = report.summary;
  const out = [];
  const clean =
    s.consoleErrors === 0 && s.pageErrors === 0 && s.failedRequests === 0 &&
    s.collectionFailures === 0;

  if (s.collectionFailures > 0) {
    out.push(
      `[record-loop] ⚠ EVIDENCE INCOMPLETE — ${s.collectionFailures} channel(s) could not be read; ` +
        "the numbers below are a FLOOR, not a clean bill of health",
    );
    for (const f of report.collectionFailures ?? []) {
      out.push(`[record-loop]   channel "${f.channel}" failed: ${f.reason}`);
    }
  }

  out.push(
    `[record-loop] EVIDENCE — ${s.consoleErrors} console error(s), ` +
      `${s.pageErrors} page error(s), ${s.failedRequests}/${s.totalRequests} request(s) failed` +
      (s.incompleteRequests ? `, ${s.incompleteRequests} incomplete` : "") +
      (clean ? "  (clean)" : ""),
  );

  // Surface the jump-points that matter, in time order. Capped so a page that
  // errors in a loop cannot flood the terminal — the full set is in the JSON.
  const notable = report.chapters.filter((c) => c.event !== "phase");
  for (const c of notable.slice(0, 12)) {
    out.push(`[record-loop]   +${String(c.t).padStart(3)}s  ${c.event.padEnd(15)} ${c.detail ?? ""}`.trimEnd());
  }
  if (notable.length > 12) {
    out.push(`[record-loop]   … ${notable.length - 12} more (see the evidence file)`);
  }
  return out;
}
