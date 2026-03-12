# unfirehose — Claude Usage Sync Extension

Browser extension (Manifest V3). Works in Chrome, Firefox, Brave, Edge, Arc.

## What it does

Automatically syncs extra usage data from `claude.ai/settings/usage` to your
local unfirehose dashboard at `localhost:3000/tokens#plan`.

No clicking required. Just open the claude.ai usage page and the numbers
appear in unfirehose automatically.

## Install

**Chrome / Brave / Edge / Arc:**
1. Go to `chrome://extensions`
2. Enable "Developer mode" (top right toggle)
3. Click "Load unpacked"
4. Select this `apps/extension` folder

**Firefox:**
1. Go to `about:debugging#/runtime/this-firefox`
2. Click "Load Temporary Add-on"
3. Select `apps/extension/manifest.json`

Note: Firefox temporary add-ons are removed on browser restart.
For permanent install, the extension needs to be signed via AMO.

## How it works

Content script intercepts the `fetch`/XHR call that claude.ai makes to
`/api/account/rate_limit_status`. Parses the response, sends to the
background service worker, which POSTs to `localhost:3000/api/usage/extra`.
Falls back to DOM scraping if the API shape changes.
