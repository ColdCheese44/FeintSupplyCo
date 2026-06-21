# Setup

## Prerequisites

- Node.js 24+
- Python 3.11+
- Etsy Open API v3 app credentials
- Anthropic API key
- Replicate API token
- Discord webhook URL
- USPTO TSDR API key from [developer.uspto.gov](https://developer.uspto.gov/api-catalog/tsdr-data-api)

## Steps

1. Populate [`.env.example`](../.env.example) and copy the values into a local `.env` file.
2. Install Node dependencies with `npm install`.
3. Install Python support dependencies with `python -m pip install -r scripts/requirements.txt`.
4. Seed the niche catalog with `python scripts/seed_niches.py`.
5. Run `npm run build` to verify the TypeScript stack compiles.
6. Run `npm run audit` to see which required credentials or config values are still missing.
7. Run `npm run smoke` for a read-only DRY_RUN validation pass.
8. Test trend mining with `node skills/trend-miner.ts --max-results 5`.
9. Test design generation with `node skills/design-generator.ts --theme "retro arcade" --product-type t-shirt`.
10. When credentials are ready, run the orchestrator with `node skills/jarvis-loop.ts`.

## Etsy OAuth setup

- In your Etsy app dashboard, register `http://localhost:3000/oauth/callback` as a redirect URI before running the OAuth helper.
- Run `npm run etsy:oauth` to launch the browser-based PKCE flow and store `ETSY_ACCESS_TOKEN` plus `ETSY_REFRESH_TOKEN` back into `.env`.
- Run `python scripts/fetch_etsy_defaults.py` immediately after OAuth to populate:
  - `ETSY_SHOP_ID`
  - `ETSY_SHIPPING_PROFILE_ID`
  - `ETSY_DEFAULT_TAXONOMY_ID`
  - `ETSY_READINESS_STATE_ID`

## Printify and Pinterest prerequisites

- Printify to Etsy linking must be completed inside the Printify dashboard, not through the API. Use `powershell -File .\scripts\fetch_printify_shop_id.ps1` after the dashboard connection is complete.
- Pinterest diagnostics expect these read scopes to pass:
  - `user_accounts:read`
  - `boards:read`
  - `pins:read`
- Run `npm run diagnose:pinterest` to validate the token and identify a usable `PINTEREST_BOARD_ID`.

## Optional Etsy publish overrides

The publish skill can also read the following runtime environment values when your shop requires them:

- `ETSY_DEFAULT_TAXONOMY_ID`
- `ETSY_SHIPPING_PROFILE_ID`
- `ETSY_READINESS_STATE_ID`
- `ETSY_LISTING_TYPE`
- `PRINTIFY_API_TOKEN`
- `PRINTIFY_SHOP_ID`
- `PRINTFUL_API_TOKEN`
- `IDEOGRAM_API_KEY`
- `RECRAFT_API_KEY`
- `PINTEREST_ACCESS_TOKEN`
- `PINTEREST_BOARD_ID`
- `USPTO_TSDR_ENDPOINT`
- `REDDIT_CLIENT_ID`
- `REDDIT_CLIENT_SECRET`

These are shop-specific operational values, so they are documented here rather than included in `.env.example`.
