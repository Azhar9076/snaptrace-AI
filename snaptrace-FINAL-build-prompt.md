# SnapTrace AI — Stage-by-Stage Cursor Prompts (v2 — fixes applied)

**Team of 3-4? Run Track A and Track B in parallel from hour 0 — see below.** Everything else: open Cursor, create an empty folder called `snaptrace-ai`, open it as your project. Start a **new Agent/Composer chat for each stage** (don't reuse one long thread — that's what burns extra tokens). Paste one stage, let it finish and verify "done when," then start the next stage in a fresh chat.

---

## Setup (do this once, not a prompt — just do it manually)
Create this empty structure yourself before opening Cursor, so the agent isn't spending tokens on folder scaffolding:
```
snaptrace-ai/
├── android-app/
├── laptop-server/
├── dashboard/
├── mock-data/          # NEW — sample package for Track B to build against
└── README.md
```
Then add a **Project Rules** file in Cursor (Settings → Rules, or `.cursor/rules`) with this pasted in once:

```
Project: SnapTrace AI, a crash-capture SDK + dashboard prototype for a hackathon selection round.
Scope decisions (do not deviate):
- SDK only captures its own app — never other apps, no root assumptions.
- Transport is a swappable interface. Only implement LocalNetworkTransport for now (Office Kit comes post-selection).
- One crash type only for Phase 1: NullPointerException from a button.
- AI root-cause call happens on the laptop, not on-device.
- Prioritize working end-to-end over polish.
```

---

## Split into two parallel tracks from hour 0

**Track A (1-2 people): Android SDK + capture** — Stages 1, 2, 3
**Track B (1-2 people): Server + dashboard** — Stages 4, 5, 6, built against `mock-data/sample-package.zip` (a fake package you create by hand — a stack trace .txt, a few dummy screenshots, a manifest.json with made-up numbers) instead of waiting on Track A's real output.

Both tracks integrate once Track A produces a real zip. This is the single highest-leverage change to this plan — without it, Track B people sit idle while Track A fights `MediaProjection`.

---

## Stage 0 — Mock data for Track B (do this FIRST, before splitting — takes 15 minutes)
```
Create mock-data/sample-package.zip containing:
- a manifest.json with fake timestamp, trigger type "manual", device model "iQOO test"
- a fake stack_trace.txt with a plausible NullPointerException trace
- a fake logs.txt with ~50 lines of plausible logcat output
- 3-4 placeholder screenshots (solid color images are fine) to stand in for the frame sequence
Done when: this zip exists and unzips cleanly — Track B builds against it starting now, Track A never touches it.
```

---

## TRACK A

## Stage 1 — Android SDK skeleton (use Auto mode)
```
Create an Android library module called snaptrace-sdk inside android-app/, separate from the app module. 
Public API: SnapTrace.init(context) and SnapTrace.captureNow() — stub/no-op implementations for now.
Add a Transport interface with a send(packageFile: File) method, and a LocalNetworkTransport class implementing it (stub the actual network call for now).
Kotlin, min SDK 26. Standard Android Studio module structure.
Done when: module compiles, and I can call SnapTrace.init() and SnapTrace.captureNow() from the app module.
```

## Stage 2 — Sample buggy app (Auto mode)
```
In android-app/app/, create one Activity with visible, moving UI state (e.g. a counter that increments every second, styled simply). 
Add a button that triggers a NullPointerException on click.
Wire in the snaptrace-sdk module: call SnapTrace.init() in Application.onCreate().
Catch the crash gracefully enough that the app doesn't crash-loop during testing (log it, don't let it kill the process outright, but keep it a real exception for capture purposes).
Done when: the app runs, the crash button reliably triggers the NPE, and the app recovers instead of hard-crashing.
```

## Stage 3 — Capture logic (use a frontier model — this is the hard part)
**⏱ TIME-BOX THIS: hard stop at hour 10 from project start. Decide this now, as a team, not when you're 12 hours in and reluctant to quit.**
**📱 Test on a real iQOO/Android device by hour 6 — emulator behavior for MediaProjection is not reliable evidence this works.**
```
In snaptrace-sdk, implement real capture logic:
1. Request MediaProjection once at app launch (not mid-crash).
2. Keep a rolling buffer of the last 8-10 seconds of screen frames, low-res (720p or lower), in memory.
3. On captureNow() or crash trigger, flush the buffer to a short compressed video.
4. Collect: the exception's stack trace, the app's own last ~50 logcat lines, ActivityManager.MemoryInfo, and PowerManager.getCurrentThermalStatus().
5. Package all of it into a zip with a manifest.json (timestamp, trigger type, device model), matching the exact structure of mock-data/sample-package.zip so Track B's code doesn't need changes.
Done when: triggering the crash produces a real zip on-device with real video + manifest + logs — inspect it manually before wiring up transfer.

IF real video encoding isn't working by hour 8 (two hours before the hard stop): STOP, fall back to capturing a burst of screenshots at ~2fps instead, and get THAT working by hour 10. A working screenshot-burst beats a half-working video encoder every time — this is not a compromise, it's the plan.
```

---

## TRACK B (build this now, in parallel, against mock-data/sample-package.zip)

## Stage 4 — Local network transfer (Auto mode is usually fine)
```
Build laptop-server/ as a small Node.js + Express server (or Flask — pick one, stick with it) with:
1. An upload endpoint that receives a multipart zip POST, saves it to laptop-server/uploads/, and unzips it.
2. For now, test this endpoint by manually POSTing mock-data/sample-package.zip with curl or Postman — don't wait for Track A's phone app.
Also stub the phone side: LocalNetworkTransport.send() should POST the zip to a laptop IP:port, hardcoded as a settings field in the app for now. Track A wires this in once their real zip exists — you're building the receiving end independently.
Done when: POSTing mock-data/sample-package.zip to the server results in it landing and unzipping correctly.
```

## Stage 5 — AI call + dashboard (use a frontier model for prompt-tuning)
```
In laptop-server/, add a route that reads the latest unzipped package's manifest.json, logs, and stack trace, and sends one call to the Anthropic API (model claude-sonnet-4-6) asking for a JSON response with two fields: root_cause (1-2 plain-English sentences) and suggested_fix (1-2 plain-English sentences).

CRITICAL — add an offline fallback: cache the AI response for your exact rehearsed demo scenario (call it once during dev, save the JSON to laptop-server/cached-response.json). On the live call, if the API doesn't respond within ~2 seconds, silently serve the cached response instead. Same UI either way — this protects the demo from venue wifi problems, which are common with 50+ teams on one network.

In dashboard/, build a static HTML/CSS/JS page (no build step) that fetches the latest package's data from the laptop server and renders:
- the replay (video or frame sequence)
- a simple timeline strip
- perf numbers (memory, thermal)
- the AI root cause and fix
Style: dark mode, glassmorphism cards (frosted blur background, soft rounded corners, subtle depth/shadow), minimal animation for fast load — should read as OriginOS-native, not generic.
Build and test this entire stage against mock-data/sample-package.zip first — don't wait on Track A.
Done when: the dashboard renders correctly from the mock package, AND separately, the offline fallback correctly serves the cached response when the API is unreachable (test by disabling wifi).
```

## Stage 6 — Demo polish (Auto mode)
```
Add a visible transfer timer on the dashboard: starts counting when a package begins uploading, stops when the dashboard finishes rendering it.
Add a simple frame-rate or responsiveness indicator in the phone app, visible during capture, to show the app isn't lagging.
Don't change any core logic — this stage is only about making the existing flow demo-able and visible.
Done when: I can trigger a crash and watch, on screen, both the transfer timer and the responsiveness indicator, live.
```

---

## Integration point
Once Track A has a real zip (by hour 10 at the latest, per the Stage 3 time-box) and Track B has a working server+dashboard against mock data, swap the mock package for the real one. If the structures match (they should, per Stage 3's instruction), this integration should take under an hour — that's the whole point of building against mock data from the start.

## After Stage 6
Run the full flow 5+ times back to back before calling it demo-ready — reliability under repetition is what separates a working prototype from a lucky one-off take. Also explicitly test the offline AI fallback at least once during rehearsal, not just in dev.
