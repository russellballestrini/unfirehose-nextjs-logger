// content.js — runs on claude.ai/settings/usage
// Intercepts the rate_limit_status XHR response and sends data to background.

(function () {
  const TARGET = '/api/account/rate_limit_status';

  // Patch XMLHttpRequest
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...args) {
    this._uf_url = url;
    return origOpen.call(this, method, url, ...args);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    if (this._uf_url && this._uf_url.includes(TARGET)) {
      this.addEventListener('load', function () {
        try {
          const data = JSON.parse(this.responseText);
          handleUsageData(data);
        } catch { /* ignore */ }
      });
    }
    return origSend.call(this, ...args);
  };

  // Patch fetch
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input?.url ?? '';
    const p = origFetch.call(this, input, init);
    if (url.includes(TARGET)) {
      p.then(res => {
        const clone = res.clone();
        clone.json().then(data => handleUsageData(data)).catch(() => {});
      }).catch(() => {});
    }
    return p;
  };

  function handleUsageData(data) {
    // claude.ai rate_limit_status response shape (observed):
    // { extra_usage: { amount_spent_minor_units, spend_limit_minor_units, balance_minor_units, reset_date } }
    // OR the numbers might be top-level — parse defensively

    let spent = null, limit = null, balance = null, resetDate = null;

    if (data?.extra_usage) {
      const eu = data.extra_usage;
      // Anthropic returns minor units (cents), divide by 100
      if (eu.amount_spent_minor_units != null) spent   = eu.amount_spent_minor_units / 100;
      if (eu.spend_limit_minor_units   != null) limit   = eu.spend_limit_minor_units   / 100;
      if (eu.balance_minor_units       != null) balance = eu.balance_minor_units       / 100;
      resetDate = eu.reset_date ?? eu.resets_at ?? null;
    } else {
      // Fallback: scrape the DOM if API shape is different
      scrapeDom();
      return;
    }

    if (spent === null) { scrapeDom(); return; }
    sendToUnfirehose({ spent, limit, balance, resetDate });
  }

  function scrapeDom() {
    // Wait for React to finish rendering
    setTimeout(() => {
      const text = document.body.innerText;

      function grab(text, ...patterns) {
        for (const re of patterns) {
          const m = text.match(re);
          if (m) return parseFloat(m[1].replace(/,/g, ''));
        }
        return null;
      }

      const spent   = grab(text, /\$([\d,.]+)\s+spent/);
      const limit   = grab(text,
        /Monthly spend limit[\s\S]{0,10}\$([\d,.]+)/,
        /\$([\d,.]+)[\s\S]{0,10}Monthly spend limit/);
      const balance = grab(text,
        /Current balance[\s\S]{0,20}\$([\d,.]+)/,
        /\$([\d,.]+)[\s\S]{0,20}Current balance/);
      const resetM  = text.match(/Extra usage[\s\S]{0,300}Resets\s+([A-Za-z]+ \d+)/);
      const resetDate = resetM ? resetM[1] : null;

      if (spent !== null) sendToUnfirehose({ spent, limit, balance, resetDate });
    }, 2000);
  }

  function sendToUnfirehose(payload) {
    chrome.runtime.sendMessage({ type: 'claude_usage', ...payload }, (resp) => {
      if (resp?.ok) {
        console.log('[unfirehose] Extra usage synced:', payload);
      }
    });
  }

  // Also scrape DOM on initial load (catches cached page renders)
  window.addEventListener('load', () => scrapeDom());
})();
