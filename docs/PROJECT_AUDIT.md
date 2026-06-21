# Feint Supply Co. Project Audit

Audit date: 2026-06-21

## Executive summary

Feint Supply Co. is a substantial TypeScript automation stack, not a storefront mockup. It can research demand, aggregate trend signals, screen themes for legal risk, route text and image work across multiple AI providers, generate listing copy and design bundles, create POD products, publish Etsy listings, watch receipts, submit fulfillment orders, synchronize tracking, report analytics and costs, and supervise recurring work from a local daemon.

The core pipeline is operational with manual approval enabled. The audit repaired several defects that previously made the dashboard appear empty, stopped image generation unnecessarily, misreported budget availability, left product types only partially configured, and made multi-item fulfillment unsafe. The project compiles and the complete read-only smoke suite passes.

The current implementation supports stickers, t-shirts, mugs, posters, hoodies, and a manual Etsy-only enamel-pin flow. Hats and pens are not implemented yet, so the broader catalog goal is not complete.

## Architecture

### Control plane

- `scripts/jarvis-daemon.ts` supervises the heartbeat, order watcher, watchdog, and optional IGM monitor on independent schedules.
- `skills/jarvis-loop.ts` runs the main commerce heartbeat.
- `monitor/dashboard-server.ts` exposes the local operator API on loopback by default.
- `monitor/dashboard.html` is the responsive Quartermaster dashboard.
- `launcher/` provides Windows desktop and terminal launchers.

### Research and design pipeline

1. `trend-miner` aggregates Google Trends, TikTok, Wikipedia, YouTube, Spotify, Reddit policy state, holiday proximity, and Etsy demand signals.
2. `legal-filter` checks local blocklists, fictional properties, known public figures, protected-class targeting, and stored trademark candidates.
3. `design-generator` loads a product-specific print template and routes a primary asset plus three mockups through the LLM/image router.
4. `listing-gen` creates Etsy title, description, tags, pricing, product metadata, and a suggested shop section.
5. `pod-publisher` creates a Printful or Printify product and links it to the local listing.
6. `etsy-publish` creates and activates the Etsy listing.

### Orders and fulfillment

- `order-orchestrator` reads Etsy receipts, resolves every transaction to a local listing and Printful sync variant, submits one multi-line fulfillment order, records the order, and later sends tracking back to Etsy.
- Mixed receipts containing an unmapped item are held entirely for manual fulfillment. This prevents partial submission and accidental duplicate shipping.
- Printful and Printify tracking records are both polled.
- Repeated shipping errors and low margins can pause publishing.

### Persistence and observability

- SQLite in WAL mode stores niches, research, designs, listings, POD mappings, orders, analytics, provider health, costs, failures, automation controls, heartbeats, IGM snapshots, and audit events.
- JSON-line logs provide component-level operational traces.
- Discord webhooks split heartbeat, analytics, orders, costs, watchdog, legal, and IGM notifications by channel.
- Runtime databases, logs, customer state, generated art, credentials, and reports are excluded from Git.

## Defects repaired

### Production behavior

- Added the missing `audit_log` migration and `/api/audit` endpoint.
- Made audit writes best-effort so logging cannot turn a successful external fulfillment into a reported failure.
- Enforced `MAX_LISTINGS_PER_DAY`; it was previously displayed but ignored.
- Allowed OpenAI image fallback when Replicate credit is low instead of pausing the entire design pipeline.
- Added missing hoodie and enamel-pin design templates.
- Completed Printful catalog configuration for stickers, mugs, and hoodies.
- Corrected budget parsing so an unset seed budget uses the documented `$100` default instead of zero.
- Reconciled budget and cost reporting with actual provider-call records.
- Removed double counting of image calls in the cost dashboard.
- Added safe recovery from the false seed-budget publishing pause.
- Fulfilled every transaction in a multi-item Etsy receipt instead of only the first.
- Included Printify orders in tracking refreshes.
- Replaced the 100-row duplicate-order scan with an exact receipt lookup.

### Dashboard and operator experience

- Restored all ten dashboard API surfaces.
- Bound the control server to `127.0.0.1` by default.
- Added partial-refresh resilience so one failed panel no longer blanks the whole dashboard.
- Added a manual refresh button and connection state.
- Added confirmations for publishing, rejection, heartbeat, and daemon controls.
- Added persistent tab URLs, ARIA tab semantics, focus styles, keyboard image previews, and reduced-motion support.
- Corrected responsive behavior at tablet and phone widths.
- Escaped externally sourced listing, order, tracking, IGM, and audit text before HTML rendering.

### Repository and local installation

- Renamed the canonical project to `D:\Windows\FeintSupplyCo`.
- Renamed the npm package to `feint-supply-co`.
- Replaced machine-specific documentation links with portable relative links.
- Added public-repository ignore rules for credentials and runtime business data.
- Connected and pushed `main` to `ColdCheese44/FeintSupplyCo`.

## Verification

- `npm run build`: pass.
- `npm run smoke`: pass for every core skill in dry-run mode.
- Provider smoke state: Etsy, Printify, Printful, Anthropic, OpenAI, Replicate, Google Trends, Wikipedia, and TikTok passed.
- Dashboard API check: overview, pending, listings, analytics, costs, niches, heartbeat, orders, audit, and IGM all returned HTTP 200.
- Browser QA: desktop and 390 px mobile layouts verified; no page-level horizontal overflow.
- Legal classifier check: generic themes were allowed and an unapproved personal name was rejected.
- Live fallback check: designs were generated through OpenAI while Replicate reported zero credit.
- Cost consistency check: all-time tracked spend `$6.70`, remaining seed budget `$93.30`, current-day spend `$1.17` without image double counting.
- Credential leak check: no live `.env` credential value appeared in the committed text files.

## Remaining gaps

### Catalog breadth

- Hats and pens need product types, design templates, prices, provider catalog mappings, variants, mockup rules, listing guidance, and fulfillment tests.
- Enamel pins remain a manual made-to-order Etsy flow rather than automatic POD fulfillment.

### Marketing

- Pinterest credentials currently return HTTP 401, so automated pin publication is not live.
- Email campaigns are drafted locally; no transactional or campaign email provider sends them.
- YouTube and Spotify enrichment are optional and currently have no credentials.
- Reddit enrichment is intentionally disabled by policy.

### Legal and trend quality

- USPTO checks are degraded and require a valid API configuration plus continued rate-limit care.
- Trend feeds can surface noisy news, sports, people, and brand terms. Legal filtering plus `REQUIRE_APPROVAL=true` must remain enabled until trademark and brand-entity screening is stronger.
- Manual review is still required before any design using a person, organization, entertainment property, sports reference, or ambiguous trend is published.

### Test depth

- The smoke suite is broad but primarily integration-oriented and dry-run based.
- A real low-value test order through Etsy and the chosen POD provider is still needed to validate address, tax, variant, fulfillment, cancellation, refund, and tracking behavior end to end.
- Dedicated unit tests should be added for daily limits, budget math, multi-item receipts, mixed manual/POD receipts, variant matching, and dashboard API errors.

## Recommended next sequence

1. Refresh Pinterest credentials and verify one private/test pin.
2. Run one controlled Etsy-to-Printful test order with a multi-variant product.
3. Add hats as the next fully automatic product type.
4. Research a reliable pen POD supplier before adding pens.
5. Add automated tests around fulfillment and budget boundaries.
6. Expand brand/trademark entity screening before reducing manual approval.
