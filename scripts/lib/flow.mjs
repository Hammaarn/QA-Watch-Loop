/**
 * flow.mjs — drive a scripted flow so the loop can run unattended.
 *
 * WHY THIS EXISTS. Anything past a bare page load — a form, a judge picker, a
 * multi-step submit — could not be expressed in flags, so it had to run under
 * `--manual`, where the operator drives by hand. That mode exits immediately,
 * which switches OFF evidence sampling and collapses the chapter list to
 * record-start/record-stop. The instrumentation was disabled precisely on the
 * flows worth instrumenting, and "one command" was impossible.
 *
 * MATCH ON TEXT, NOT ON REFS. agent-browser's `snapshot` hands out refs (e10,
 * e14) that are assigned per snapshot and shift as the page changes — a flow
 * file pinned to them would rot immediately, and worse, would silently click the
 * WRONG element rather than fail. So steps name what a human would read
 * ("SUBMIT FOR FULL TRIAL") and the ref is resolved fresh at execution time.
 *
 * A step that cannot resolve is a HARD FAILURE. A flow that quietly skips a
 * click still produces a tape, and that tape shows a flow that never ran —
 * which is a far more expensive lie than a crash.
 */

/** `- button "SUBMIT FOR FULL TRIAL" [ref=e14]` → e14 */
const REF_RE = /\[(?:[^\]]*,\s*)?ref=(e\d+)\]/;

/**
 * Find the ref of the first snapshot line matching `text`.
 * Case-insensitive substring; the snapshot is a11y text, so this is what the
 * user would read on screen.
 */
export function resolveRef(snapshot, text) {
  const needle = text.toLowerCase();
  for (const line of String(snapshot).split(/\r?\n/)) {
    if (!line.toLowerCase().includes(needle)) continue;
    const m = line.match(REF_RE);
    if (m) return m[1];
  }
  return null;
}

export function loadFlow(json) {
  const flow = typeof json === "string" ? JSON.parse(json) : json;
  if (!Array.isArray(flow?.steps) || flow.steps.length === 0) {
    throw new Error("flow file needs a non-empty `steps` array");
  }
  return flow;
}

/**
 * Execute a flow.
 *
 * `deps` keeps this testable without a browser: pass fakes for ab/abOut and the
 * whole thing runs headless in a unit test.
 */
export async function runFlow(flow, deps) {
  const { ab, abOut, mark, collect, sleep, log } = deps;

  // Elements can lag the page. Re-snapshot a few times before giving up, so a
  // slow render is a retry rather than a failed run.
  const findRef = async (text, attempts = 6) => {
    for (let i = 0; i < attempts; i++) {
      const ref = resolveRef(abOut("snapshot"), text);
      if (ref) return ref;
      await sleep(1000);
    }
    return null;
  };

  for (const [i, step] of flow.steps.entries()) {
    const label = step.chapter ?? `${step.do}${step.match ? ` ${step.match}` : ""}`;
    const where = `step ${i + 1} (${step.do})`;

    switch (step.do) {
      case "fill":
      case "click":
      case "hover":
      case "scrollintoview": {
        const ref = await findRef(step.match);
        if (!ref) throw new Error(`${where}: no element matching ${JSON.stringify(step.match)}`);
        if (step.do === "fill") ab("fill", ref, step.value);
        else ab(step.do, ref);
        break;
      }

      case "press":
        ab("press", step.key);
        break;

      case "scroll":
        ab("scroll", step.dir ?? "down", String(step.px ?? 600));
        break;

      case "wait":
        await sleep(step.ms ?? 1000);
        break;

      case "waitFor": {
        // The long async phase — a review running, a build finishing. Poll the
        // snapshot on the same 5s beat as evidence sampling so the tape keeps
        // gathering while we wait, instead of going blind for minutes.
        const re = new RegExp(step.match, "i");
        const deadline = Date.now() + (step.timeoutS ?? 300) * 1000;
        let matched = false;
        while (Date.now() < deadline) {
          await sleep(5000);
          collect();
          let snap = "";
          try { snap = abOut("snapshot"); } catch { /* transient */ }
          if (re.test(snap)) { matched = true; break; }
        }
        if (!matched && step.required !== false) {
          throw new Error(`${where}: never matched ${JSON.stringify(step.match)} within ${step.timeoutS ?? 300}s`);
        }
        if (!matched) log(`[flow] ${where}: no match, continuing (required:false)`);
        break;
      }

      default:
        throw new Error(`${where}: unknown step "${step.do}"`);
    }

    mark("flow", label);
    log(`[flow] ${label}`);
    // Sample after every step: this is what gives the tape a real timeline
    // instead of two bookend chapters.
    collect();
    if (step.settleMs !== 0) await sleep(step.settleMs ?? 700);
  }
}
