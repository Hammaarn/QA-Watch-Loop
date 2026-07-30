/**
 * processes.mjs — who started which browser.
 *
 * WHY THIS EXISTS. sweep-check listed every agent-browser-driven browser and
 * announced them as "lingering browser process(es)" **from the loop**, then told
 * you to run `agent-browser close --all`. It had no way to know whose they were.
 *
 * S#261, live: a two-pass run finished and cleaned up correctly, the sweep still
 * reported 10 leftovers, and `close --all` reaped an `sl-board` session belonging
 * to entirely different work. Two defects in one output:
 *
 *   1. A confident false DIRTY. The tool claimed ownership it could not establish
 *      — the mirror image of the false-clean bug this project already promoted
 *      into a rule. An unattributable process is not a leaked one.
 *   2. Dangerous remediation. `close --all` closes EVERY session, so the advice
 *      printed on a false positive destroys a bystander's browser.
 *
 * The fix is a baseline, not better pattern-matching: snapshot which browsers
 * already existed BEFORE the loop opened anything, and diff at the end. What was
 * already there is not mine, whatever it looks like.
 *
 * And when no baseline is available, the honest answer is UNKNOWN — never "from
 * the loop". Same discipline as the evidence collector: an unread channel is not
 * an empty one, and an unattributed process is not a leaked one.
 */

import { execSync } from "node:child_process";

const isWin = process.platform === "win32";

/** Every browser process that looks driven by automation. Ownership NOT implied. */
export function listBrowsers() {
  try {
    if (isWin) {
      const out = execSync(
        `powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Depth 1"`,
        { encoding: "utf-8", timeout: 60_000, maxBuffer: 32 * 1024 * 1024 },
      );
      const data = JSON.parse(out);
      return filterBrowsers(
        (Array.isArray(data) ? data : [data]).map((p) => ({
          pid: p.ProcessId, name: (p.Name || "").toLowerCase(), cmd: p.CommandLine || "",
        })),
      );
    }
    const out = execSync("ps -eo pid=,comm=,args=", { encoding: "utf-8", timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });
    return filterBrowsers(
      out.trim().split("\n").map((line) => {
        const m = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
        return m ? { pid: Number(m[1]), name: m[2].toLowerCase(), cmd: m[3] } : null;
      }).filter(Boolean),
    );
  } catch {
    // Distinguished from "found none" by the caller — a failed listing must never
    // read as a clean machine.
    return null;
  }
}

/** Pure, so the classification logic is testable without spawning anything. */
export function filterBrowsers(procs) {
  return procs.filter(({ name, cmd }) => {
    const browser = /chrome|chromium|msedge|firefox|webkit/.test(name);
    const driven = /--headless|--remote-debugging-port|playwright|agent-browser/i.test(cmd);
    return browser && driven;
  });
}

/**
 * Split what is running now against what was running before the loop started.
 *
 * `baselinePids === null` means no baseline was captured — ownership is then
 * genuinely unknown and is reported as such, rather than defaulted to "mine"
 * (cries wolf, and the printed remediation kills bystanders) or to "not mine"
 * (hides a real leak, which is worse).
 */
export function classify(current, baselinePids) {
  if (baselinePids === null || baselinePids === undefined) {
    return { mine: [], preExisting: [], unknown: current };
  }
  const before = new Set(baselinePids);
  return {
    mine: current.filter((p) => !before.has(p.pid)),
    preExisting: current.filter((p) => before.has(p.pid)),
    unknown: [],
  };
}
