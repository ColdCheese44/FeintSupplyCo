# Feint Supply Co. Automation

Jarvis is an autonomous commerce stack built around TypeScript skills for OpenClaw and Python support utilities. It researches Etsy opportunities, mines nostalgia trends, routes work across multiple AI providers, generates product art and mockups, publishes POD-backed products through Printify and Etsy, monitors orders, and posts performance summaries to Discord.

## What is included

- `skills/`: standalone OpenClaw-friendly TypeScript entry points for research, copy generation, design generation, POD publishing, fulfillment, trademark review, marketing, analytics, and orchestration
- `lib/`: shared clients for Etsy, Claude, OpenAI, Replicate, Printify, Printful, Pinterest, USPTO, Reddit, SQLite, and structured logging
- `scripts/`: Python helpers for seeding niches, exporting listings, and analyzing performance
- `openclaw/`: lightweight wrappers for heartbeat and order-watch execution inside OpenClaw
- `data/`: prompts, niches, images, designs, product catalogs, trademark dossiers, and the SQLite database
- `docs/`: setup notes, skill reference, and Etsy API implementation notes

## Setup

1. Fill in [`.env.example`](.env.example) and copy the values into a local `.env` file.
2. Install Node dependencies:

```powershell
npm install
```

3. Install Python utilities if you plan to use the helper scripts:

```powershell
python -m pip install -r scripts/requirements.txt
```

4. Seed the default niches and create the SQLite database:

```powershell
python scripts/seed_niches.py
```

5. Verify the TypeScript build:

```powershell
npm run build
```

6. Run the credential audit and smoke test:

```powershell
npm run audit
npm run smoke
```

## Usage

Run individual skills from the project root:

```powershell
node skills/etsy-research.ts --max-results 3
node skills/trend-miner.ts --max-results 5
node skills/design-generator.ts --theme "retro arcade" --product-type t-shirt
node skills/listing-gen.ts --niche "Minimalist Wall Art" --keyword "minimalist wall art"
node skills/image-gen.ts --listing-id 1
node skills/etsy-publish.ts --listing-id 1
node skills/pod-publisher.ts --listing-id 1
node skills/order-orchestrator.ts
node skills/marketing-engine.ts
node skills/trademark-hunter.ts
node skills/etsy-analytics.ts
node skills/jarvis-loop.ts
```

Or use the npm shortcuts:

```powershell
npm run research
npm run trend-mine
npm run design
npm run pod-publish
npm run orders
npm run marketing
npm run trademark
npm run loop
npm run diagnose:pinterest
npm run etsy:oauth
npm run heartbeat
npm run orderwatch
```

## Lifecycle Commands

Setup phase:
- `npm run audit` - check credential state
- `npm run smoke` - full read-only validation
- `npm run diagnose:pinterest` - debug Pinterest auth
- `npm run test:trademark` - verify TSDR works
- `npm run preview-digest` - preview Discord digest format

Go-live phase:
- `npm run go-live` - interactive wizard to complete Etsy OAuth, fetch shop defaults, and flip `DRY_RUN` off once all required keys are valid

Operations phase:
- `npm run heartbeat` - manual run of main loop
- `npm run orderwatch` - manual run of order watcher
- `npm run costs` - current spend dashboard
- `npm run watchdog` - heartbeat health check
- `npm run install-launcher` - install the Windows desktop launcher

## Autonomous operation (daemon)

For hands-off running, the daemon supervises every recurring task in one resilient process — each on its own cadence, with per-task error isolation so one failure never stops the others.

```powershell
npm run daemon            # run the supervisor in the foreground (Ctrl+C to stop)
npm run install-daemon    # register a Windows Scheduled Task: runs at logon, auto-restarts
npm run uninstall-daemon  # remove the Scheduled Task
```

Cadences (from `.env`, with sensible defaults):
- Heartbeat — every `HEARTBEAT_INTERVAL_HOURS` (default 6); runs once immediately on start.
- Order watch — every `ORDER_WATCH_INTERVAL_MINUTES` (default 30).
- Watchdog — every `WATCHDOG_INTERVAL_MINUTES` (default 60); alerts on stale heartbeats.
- IGM monitor — every `IGM_MONITOR_INTERVAL_MINUTES` (default 0/off; IGM already runs inside the heartbeat).

Notes:
- The daemon respects `DRY_RUN` and `REQUIRE_APPROVAL` from `.env` — installing it never changes operating mode.
- `JARVIS_DAEMON_MAX_RUNTIME_MS` bounds the run (used for tests/supervised restarts); 0 = run forever.
- The Scheduled Task runs `npm run daemon` hidden at logon and restarts it every 2 minutes if it stops. Console output goes to `data/daemon.out.log`; structured logs to `data/jarvis.log`.

## Passive income (Income Generator / IGM)

Jarvis can also monitor an [Income Generator](https://github.com/XternA/income-generator) bandwidth-sharing stack and report its earnings alongside Etsy income. It degrades gracefully: if Docker or IGM is not installed, status simply reports `not_installed`.

```powershell
npm run igm:status     # show current status + reported earnings
npm run igm:up         # start the IGM earning containers
npm run igm:down       # stop the IGM earning containers
npm run igm:restart    # restart the IGM earning containers
npm run igm:monitor    # status snapshot + post a Discord digest
```

- Enable with `IGM_ENABLED=true` in `.env`. Requires Docker installed and the IGM bootstrap run first.
- The heartbeat records an IGM snapshot each cycle and (when `IGM_ENABLED=true`) posts an IGM digest to Discord beside the Etsy analytics report.
- The monitor dashboard shows a **Passive Income (IGM)** panel fed by `GET /api/igm`.
- Earnings come from each app's own dashboard; record the cumulative figure via `IGM_REPORTED_EARNINGS_USD` or `npm run igm:status -- --earnings 12.50`.
- **Caution:** reselling residential bandwidth may violate your ISP's terms of service and can affect your IP's reputation. Review the trade-offs before enabling.

## Discord channels & webhooks

Jarvis routes each stream to its own channel webhook, falling back to `DISCORD_WEBHOOK_URL` (the "command post") whenever a channel-specific webhook is blank. Paste a channel's webhook URL into the matching `.env` slot to split that feed out; leave it blank to keep it in the command post.

| `.env` key | Suggested channel | What posts here |
|---|---|---|
| `DISCORD_WEBHOOK_URL` | `#command-post` | Fallback for anything below that's blank |
| `DISCORD_HEARTBEAT_WEBHOOK_URL` | `#heartbeat-log` | Heartbeat guardrail/status messages |
| `DISCORD_ANALYTICS_WEBHOOK_URL` | `#revenue-analytics` | Etsy performance digests |
| `DISCORD_ORDERS_WEBHOOK_URL` | `#orders` | New orders + fulfillment/tracking |
| `DISCORD_COST_WEBHOOK_URL` | `#cost-control` | Spend dashboard + budget alerts |
| `DISCORD_WATCHDOG_WEBHOOK_URL` | `#system-status` | Watchdog health + provider/balance alerts |
| `DISCORD_IGM_WEBHOOK_URL` | `#passive-income-igm` | IGM bandwidth-income snapshots |
| `DISCORD_LEGAL_WEBHOOK_URL` | `#legal-flags` | Trademark review candidates |

Only these channels need webhooks today (they're the streams the code emits). Routing lives in `lib/discord.ts`. To create a webhook: channel → Edit Channel → Integrations → Webhooks → New Webhook → Copy URL.

## Keyless enrichment APIs

Two free, no-key public APIs (from the public-apis list) feed the pipeline:

- **Datamuse** (`lib/datamuse-client.ts`) — related buyer-search terms passed to the listing copywriter as *curated candidates*. The model keeps the relevant, on-brand ones for Etsy tags and ignores noise, so the linguistic source never writes directly to a listing. Toggle with `KEYWORD_EXPANSION_ENABLED`.
- **Nager.Date public holidays** (`lib/holidays-client.ts`) — upcoming holidays become proximity-scored seasonal opportunities inside `trend-miner` (sooner = higher), giving lead time for seasonal/patriotic products. Config: `HOLIDAYS_ENABLED`, `HOLIDAYS_COUNTRY_CODE`, `HOLIDAYS_WINDOW_DAYS`.

Both fail safe — if the API is unreachable, the pipeline proceeds without the enrichment.

## Notes

- Jarvis logs structured JSON lines to `data/jarvis.log`.
- The Phase 2 heartbeat flow is `trend-miner -> design-generator -> listing-gen -> pod-publisher -> marketing-engine -> etsy-analytics`.
- Direct Etsy publishing still exists for legacy flows, but the preferred physical-product path is Printify-backed POD publishing.
- Etsy OAuth uses the local callback `http://localhost:3000/oauth/callback`, which must be registered in your Etsy app before `npm run etsy:oauth`.
- Printify store linking must be completed in the Printify dashboard before `PRINTIFY_SHOP_ID` can be discovered or written.
- Some Etsy shops require additional publish defaults such as `ETSY_DEFAULT_TAXONOMY_ID`, `ETSY_SHIPPING_PROFILE_ID`, and `ETSY_READINESS_STATE_ID`, and Jarvis now includes a helper to fetch them interactively after OAuth.
- `data/jarvis.db` is created automatically when the database layer initializes.

## Go-live after Etsy approval

1. Run `npm run go-live`
2. Run `npm run heartbeat`
3. Monitor Discord plus `npm run audit`

## First commands after filling `.env`

```powershell
python scripts/seed_niches.py
npm run build
npm run audit
npm run smoke
```
