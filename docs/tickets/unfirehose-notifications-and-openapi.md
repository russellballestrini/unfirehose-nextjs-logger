# unfirehose: Notifications + OpenAPI + Architecture

**Repo:** unfirehose
**Priority:** Medium-High
**Todo IDs:** 2935-2938, 2969-2978

## Features

### 1. Architecture Rewrite (2935-2938)
- Vultr Dallas edge proxy in architecture
- Three-bucket-per-cloud storage model
- Update all diagrams for new topology
- Vultr-primary with bootstrap/startup modes

### 2. PubSub + Notifications (2969-2971)
- PubSub + SSE notification infrastructure
- Webhook delivery for offline followers
- Email digest worker with Swoosh

### 3. Reliability (2974-2975)
- Webhook secret rotation
- Digest retry queue

### 4. Quality (2972, 2976-2978)
- Tests + compile verification
- OpenAPI spec via open_api_spex
- Controller tests (all endpoints)
- Worker/email tests

## Notes
Architecture rewrite (#1) is planning — should be a design doc before implementation. Notifications (#2) is the main user-facing feature. OpenAPI (#4) would make the scrobble onboarding much easier.
