# agents-ai-unturf-com: E2EE + Tool System + Purge

**Repo:** agents-ai-unturf-com
**Priority:** Medium
**Todo IDs:** 2848-2874

## Features

### 1. Room Archive + Screenshot Triggers (2848-2851)
- Add archive/screenshot scan trigger keywords
- Create `core/room_archive.py` module
- Integrate into `bot_core.py` on_message handler
- Temporary download endpoint in `core/api.py`

### 2. Matrix E2EE Support (2859-2864)
- Import MegolmEvent, enable encryption in config
- Fix access_token login to load encryption store
- Upload device keys, key management in sync loop
- Handle MegolmEvent with ignore_unverified_devices
- Deploy multiplatform_bot.py

### 3. Tool Registry + Export Pipeline (2865-2870)
- `tools/__init__.py` — registry and data classes
- `tools/export_html.py` — JSONL to Markdown to HTML
- `tools/cli.py` — CLI entry point for Makefile
- `core/tool_runner.py` — bot-side runner
- Wire into bot_core.py and keywords.py

### 4. Message Purge (2871-2874)
- Purge trigger phrases in keywords.py
- `get_bot_message_ids()` in database.py
- Platform adapter delete methods
- Wire purge into trigger chain

## Notes
E2EE is the blocker — without it the bot can't participate in encrypted rooms on unturf Matrix. Tool system depends on archive working first.
