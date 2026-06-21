# OpenClaw Discord Troubleshooting Report

## Summary
- Working:
  - OpenClaw CLI is installed and available.
  - Node is installed and available.
  - OpenClaw gateway is registered as a Windows Scheduled Task.
  - Gateway is running on `127.0.0.1:18789`.
  - Discord channel probe reports the Discord channel as enabled, configured, running, connected, and working.
  - No pending Discord pairing requests were found.
- Fixed:
  - Backed up the existing OpenClaw config before changes.
  - Migrated the active Discord token config from inline storage to an env-based SecretRef in OpenClaw config.
  - Enabled Discord channel config and verified allowlist mode is in place.
  - Applied guild-level `requireMention = true`.
  - Applied channel-level `requireMention = true`.
  - Added the guild user allowlist entry for the provided Discord user ID.
  - Added `messages.groupChat.visibleReplies = "automatic"`.
  - Restarted the OpenClaw gateway successfully.
- Still broken:
  - `openclaw doctor` did not complete in this session and timed out.
  - The current Codex/terminal process does not inherit the newly written `DISCORD_BOT_TOKEN` user environment variable yet, so local CLI commands that resolve env secrets directly may still complain until you restart your terminal or the Codex app.
- Manual steps needed:
  - Restart PowerShell / Codex / any terminal you plan to use with OpenClaw so the new user env vars are loaded.
  - Verify the Discord Developer Portal settings listed below.
  - Send a real mention to the bot in the allowed Discord channel to confirm end-to-end behavior.

## Environment
- OS: Windows
- Shell: PowerShell
- Node version: `v24.14.0`
- OpenClaw version: `2026.5.18`
- OpenClaw path:
  - `C:\Users\brend\AppData\Roaming\npm\openclaw`
  - `C:\Users\brend\AppData\Roaming\npm\openclaw.cmd`

## What I Checked
- `openclaw --version`
- `where.exe openclaw`
- `node -v`
- `openclaw doctor`
  - Timed out in this session.
- `openclaw gateway status`
- `openclaw pairing list discord`
- `openclaw channels status --probe`
- `openclaw logs --limit 80`
- Windows Scheduled Task state for `OpenClaw Gateway`
- Live listener on port `18789`

## Config Backup
- Existing config found at:
  - `C:\Users\brend\.openclaw\openclaw.json`
- Backup created:
  - `C:\Users\brend\.openclaw\openclaw.json.backup-20260520-180659`

## Config Changes Made
- `channels.discord.token`
  - Changed from inline token storage to SecretRef:
  - provider: `default`
  - source: `env`
  - id: `DISCORD_BOT_TOKEN`
- `channels.discord.enabled = true`
- `channels.discord.groupPolicy = "allowlist"`
- `channels.discord.guilds["1159633879481712713"].requireMention = true`
- `channels.discord.guilds["1159633879481712713"].users = ["1145048835681427638"]`
- `channels.discord.guilds["1159633879481712713"].channels["1506577580726161449"].requireMention = true`
- `messages.groupChat.visibleReplies = "automatic"`

## Environment Variable Handling
- I found that `DISCORD_BOT_TOKEN` was not present in the current shell environment at the start.
- I found an existing Discord token already stored inline in OpenClaw config.
- I migrated that token into the Windows user environment store without printing it.
- I also wrote these user environment variables:
  - `DISCORD_GUILD_ID`
  - `DISCORD_USER_ID`
  - `DISCORD_CHANNEL_ID`

Important:
- New terminals should inherit those user env vars.
- The currently running terminal/Codex process may need a restart before local CLI secret resolution uses them directly.

## Gateway / Channel Health
- Gateway status after restart:
  - Running
  - Listening on `127.0.0.1:18789`
  - Connectivity probe: `ok`
- Discord channel probe after settle:
  - `enabled`
  - `configured`
  - `running`
  - `connected`
  - `works`
  - `audit ok`
- Pairing status:
  - No pending Discord pairing requests found.

## Diagnostic Classification
- Token/env problem:
  - Yes, initially.
  - Root cause: Discord token existed only inline in OpenClaw config and not in the shell env.
  - Current state: mitigated by migrating to env-backed SecretRef, but local terminals should be restarted to inherit the new user env var.
- Missing Discord intents:
  - Not directly observed as a hard failure.
  - Logs show `Message Content Intent is limited`, which is acceptable for bots under 100 servers, but the portal settings should still be verified.
- Bot permissions problem:
  - No direct evidence in logs.
- Guild allowlist/routing problem:
  - Addressed with allowlist mode, guild user allowlist, and mention requirement.
- Pairing not approved:
  - No. No pending pairing requests found.
- Gateway not running:
  - Initially unstable during restart windows, but now running.
- Visible reply/output setting problem:
  - Configured to `automatic`.
- Unknown / needs manual review:
  - `openclaw doctor` timed out and should be retried manually if you want a broader OpenClaw health sweep.

## Notable Log Findings
- Discord connected successfully and resolved the target guild/channel.
- No `invalid token` or `unauthorized` error was observed in the recent log window.
- No pairing wait state was observed.
- No explicit missing Discord permission error was observed.
- A separate OpenClaw plugin warning exists:
  - `command registration failed: Agent prompt guidance 1 must be a string (plugin=codex)`
  - This did not block the Discord channel from connecting.
- A security warning exists:
  - `gateway.controlUi.allowInsecureAuth=true`
  - This is unrelated to Discord setup but worth reviewing later.

## Discord Developer Portal Checklist
Please verify:
- Message Content Intent enabled
- Server Members Intent enabled
- Bot invited with scopes:
  - `bot`
  - `applications.commands`
- Bot permissions:
  - View Channels
  - Send Messages
  - Read Message History
  - Embed Links
  - Attach Files
  - Send Messages in Threads (if applicable)
- Bot is present in the intended server
- Bot can see the intended channel
- Developer Mode enabled so you can copy Server/User/Channel IDs

## Commands I Should Run Next
Run these in a fresh PowerShell window after restart:

```powershell
openclaw gateway status
openclaw channels status --probe
openclaw pairing list discord
```

If you want a broader OpenClaw health pass:

```powershell
openclaw doctor
```

To inspect the scheduled gateway:

```powershell
openclaw logs --limit 80
```

To test Discord end-to-end:
- In Discord, post a message in channel `1506577580726161449` mentioning the bot directly.

If you ever need to reset the IDs in a future shell:

```powershell
$env:DISCORD_GUILD_ID="PASTE_SERVER_ID"
$env:DISCORD_USER_ID="PASTE_USER_ID"
$env:DISCORD_CHANNEL_ID="PASTE_CHANNEL_ID"
[Environment]::SetEnvironmentVariable("DISCORD_GUILD_ID", "PASTE_SERVER_ID", "User")
[Environment]::SetEnvironmentVariable("DISCORD_USER_ID", "PASTE_USER_ID", "User")
[Environment]::SetEnvironmentVariable("DISCORD_CHANNEL_ID", "PASTE_CHANNEL_ID", "User")
```

## Diagnosis
The primary local blocker was token handling: OpenClaw had a working Discord token, but it was stored inline in config instead of being referenced from an environment variable. I migrated OpenClaw to the safer env-ref setup and confirmed the gateway can still start and connect the Discord channel.

The most likely remaining issue, if you still see CLI inconsistency, is environment propagation into already-open shells. The next concrete fix is simple:
1. Restart PowerShell / Codex / your terminal.
2. Re-run `openclaw channels status --probe`.
3. Send a real `@mention` to the bot in the allowed Discord channel.

If that real mention does not work, the next likely blocker is Discord Developer Portal configuration rather than the local OpenClaw side.
