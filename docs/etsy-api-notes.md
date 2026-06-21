# Etsy API Notes

## Authentication

- Etsy Open API v3 requires OAuth 2.0 access tokens for v3 requests.
- Jarvis sends `x-api-key` as `ETSY_API_KEY:ETSY_API_SECRET` and `Authorization: Bearer <token>` on authenticated calls.
- The Etsy client includes a refresh-token path that requests a new access token from `POST /v3/public/oauth/token` when a refresh token is configured.

## Listing flow

Jarvis follows the Etsy draft-listing workflow described in Etsy's official listings tutorial:

1. `POST /v3/application/shops/{shop_id}/listings`
2. `POST /v3/application/shops/{shop_id}/listings/{listing_id}/images`
3. `PATCH /v3/application/shops/{shop_id}/listings/{listing_id}` with `state=active`

## Research flow

- Research uses the active listings marketplace search endpoint to gather the top results for a niche keyword.
- Jarvis stores raw research snapshots in SQLite so pricing and taxonomy hints can be reused later.

## Implementation notes

- Etsy taxonomy is inferred from recent research snapshots when possible.
- Many shops need additional shipping and readiness configuration for physical listings. Jarvis reads optional environment overrides for those values rather than hardcoding them.
- Discord reporting is not part of Etsy; it is a separate webhook post built after analytics snapshots are collected.
