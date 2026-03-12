// ==UserScript==
// @name         unfirehose — Claude Usage Sync
// @namespace    https://unfirehose.com
// @version      1.0.0
// @description  Syncs claude.ai extra usage (card charges) to your local unfirehose dashboard
// @author       unturf
// @match        https://claude.ai/settings/usage*
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        unsafeWindow
// @connect      localhost
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const UNFIREHOSE = 'http://localhost:3000/api/usage/extra';
  const TARGET = '/api/account/rate_limit_status';
  // unsafeWindow = actual page window, required in Firefox to patch fetch/XHR
  const win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

  function post(payload) {
    const body = JSON.stringify(payload);
    const fn = (typeof GM !== 'undefined' && GM.xmlHttpRequest) ? GM.xmlHttpRequest : GM_xmlhttpRequest;
    fn({
      method: 'POST',
      url: UNFIREHOSE,
      headers: { 'Content-Type': 'application/json' },
      data: body,
      onload: (r) => console.log('[unfirehose] synced:', JSON.parse(r.responseText)),
      onerror: (e) => console.warn('[unfirehose] sync failed:', e),
    });
  }

  function parseAndPost(data) {
    let spent = null, limit = null, balance = null, resetDate = null;

    // Try structured API response first
    if (data?.extra_usage) {
      const eu = data.extra_usage;
      if (eu.amount_spent_minor_units != null) spent   = eu.amount_spent_minor_units / 100;
      if (eu.spend_limit_minor_units   != null) limit   = eu.spend_limit_minor_units   / 100;
      if (eu.balance_minor_units       != null) balance = eu.balance_minor_units       / 100;
      resetDate = eu.reset_date ?? eu.resets_at ?? null;
    }

    // Fallback: DOM scrape (runs after React renders)
    if (spent === null) {
      setTimeout(() => {
        const txt = document.body.innerText;
        function grab(...res) {
          for (const re of res) { const m = txt.match(re); if (m) return parseFloat(m[1].replace(/,/g, '')); }
          return null;
        }
        spent   = grab(/\$([\d,.]+)\s+spent/);
        limit   = grab(/\$([\d,.]+)\n(?:Adjust limit\n)?Monthly spend limit/);
        balance = grab(/Current balance[\s\S]{0,20}\$([\d,.]+)/, /\$([\d,.]+)[\s\S]{0,20}Current balance/);
        const rm = txt.match(/Extra usage[\s\S]{0,300}Resets\s+([A-Za-z]+ \d+)/);
        resetDate = rm ? rm[1] : null;
        if (spent !== null) post({ spent, limit, balance, resetDate });
      }, 2500);
      return;
    }

    post({ spent, limit, balance, resetDate });
  }

  // Intercept fetch (must use unsafeWindow in Firefox)
  const origFetch = win.fetch.bind(win);
  win.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input?.url ?? '');
    const p = origFetch(input, init);
    if (url.includes(TARGET)) {
      p.then(res => res.clone().json().then(parseAndPost).catch(() => {})).catch(() => {});
    }
    return p;
  };

  // Intercept XHR (must use unsafeWindow in Firefox)
  const origOpen = win.XMLHttpRequest.prototype.open;
  win.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._uf_url = url;
    return origOpen.call(this, method, url, ...rest);
  };
  const origSend = win.XMLHttpRequest.prototype.send;
  win.XMLHttpRequest.prototype.send = function (...rest) {
    if (this._uf_url?.includes(TARGET)) {
      this.addEventListener('load', function () {
        try { parseAndPost(JSON.parse(this.responseText)); } catch {}
      });
    }
    return origSend.call(this, ...rest);
  };

  // Also scrape DOM on page load
  win.addEventListener('load', () => parseAndPost({}));
})();
