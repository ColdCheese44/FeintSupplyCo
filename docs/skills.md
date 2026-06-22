# Skills

## `skills/etsy-research.ts`

- Loads active niches from SQLite
- Searches Etsy active listings for each niche keyword
- Scores opportunities and stores results in `research_results`
- Returns the top ranked opportunities as JSON

## `skills/listing-gen.ts`

- Generates listing copy with Claude
- Uses prompt templates from `data/prompts/`
- Validates title, description, tags, and price
- Saves the result as a draft row in `listings`

## `skills/image-gen.ts`

- Builds a product mockup prompt from the listing and niche
- Calls Replicate
- Downloads the generated image to `data/images/<listing_id>.png`
- Updates the listing record with the local image path

## `skills/etsy-publish.ts`

- Validates a local draft
- Creates an Etsy draft listing
- Uploads the generated image
- Activates the listing and stores the Etsy listing ID locally

## `skills/etsy-analytics.ts`

- Refreshes metrics for published listings
- Inserts a snapshot into `analytics`
- Builds a Discord embed summary
- Posts the summary when `DISCORD_WEBHOOK_URL` is configured

## `skills/fsc-loop.ts`

- Runs one full FeintSupplyCo heartbeat cycle
- Mines trend opportunities
- Generates designs and listing drafts
- Publishes products through the POD lane
- Refreshes analytics and posts the report

## `skills/trend-miner.ts`

- Pulls public Google Trends signals
- Pulls YouTube trend signals when `YOUTUBE_API_KEY` is configured
- Pulls Wikipedia pageview signals without auth
- Pulls public TikTok Creative Center signals with polite throttling
- Pulls Spotify search signals when Spotify app credentials are configured
- Optionally uses Reddit only when `REDDIT_ENABLED=true`
- Cross-references Etsy search results when Etsy credentials are available
- Stores ranked themes in `research_results`

## `skills/design-generator.ts`

- Routes print-design generation through the multi-LLM layer
- Produces a primary design plus three mockups
- Enforces a daily design budget
- Saves generated assets under `data/designs/`

## `skills/pod-publisher.ts`

- Uploads a design to Printify
- Creates and publishes the POD product
- Stores Printify and optional Printful backup IDs
- Links the result back to the local listing

## `skills/order-orchestrator.ts`

- Polls Etsy receipts
- Creates provider orders in Printify or Printful
- Pushes tracking back to Etsy when it becomes available
- Enforces shipping-error pause rails

## `skills/trademark-hunter.ts`

- Searches USPTO for candidate marks
- Scores recognition and legal cleanliness
- Writes PDF dossiers for human review only
- Sends Discord alerts for high-scoring candidates

## `skills/marketing-engine.ts`

- Schedules Pinterest marketing assets for newly published listings
- Publishes due pins when a remote image is available
- Drafts a weekly email campaign payload
