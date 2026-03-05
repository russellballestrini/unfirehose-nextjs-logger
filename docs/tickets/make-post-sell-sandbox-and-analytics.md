# make-post-sell: Sandbox Mode + Analytics + S3 Storage

**Repo:** make-post-sell
**Priority:** Medium
**Todo IDs:** 2730-2735, 2771-2788

## Features

### 1. Referrer Analytics (2730-2735)
- Add referrer_domain/referrer_query to PageSession
- Refactor classify_referrer() to return tuple
- Line chart bucketing + keyword/referrer queries
- SVG line chart macro + keyword sections in templates

### 2. Sandbox Mode (2771-2781)
- Alembic migration for sandbox_mode column
- Shop model + settings handler
- Sandbox toggle in shop_settings.j2
- Conditional toolbar + sandbox.js filter engine
- sandboxReapply hook in watch.js
- Functional tests + docs

### 3. User S3 Bucket Storage (2782-2788)
- Migration for S3 bucket columns on User
- Storage settings handler + presigned upload endpoint
- Settings UI for Artifact Storage form
- data-has-bucket attribute in base template

## Notes
Sandbox mode is the customer-facing test environment feature. S3 storage lets sellers use their own buckets for artifact hosting. Analytics gives shop owners referrer insights.
