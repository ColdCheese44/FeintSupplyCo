# OpenClaw Repair Report

## Executive Summary
- Current status: OpenClaw core is repaired and updated to `2026.5.19`, the gateway is running, and Discord probe is healthy.
- Primary root cause: OpenClaw core and the Codex plugin were out of sync during a partial update/repair window. That produced Codex registration/runtime errors and destabilized the gateway.
- Was Discord config actually broken?: No. Discord auth, guild resolution, channel resolution, and pairing were already working. The main breakage was on the Codex/OpenClaw side.
- Was Codex plugin repaired, updated, or disabled?: The plugin package is updated to `2026.5.19`, but it is currently **disabled in config** as a stability isolation measure.

## Actions Taken
| Step | Command | Result | Files changed | Backup path |
|---|---|---|---|---|
| Inventory | `node -v`, `npm -v`, `openclaw --version`, `where openclaw` | Confirmed Windows/PowerShell, Node `v24.14.0`, npm `11.9.0`, OpenClaw path under Roaming npm | None | None |
| Health baseline | `openclaw doctor`, `openclaw plugins doctor`, `openclaw gateway status`, `openclaw channels status --probe` | Initial doctor/plugin doctor exposed Codex failure symptoms; Discord probe still authenticated and resolved guild/channel | None | None |
| Backup | Backup existing OpenClaw config and plugin state | Preserved config before changes | None | `C:\Users\brend\.openclaw\backups\repair-20260520-184852`, `C:\Users\brend\.openclaw\backups\codex-disable-20260520-190219`, `C:\Users\brend\.openclaw\openclaw.json.backup-20260520-190841` |
| Update check | `openclaw update --dry-run` | Found update available from `2026.5.18` to `2026.5.19` | None | None |
| Core repair | `openclaw update`, then `npm install -g openclaw@2026.5.19` after wrapper/module breakage | Restored a working OpenClaw installation and matching CLI/gateway version `2026.5.19` | Global OpenClaw install repaired | None |
| Codex inspection | `openclaw plugins inspect codex`, `openclaw plugins inspect codex --json` | Verified Codex plugin is installed, version `2026.5.19`, and currently disabled in config | None | None |
| Codex update attempt | `openclaw plugins update codex` | Returned `codex is up to date (2026.5.19)` | None | None |
| Codex isolation | `openclaw plugins disable codex` | Persisted `plugins.entries.codex.enabled=false`; subsequent runtime no longer loaded Codex | `C:\Users\brend\.openclaw\openclaw.json` | `C:\Users\brend\.openclaw\backups\codex-disable-20260520-190219` |
| Plugin hardening | `openclaw config set plugins.allow '["discord"]' --strict-json`, then `openclaw gateway restart` | Removed non-bundled auto-load warning for Codex and limited non-bundled plugin loading to Discord only | `C:\Users\brend\.openclaw\openclaw.json` | `C:\Users\brend\.openclaw\openclaw.json.backup-20260520-190841` |
| Final validation | `openclaw gateway status`, `openclaw channels status --probe`, `openclaw pairing list discord`, `openclaw logs --limit 150` | Gateway running, Discord connected, no pending pairing, no fresh Codex SDK/runtime errors in latest startup window | None | None |

## Current Plugin State
| Plugin | Enabled | Version/source | Status | Notes |
|---|---|---|---|---|
| `discord` | Yes | `2026.5.19`, global plugin `~\.openclaw\npm\node_modules\@openclaw\discord\dist\index.js` | Healthy | Bot probe succeeds and guild/channel resolve correctly |
| `codex` | No | `2026.5.19`, global plugin `~\.openclaw\npm\node_modules\@openclaw\codex\dist\index.js` | Disabled | Intentionally disabled after proving it was the destabilizing component |
| `openai` | Auto-enabled at runtime | Bundled with OpenClaw `2026.5.19` | Healthy | Auto-enabled because the configured agent model is `openai/gpt-4o` |
| `duckduckgo` | Auto-enabled at runtime | Bundled with OpenClaw `2026.5.19` | Healthy | Auto-enabled because web search provider is configured |

## Discord Status
| Check | Status | Notes |
|---|---|---|
| Bot auth | Working | Probe reports connected bot `@bot1506578979925135490` |
| Guild resolved | Working | `bdodd's server` |
| Channel resolved | Working | `openclaw` |
| Pairing | Healthy | `No pending discord pairing requests.` |
| Message Content Intent | Likely acceptable | Probe says `content=limited`; log notes bots under 100 servers can use it without verification |
| Gateway stability | Improved | Stable after Codex disable + plugin allowlist; gateway is listening and probe is `ok` |
| Last probe result | Healthy | `enabled, configured, running, connected, works, audit ok` |

## Remaining Risks
- Codex/OpenClaw SDK mismatch risk: The original mismatch symptoms are gone after updating to `2026.5.19`, but Codex is still disabled. Re-enabling it should be treated as a separate test.
- Event-loop starvation risk: Latest logs still contain at least one startup-time fetch timeout against Discord OAuth metadata with `likely event-loop starvation`. It recovered, but the warning has not disappeared entirely.
- Insecure control UI auth flag: `gateway.controlUi.allowInsecureAuth=true` is still enabled and should be hardened later, after stability is fully confirmed.
- Plugin allowlist scope: `plugins.allow` is now safely narrowed to `["discord"]`, which is good for stability, but it also means Codex will stay out of the runtime until you deliberately re-enable it.
- Discord allowlist warning: Earlier doctor output warned that group allowlist sender settings may still be incomplete. The current Discord probe works, but if the bot connects and then stays silent in-channel, this is the next config area to revisit carefully.
- `openclaw doctor` command behavior: It succeeded earlier in the repair flow, but later runs timed out in this session. The gateway itself stayed healthy, so this is a secondary CLI diagnostic issue rather than the main outage.

## Recommended Next Commands
Run these only if you need the next validation step:

```powershell
openclaw gateway status
openclaw channels status --probe
openclaw pairing list discord
openclaw logs --limit 150
```

If Discord is connected but not replying to a real mention in-channel, test with:

```powershell
openclaw config get channels.discord
```

If you want to retest Codex later after a known-good SDK/plugin release:

```powershell
openclaw plugins enable codex
openclaw gateway restart
openclaw plugins doctor
openclaw channels status --probe
openclaw logs --limit 150
```

## Diagnosis
The main outage was not a broken Discord bot token, guild ID, or channel ID. Discord itself was already authenticating and resolving correctly. The real operational blocker was the Codex plugin crashing or destabilizing the gateway during a mismatched/broken OpenClaw install state. Updating OpenClaw to `2026.5.19`, confirming the plugin package is also `2026.5.19`, then disabling Codex and narrowing `plugins.allow` restored a stable Discord-connected gateway. The next concrete fix, if Discord connects but does not answer real messages, is to revisit Discord group sender allowlist behavior in the config schema without reintroducing Codex into the runtime.
