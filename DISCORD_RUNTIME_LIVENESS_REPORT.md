# Discord Runtime Liveness Report

## Executive Summary
- PASS/FAIL: FAIL
- Main blocker: `EmbeddedAttemptSessionTakeoverError` on the Discord channel session after the model completed but before reply delivery.
- Confidence: High

The Discord route itself is working: bot auth succeeds, guild/channel resolution succeeds, mentions are detected, and embedded runs start. The failure is in the embedded agent/session layer, not in basic Discord connectivity. The most recent hard failure is:

`EmbeddedAttemptSessionTakeoverError: session file changed while embedded prompt lock was released: C:\Users\brend\.openclaw\agents\main\sessions\77f4d042-eebb-4668-9193-cae2d581d092.jsonl`

## Timeline
| Time | Event | Meaning |
|---|---|---|
| `2026-05-21T01:27:57Z` | Gateway ready | Gateway startup completed successfully |
| `2026-05-21T01:27:59Z` | Discord guild/channel resolved | Route to `bdodd's server` / `#openclaw` is valid |
| `2026-05-21T01:29:20Z` | Liveness warning on `agent:main:discord:channel:1506577580726161449` | The server-channel run is active and already showing event-loop delay |
| `2026-05-21T01:29:49Z` | Embedded run startup stages logged for session `77f4...` | Mention-triggered embedded run started for the Discord channel session |
| `2026-05-21T01:30:01Z` | `stream-ready` reached for session `77f4...` | The embedded agent got far enough to create the model stream |
| `2026-05-21T01:30:11Z` | Discord fetch timeout | Event-loop delay is still happening after stream setup |
| `2026-05-21T01:30:12Z` | `EmbeddedAttemptSessionTakeoverError` | Session transcript changed mid-run; reply path aborted |
| `2026-05-21T01:30:44Z` | `Merged and removed orphaned user message` warning | Confirms additional user input was being merged into the same session while runs overlapped |
| `2026-05-21T01:30:54Z` | `model.completed` / `session.ended` success in trajectory | The model produced `READY`; generation itself succeeded |
| Current snapshot | Gateway unreachable / no listener | The runtime is not currently serving loopback requests |

## Discord Route
- Direct/DM or server channel: Server channel
- Mention detected: Yes
- Guild/channel allowed: Yes
- Pairing state: No pending pairing requests

Exact route evidence:
- Session key in session store: `agent:main:discord:channel:1506577580726161449`
- Conversation label in stored session: `discord:1159633879481712713#openclaw`
- Trajectory/session metadata shows `chat_type: "channel"` and `was_mentioned: true`

There were also earlier direct-message runs in the logs, but the current hard failure is tied to the **server channel** route and session `77f4d042-eebb-4668-9193-cae2d581d092`.

## Agent Runtime
| Stage | Duration | Normal/High/Critical | Notes |
|---|---:|---|---|
| Model resolution | `~0.87s - 0.95s` | Normal | Not the main bottleneck |
| Auth | `~10.9s - 11.9s` | Critical | Largest single startup cost |
| Core plugin tools | `~4.1s - 5.8s` | High | Significant prep overhead before generation |
| Bundle tools | `~3.4s - 5.0s` | High | Second major prep cost |
| Session resource loader | `~1.6s - 2.1s` | High | Adds meaningful tail latency |
| Stream-ready total | `~10.4s - 11.9s` | Critical | Run does reach stream-ready, but only after heavy setup |
| Event loop delay max | up to `~18.8s` | Critical | Logged before the failure on the Discord channel lane |
| Lane lifetime before failure | `~36.3s` | Critical | Failure occurs after long active processing window |

## Reply Delivery
- Response generated: Yes
- Send attempted: No evidence
- Delivered: No
- Suppressed: No evidence
- Error: `EmbeddedAttemptSessionTakeoverError`

Evidence:
- The stored trajectory for session `77f4...` contains:
  - `assistantTexts:["READY"]`
  - `finalStatus:"success"`
  - `didSendViaMessagingTool:false`
- The runtime log contains:
  - `Embedded agent failed before reply: session file changed while embedded prompt lock was released...`

This means the model successfully generated the text `READY`, but OpenClaw failed **before** the reply could be sent back to Discord.

## Additional Checks

### 1. More than one OpenClaw gateway process active?
- At the current snapshot: No
- Evidence:
  - `Get-CimInstance Win32_Process ...` showed only short-lived CLI/help/status processes, not a live `gateway --port 18789` process
  - `Get-NetTCPConnection` returned no listener on port `18789`
  - `openclaw gateway status` reported `ECONNREFUSED`

Historical note:
- Logs show prior restart cleanup:
  - `killing 1 stale gateway process(es)`
  - `cleared 1 stale gateway pid(s)`
- So stale/duplicate gateway processes existed earlier, but not at the final snapshot.

### 2. Any stale session lock files under `C:\Users\brend\.openclaw\agents\main\sessions\`?
- No explicit lock files were found
- Evidence:
  - Directory listing showed only:
    - `*.jsonl`
    - `*.trajectory.jsonl`
    - `*.trajectory-path.json`
    - `sessions.json`

### 3. Is session `77f4...` tied to the Discord channel route?
- Yes
- Evidence from `sessions.json`:
  - key: `agent:main:discord:channel:1506577580726161449`
  - `sessionId: "77f4d042-eebb-4668-9193-cae2d581d092"`
  - `to: "channel:1506577580726161449"`
- Evidence from trajectory:
  - `sessionKey:"agent:main:discord:channel:1506577580726161449"`

### 4. Are repeated Discord messages being queued into the same session?
- Yes
- Evidence:
  - Trajectory contains a custom runtime context block:
    - `[Queued user message that arrived while the previous turn was still active]`
  - Later log entry:
    - `Merged and removed orphaned user message to prevent consecutive user turns`

This is strong evidence that multiple mentioned messages in the same Discord channel are being funneled into the same session while a prior turn is still active.

### 5. Safest OpenClaw-native way to reset or rotate the Discord channel session
- No narrow per-session “reset” or “new session” command was found in the native CLI help
- Native session-related commands discovered:
  - `openclaw sessions list`
  - `openclaw sessions export-trajectory`
  - `openclaw sessions cleanup`
- Native broad reset command exists:
  - `openclaw reset --scope config+creds+sessions`

Safest native path identified:
1. Export/backup the affected session
2. Preview session-store cleanup
3. If cleanup cannot rotate the channel session, use a **dry-run** of the broader native reset scope before any destructive action

### 6. Was a native reset/new-session command found before considering file deletion?
- No targeted per-session reset command was found
- Evidence:
  - `openclaw sessions --help` exposes only `list`, `cleanup`, and `export-trajectory`
  - `openclaw reset --help` is broad and resets larger scopes, not one named session

### 7. Is the dashboard, CLI, or another background process writing to the same session while Discord runs?
- No evidence of dashboard or a separate CLI session writer was found
- Evidence:
  - Process inspection showed only the diagnostic commands being run during this check
  - No persistent dashboard/TUI/chat foreground client process was present
- Most likely writer:
  - Additional Discord channel messages being merged into the same session while the embedded run lock is temporarily released

## Diagnosis
Classify as one:
- Gateway event-loop starvation

Why this class:
- The immediate hard stop is a **session takeover** while the embedded lock is released.
- The surrounding environment shows heavy latency and liveness warnings:
  - auth `~11s`
  - core-plugin-tools `~4-5s`
  - bundle-tools `~3-5s`
  - event loop delay up to `~18.8s`
- That long active window makes it much more likely that another inbound Discord mention lands and mutates the same channel session before reply dispatch completes.

Contributing factors:
- OpenAI/auth latency problem
- Embedded agent/tool-bundle overhead

Not supported by evidence:
- Discord route problem
- Pairing problem
- Visible reply suppression
- Discord send failure

## Recommended Next Action
Do not run these blindly in the middle of an active Discord test. These are the safest native next commands to inspect/prepare a reset path:

```powershell
openclaw sessions export-trajectory --agent main --session-key "agent:main:discord:channel:1506577580726161449" --output discord-channel-session-77f4
```

```powershell
openclaw backup create --dry-run --output C:\Users\brend\feintsupply-etsy
```

```powershell
openclaw sessions cleanup --agent main --dry-run --json
```

If cleanup does not offer a way to rotate the channel session, preview the only clearly native broader reset surface:

```powershell
openclaw reset --dry-run --scope config+creds+sessions
```

After that, re-check runtime health before attempting another Discord mention:

```powershell
openclaw gateway status
openclaw channels status --probe
openclaw logs --limit 150
```
