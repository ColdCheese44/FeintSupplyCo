# OpenClaw Skill Wrappers

These wrappers let OpenClaw call the existing FeintSupplyCo TypeScript skills without duplicating orchestration logic.

## Registering the skills

1. Ensure OpenClaw is installed and your project `.env` is populated.
2. Register the wrapper entry points with OpenClaw during onboarding or in your local skill configuration.
3. Use these files as the execution targets:
   - `openclaw/fsc-heartbeat.skill.ts`
   - `openclaw/fsc-order-watch.skill.ts`

## Recommended schedules

- Main FeintSupplyCo heartbeat: `0 */6 * * *`
- Order watch: `*/10 * * * *`

## Runtime controls

- `HEARTBEAT_INTERVAL_HOURS` defaults to `6`
- `HEARTBEAT_DISCORD_REPORT` defaults to `true`
- `DRY_RUN=true` keeps the wrappers safe for smoke validation

## Viewing logs

- Structured logs are written to `data/feintsupply.log`
- Standalone wrapper output is also printed to stdout
- Use `npm run heartbeat` or `npm run orderwatch` locally before wiring the same files into OpenClaw
