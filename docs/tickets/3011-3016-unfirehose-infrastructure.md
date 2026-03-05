# 3011-3016: Unfirehose Infrastructure (KYC, Bucket Sync, Tier Enforcement)

**Status:** closed (moved — 2026-03-05)
**Project:** unfirehose (Elixir API) + unfirehose.com (unsandbox.com portal)
**Estimated:** 240m+ (multi-session)
**Todo IDs:** 3011, 3012, 3013, 3014, 3015, 3016
**Resolution:** Infrastructure work belongs in unfirehose (API) and unfirehose.com (portal) repos. KYC, bucket sync, tier enforcement are server-side concerns.

## Context

Six related todos for the paid tier infrastructure:

- **#3011** Add KYC field to ApiKey schema + migration
- **#3012** Create BucketConfig schema + migration
- **#3013** Enforce 7-day sliding window for free tier sessions
- **#3014** Create BucketConfig API controller + routes
- **#3015** Create BucketSync worker
- **#3016** Extend tier-sync webhook to accept kyc_verified_at

These were auto-extracted from a planning session but the work lives across multiple repos:
- `unfirehose` repo — API, bucket sync, tier enforcement
- `unsandbox.com` — wallet/billing, KYC flow, key provisioning
- `unfirehose` — local scrobble client that sends data

## Questions for fox

1. Which repo owns the API key / tier enforcement? unfirehose or api-unsandbox-com?
2. KYC flow — what provider? Or is this handled by unsandbox.com wallet system?
3. Bucket sync for Ultra tier — what cloud? S3? R2? Self-hosted minio on unturf infra?
4. Free tier 7-day window — enforced server-side on unfirehose.org or client-side in this dashboard?
5. Should these todos be moved to the unfirehose repo's todo system instead?

## Plan

TBD pending architecture decisions. This is a multi-session effort spanning 3+ repos.

## Related

- Settings page plan tiers (already shipped in this repo)
- Scrobble preview page (already shipped)
- Project visibility controls (already shipped)
