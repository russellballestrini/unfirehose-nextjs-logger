#!/usr/bin/env node
/**
 * Scrape claude.ai/settings/usage using geckodriver (WebDriver/REST).
 * Uses real Firefox session cookies from the local browser profile.
 * No npm deps — WebDriver is plain HTTP.
 *
 * Usage: node scrape-claude-usage.mjs
 * Output: JSON on stdout { spent, limit, balance, resetDate }
 */

import { execFile, spawn } from 'child_process';
import { readFileSync, copyFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import http from 'http';

const GECKODRIVER = '/snap/bin/geckodriver';
const WD_PORT = 14444; // non-standard to avoid conflicts

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Read Firefox cookies ──────────────────────────────────────────────────────
function getFirefoxCookieDb() {
  const bases = [
    join(homedir(), 'snap/firefox/common/.mozilla/firefox'),
    join(homedir(), '.mozilla/firefox'),
  ];
  for (const base of bases) {
    try {
      const ini = readFileSync(join(base, 'profiles.ini'), 'utf-8');
      const m = ini.match(/Path=([^\n]*default[^\n]*)/i);
      if (m) return join(base, m[1].trim(), 'cookies.sqlite');
    } catch { continue; }
  }
  throw new Error('Firefox profile not found');
}

async function readCookies(dbPath) {
  const tmp = join(tmpdir(), 'uf-ff-cookies.sqlite');
  copyFileSync(dbPath, tmp); // copy to avoid lock issues
  const py = [
    'import sqlite3,json,sys',
    'c=sqlite3.connect(sys.argv[1])',
    'names=["sessionKey","cf_clearance","__cf_bm","activitySessionId","anthropic-device-id","lastActiveOrg"]',
    'rows=c.execute("SELECT name,value,host,path,isSecure,expiry FROM moz_cookies WHERE (host LIKE \'%claude.ai\') AND name IN ("+",".join("?"*len(names))+")",names).fetchall()',
    'print(json.dumps([{"name":r[0],"value":r[1],"domain":r[2],"path":r[3],"secure":bool(r[4]),"expiry":r[5]} for r in rows]))',
  ].join('\n');
  return new Promise((resolve, reject) => {
    execFile('python3', ['-c', py, tmp], (err, out, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      try { resolve(JSON.parse(out.trim())); } catch { reject(new Error('Parse fail: ' + out)); }
    });
  });
}

// ── WebDriver REST client ─────────────────────────────────────────────────────
function wdReq(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : '';
    const req = http.request({
      hostname: '127.0.0.1', port: WD_PORT,
      path, method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => {
        try {
          const j = JSON.parse(buf);
          if (j.value?.error) return reject(new Error(j.value.message || j.value.error));
          resolve(j.value);
        } catch { resolve(buf); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const cookies = await readCookies(getFirefoxCookieDb());
  if (!cookies.find(c => c.name === 'sessionKey')) throw new Error('sessionKey cookie not found');

  // Start geckodriver
  const gd = spawn(GECKODRIVER, ['--port', String(WD_PORT)], { stdio: 'pipe' });
  gd.stderr.on('data', () => {}); // suppress output

  let sessionId = null;
  try {
    await sleep(1500); // geckodriver startup

    // Create session
    const session = await wdReq('POST', '/session', {
      capabilities: {
        alwaysMatch: {
          'moz:firefoxOptions': { args: ['-headless'] },
        },
      },
    });
    sessionId = session.sessionId;
    if (!sessionId) throw new Error('No sessionId in response: ' + JSON.stringify(session));

    const go = (method, path, body) => wdReq(method, `/session/${sessionId}${path}`, body);

    // Navigate to claude.ai to establish domain context
    await go('POST', '/url', { url: 'https://claude.ai/' });
    await sleep(2000);

    // Patch navigator.webdriver to avoid bot detection
    await go('POST', '/execute/sync', {
      script: `
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3] });
      `,
      args: [],
    }).catch(() => {});

    // Inject cookies
    for (const c of cookies) {
      await go('POST', '/cookie', {
        cookie: {
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path || '/',
          secure: c.secure,
          ...(c.expiry ? { expiry: c.expiry } : {}),
        },
      }).catch(() => {}); // skip any invalid cookies silently
    }

    // Navigate to usage page
    await go('POST', '/url', { url: 'https://claude.ai/settings/usage' });
    await sleep(5000); // wait for React + data load

    // Get page text
    const pageText = await go('POST', '/execute/sync', {
      script: 'return document.body.innerText;',
      args: [],
    });

    // Parse numbers
    function grab(text, ...patterns) {
      for (const re of patterns) {
        const m = text.match(re);
        if (m) return parseFloat(m[1].replace(/,/g, ''));
      }
      return null;
    }

    const spent     = grab(pageText, /\$([\d,.]+)\s+spent/);
    const limit     = grab(pageText,
      /Monthly spend limit\s*[\n\r]+\s*\$([\d,.]+)/,
      /\$([\d,.]+)\s*[\n\r]+Monthly spend limit/);
    const balance   = grab(pageText,
      /Current balance[^$\d]*\$([\d,.]+)/,
      /\$([\d,.]+)\s*[\n\r]+Current balance/);
    const resetM    = pageText.match(/Resets\s+([A-Za-z]+ \d+)/g);
    // Find the reset date under "Extra usage" section
    const resetDate = resetM ? resetM[resetM.length - 1].replace('Resets ', '') : null;

    if (spent === null) {
      process.stderr.write('Failed to parse. Page text:\n' + pageText.slice(0, 800) + '\n');
      process.exit(1);
    }

    process.stdout.write(JSON.stringify({ spent, limit, balance, resetDate }) + '\n');

  } finally {
    if (sessionId) {
      await wdReq('DELETE', `/session/${sessionId}`, {}).catch(() => {});
    }
    gd.kill('SIGTERM');
  }
}

main().catch(e => { process.stderr.write(e.message + '\n'); process.exit(1); });
