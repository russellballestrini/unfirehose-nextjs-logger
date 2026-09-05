/**
 * What one page costs a reader, measured in a real browser.
 *
 * The number we care about is not when the server answered. Our pages render
 * on the client: the document arrives in about forty milliseconds and the
 * screen stays empty until the bundle parses, React hydrates, SWR fetches,
 * and the answer paints. Timing the document measures the fastest link in
 * that chain and reports it as the whole thing.
 *
 * So this measures, per page:
 *
 *   ttfb          the server's part, which is usually not the problem
 *   fcp           first pixel of anything — often a skeleton
 *   lcp           the browser's own guess at the main content
 *   dataOnScreen  the last DOM change that put real text on the page
 *   blocking      main-thread time in tasks over 50ms, during which nothing
 *                 responds to a click
 *
 * `dataOnScreen` is the honest one, and the reason for it is that FCP and
 * LCP both fire happily on a loading skeleton. A page can reach FCP in 200ms
 * and still show nothing a reader wanted for another four seconds.
 */

/**
 * Installed before any page script runs, so it is watching from the first
 * byte. Everything it records is relative to navigation start.
 */
const PROBE = `
(() => {
  const perf = { fcp: null, lcp: null, cls: 0, longTasks: [], lastText: 0, textLen: 0 };
  window.__perf = perf;

  const obs = (type, fn, extra) => {
    try { new PerformanceObserver(fn).observe({ type, buffered: true, ...extra }); } catch {}
  };
  obs('paint', (l) => {
    for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') perf.fcp = e.startTime;
  });
  // LCP is reported repeatedly as bigger candidates appear; the last one wins.
  obs('largest-contentful-paint', (l) => {
    for (const e of l.getEntries()) {
      perf.lcp = e.startTime;
      // Which element, so a slow LCP names its own cause instead of being a
      // number to stare at.
      const el = e.element;
      perf.lcpEl = el
        ? \`\${el.tagName.toLowerCase()}\${el.className ? '.' + String(el.className).split(/\\s+/)[0] : ''} \${(el.innerText ?? '').trim().slice(0, 48)}\`.trim()
        : (e.url ? 'url ' + e.url.slice(-48) : 'unknown');
    }
  });
  obs('layout-shift', (l) => {
    for (const e of l.getEntries()) if (!e.hadRecentInput) perf.cls += e.value;
  });
  obs('longtask', (l) => {
    for (const e of l.getEntries()) perf.longTasks.push({ start: e.startTime, dur: e.duration });
  });

  // When did the page last put real text on screen?
  //
  // A skeleton is mostly empty boxes, so growth in visible text length is a
  // good proxy for "the answer arrived". Spinners and clocks tick without
  // changing much, which is why this needs a meaningful jump rather than any
  // mutation at all.
  const MEANINGFUL = 40;
  const measure = () => {
    const len = (document.body?.innerText ?? '').length;
    if (len - perf.textLen >= MEANINGFUL) {
      perf.textLen = len;
      perf.lastText = performance.now();
    }
  };
  const start = () => {
    measure();
    new MutationObserver(() => {
      // Coalesce: a React commit fires many mutations for one visible change.
      clearTimeout(perf._t);
      perf._t = setTimeout(measure, 16);
    }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  };
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
`;

/** Requests we count as "the page asking our server for data". */
const isApi = (url) => url.includes("/api/");

/**
 * @param cold  Disable the HTTP cache, so this measures a first visit.
 *   A warm run measures the second visit to the same page in the same
 *   browser, which is the visit nobody complains about — and it silently
 *   reports zero bytes transferred, because nothing was.
 */
export async function measurePage(browser, url, { settleMs = 700, capMs = 25_000, cold = true } = {}) {
  const page = await browser.newPage();
  const requests = new Map();
  const done = [];
  let lastNetworkAt = 0;

  const off = page.on((msg) => {
    if (msg.sessionId !== page.sessionId) return;
    const p = msg.params;
    if (msg.method === 'Network.requestWillBeSent') {
      requests.set(p.requestId, { url: p.request.url, start: p.timestamp * 1000, type: p.type });
      lastNetworkAt = Date.now();
    } else if (msg.method === 'Network.responseReceived') {
      const r = requests.get(p.requestId);
      if (r) { r.status = p.response.status; r.mime = p.response.mimeType; r.type = p.type ?? r.type; }
    } else if (msg.method === 'Network.loadingFinished') {
      const r = requests.get(p.requestId);
      if (r) {
        r.end = p.timestamp * 1000;
        r.bytes = p.encodedDataLength ?? 0;
        done.push(r);
      }
      lastNetworkAt = Date.now();
    } else if (msg.method === 'Network.loadingFailed') {
      requests.delete(p.requestId);
      lastNetworkAt = Date.now();
    }
  });

  try {
    await page.send('Page.enable');
    await page.send('Network.enable');
    await page.send('Network.setCacheDisabled', { cacheDisabled: cold });
    await page.send('Runtime.enable');
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });

    // Watch for the page giving up on us, so a failure says why rather than
    // reporting a dash that reads like "fast".
    const problems = [];
    const offFail = page.on((msg) => {
      if (msg.sessionId !== page.sessionId) return;
      if (msg.method === 'Inspector.targetCrashed') problems.push('renderer crashed');
      if (msg.method === 'Page.loadEventFired') loaded = true;
    });
    let loaded = false;

    const t0 = Date.now();
    const nav = await page.send('Page.navigate', { url });
    if (nav.errorText) problems.push(`navigation failed: ${nav.errorText}`);

    // Wait for the load event before judging quiet. Without this the settle
    // loop can start and finish while the tab is still on about:blank, which
    // reports a page as instant precisely when it was too slow to arrive.
    const loadDeadline = Date.now() + capMs;
    while (!loaded && Date.now() < loadDeadline && !problems.length) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!loaded) problems.push(`no load event within ${capMs}ms`);

    // Settle: quiet network and no new text for `settleMs`, or give up at the
    // cap. Pages here poll on a timer, so "quiet" has to be short enough to
    // land between refreshes.
    lastNetworkAt = Date.now();
    let lastText = 0;
    for (;;) {
      await new Promise((r) => setTimeout(r, 100));
      const { result } = await page.send('Runtime.evaluate', {
        expression: 'JSON.stringify({ t: window.__perf?.lastText ?? 0 })',
        returnByValue: true,
      }).catch(() => ({ result: { value: '{"t":0}' } }));
      const t = JSON.parse(result.value ?? '{"t":0}').t;
      if (t !== lastText) { lastText = t; lastNetworkAt = Math.max(lastNetworkAt, Date.now()); }
      if (Date.now() - lastNetworkAt > settleMs) break;
      if (Date.now() - t0 > capMs) break;
    }
    offFail();

    const { result } = await page.send('Runtime.evaluate', {
      expression: `JSON.stringify((() => {
        const p = window.__perf ?? {};
        const nav = performance.getEntriesByType('navigation')[0] ?? {};
        return {
          ttfb: nav.responseStart ?? null,
          domInteractive: nav.domInteractive ?? null,
          fcp: p.fcp, lcp: p.lcp, lcpEl: p.lcpEl ?? null, cls: p.cls,
          fonts: performance.getEntriesByType('resource').filter(r => /\\.(woff2?|ttf)$/.test(r.name)).map(r => ({ n: r.name.split('/').pop(), end: Math.round(r.responseEnd) })),
          dataOnScreen: p.lastText || null,
          textLen: p.textLen ?? 0,
          longTasks: p.longTasks ?? [],
          title: document.title,
        };
      })())`,
      returnByValue: true,
    });
    const m = JSON.parse(result.value);

    const api = done.filter((r) => isApi(r.url) && r.end);
    const slowest = api.slice().sort((a, b) => (b.end - b.start) - (a.end - a.start))[0];
    const bytes = done.reduce((s, r) => s + (r.bytes ?? 0), 0);
    const jsBytes = done
      .filter((r) => r.type === 'Script' || /javascript/.test(r.mime ?? ''))
      .reduce((s, r) => s + (r.bytes ?? 0), 0);

    // Total blocking time: the part of each long task over 50ms. This is the
    // window in which a click does nothing at all.
    const blocking = (m.longTasks ?? []).reduce((s, t) => s + Math.max(0, t.dur - 50), 0);

    // A page with no text and no requests was not measured, whatever the
    // timings say. Saying so is the whole point: a silent dash in the
    // "slowest pages" column hides exactly the pages worth finding.
    if (!m.textLen && done.length === 0) problems.push('nothing loaded — no requests and no text');

    return {
      url,
      cold,
      failed: problems.length ? problems.join('; ') : null,
      title: m.title,
      ttfb: m.ttfb,
      fcp: m.fcp,
      lcp: m.lcp,
      lcpEl: m.lcpEl,
      fonts: m.fonts ?? [],
      dataOnScreen: m.dataOnScreen,
      domInteractive: m.domInteractive,
      cls: Number((m.cls ?? 0).toFixed(3)),
      blocking: Math.round(blocking),
      requests: done.length,
      bytes,
      jsBytes,
      apiCalls: api.length,
      slowestApi: slowest
        ? { url: new URL(slowest.url).pathname + new URL(slowest.url).search, ms: Math.round(slowest.end - slowest.start) }
        : null,
      // Every API call this page made, slowest first — this is what points at
      // the thing to fix.
      api: api
        .map((r) => ({ path: new URL(r.url).pathname + new URL(r.url).search, ms: Math.round(r.end - r.start), bytes: r.bytes ?? 0 }))
        .sort((a, b) => b.ms - a.ms),
    };
  } finally {
    off();
    await page.close().catch(() => {});
  }
}

/**
 * Get past the vault gate, once, before measuring anything.
 *
 * A fresh browser profile has no vault, and every route renders the unlock
 * screen instead of the page. Without this the whole report measures one
 * screen fourteen times and calls it fourteen pages — which is exactly what
 * it did until a screenshot said otherwise.
 *
 * Skipping is what the gate itself offers ("skip it and you can still browse
 * everything"); it creates a vault with a random password. That lands in
 * localStorage, which outlives the tab and survives a disabled HTTP cache,
 * so one pass covers the run.
 */
export async function unlockVault(browser, base) {
  const page = await browser.newPage();
  try {
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Page.navigate', { url: base });

    const clickSkip = `(() => {
      const b = [...document.querySelectorAll('button')].find(x => /^skip/i.test((x.textContent ?? '').trim()));
      if (b) { b.click(); return 'clicked'; }
      return document.body.innerText.includes('Unlock vault') || document.body.innerText.includes('Create your vault')
        ? 'waiting' : 'no gate';
    })()`;

    const deadline = Date.now() + 30_000;
    for (;;) {
      const { result } = await page.send('Runtime.evaluate', { expression: clickSkip, returnByValue: true })
        .catch(() => ({ result: { value: 'waiting' } }));
      if (result.value === 'clicked' || result.value === 'no gate') break;
      if (Date.now() > deadline) throw new Error('vault gate never went away');
      await new Promise((r) => setTimeout(r, 200));
    }

    // Wait for the gate to actually go, not just for the click to land —
    // creating a vault derives a key, which is deliberately slow.
    const gone = Date.now() + 30_000;
    for (;;) {
      const { result } = await page.send('Runtime.evaluate', {
        expression: `!/Unlock vault|Create your vault|Choose a password/.test(document.body.innerText)`,
        returnByValue: true,
      }).catch(() => ({ result: { value: false } }));
      if (result.value) return;
      if (Date.now() > gone) throw new Error('vault did not unlock');
      await new Promise((r) => setTimeout(r, 200));
    }
  } finally {
    await page.close().catch(() => {});
  }
}
