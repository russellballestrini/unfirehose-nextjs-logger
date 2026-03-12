#!/usr/bin/env node

import { loadConfig } from './config';
import { Router } from './router';

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
unfirehose-router — lightweight daemon that forwards Claude Code events to unfirehose.com

Usage:
  unfirehose-router              Start the router daemon
  unfirehose-router --status     Show current config and cursor state
  unfirehose-router --help       Show this help

Config: ~/.unfirehose.json
  {
    "api_key": "unfh_YOUR_KEY_HERE",
    "endpoint": "https://api.unfirehose.org/api/ingest",
    "watch_paths": ["~/.claude/"],
    "batch_size": 100,
    "flush_interval_ms": 5000
  }

The router watches your Claude Code JSONL files and forwards new events
to the cloud dashboard. It tracks cursor positions per file so it never
re-sends data, even after restarts.

Cursors: ~/.unfirehose-cursors.json
`);
  process.exit(0);
}

let config;
try {
  config = loadConfig();
} catch (err) {
  console.warn(`[router] ${err instanceof Error ? err.message : err}`);
  console.warn('[router] skipping — router is optional without config');
  process.exit(0);
}

if (args.includes('--status')) {
  console.log('Config:', JSON.stringify(config, null, 2));
  const { loadCursors } = await import('./config');
  const cursors = loadCursors();
  const count = Object.keys(cursors).length;
  console.log(`\nTracking ${count} files`);
  for (const [file, pos] of Object.entries(cursors)) {
    console.log(`  ${file}: ${pos} bytes`);
  }
  process.exit(0);
}

const router = new Router(config);
router.start();

console.log('unfirehose-router running. Press Ctrl+C to stop.\n');
