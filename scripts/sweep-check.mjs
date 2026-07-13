#!/usr/bin/env node
/**
 * sweep-check.mjs — "leave no trace" postflight for the qa-watch loop.
 *
 * A QA loop spawns real browser processes. This checks that none linger after
 * `record stop` + `agent-browser close --all`. Report-only by design — it tells
 * you what's left and how to clean it; killing is your (or your agent's) call.
 *
 * Usage:  node scripts/sweep-check.mjs
 * Exit:   0 = clean · 1 = leftovers found (CI-friendly)
 */
import { execSync } from "node:child_process";

const isWin = process.platform === "win32";

function listProcesses() {
  try {
    if (isWin) {
      const out = execSync(
        `powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Depth 1"`,
        { encoding: "utf-8", timeout: 60_000, maxBuffer: 32 * 1024 * 1024 },
      );
      const data = JSON.parse(out);
      return (Array.isArray(data) ? data : [data]).map((p) => ({
        pid: p.ProcessId, name: (p.Name || "").toLowerCase(), cmd: p.CommandLine || "",
      }));
    }
    const out = execSync("ps -eo pid=,comm=,args=", { encoding: "utf-8", timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });
    return out.trim().split("\n").map((line) => {
      const m = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
      return m ? { pid: Number(m[1]), name: m[2].toLowerCase(), cmd: m[3] } : null;
    }).filter(Boolean);
  } catch {
    console.error("sweep-check: could not list processes on this platform — check manually");
    return [];
  }
}

const leftovers = listProcesses().filter(({ name, cmd }) => {
  const browser = /chrome|chromium|msedge|firefox|webkit/.test(name);
  const headlessOrDriven = /--headless|--remote-debugging-port|playwright|agent-browser/i.test(cmd);
  return browser && headlessOrDriven;
});

if (leftovers.length === 0) {
  console.log("sweep-check: clean — no lingering browser instances from the loop");
  process.exit(0);
}

console.log(`sweep-check: ${leftovers.length} lingering browser process(es):`);
for (const p of leftovers) console.log(`  pid=${p.pid}  ${p.name}  ${p.cmd.slice(0, 100)}`);
console.log("\nclean up with:  agent-browser close --all   (then re-run this check)");
process.exit(1);
