# QA watch loop — <flow / change under test> (<date>)

> Vehicle: record-loop (<duration> WebM, <WxH>) → sampled watch (<N> frames) + <M> detail frames.
> Recording: `<path.webm>`. Flow: <what was driven, on what target>.
> Recording limits this run: <crops / resolution / zones not in frame — or "none">.

## Checklist verdicts

| Item under test | Verdict | Evidence (timestamps) |
|---|---|---|
| <feature/fix 1> | ✅ PASS / ❌ FAIL / ⚪ NOT EXERCISED / ⚪ UNJUDGEABLE | <mm:ss — what is visible> |

- **PASS** = the positive effect is ON SCREEN at the cited timestamp. Absence-of-failure is not a pass.
- **NOT EXERCISED** = this flow never triggered the code path (say what target/flow would).
- **UNJUDGEABLE** = the recording cannot answer it (crop/resolution/speed) — name what loop N+1 needs.

## Bugs found by the watch (not on the checklist)

1. <bug — first timestamp, what's visible, mechanism hypothesis if inferable>

## Tape vs tests

<If the tape contradicts green tests, say so plainly: which suite passed, what the tape shows, timestamp.>

## Follow-ups

- <fix dispatches filed / loop N+1 requirements (viewport, target, flow)>
