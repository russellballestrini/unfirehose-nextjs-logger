// background.js — intercept claude.ai rate_limit_status API response
// MV3 service worker: can't read response bodies via webRequest, so we
// rely on the content script to post the parsed data here.

const UNFIREHOSE_URL = 'http://localhost:3000/api/usage/extra';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'claude_usage') return;

  const { spent, limit, balance, resetDate } = msg;
  fetch(UNFIREHOSE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ spent, limit, balance, resetDate }),
  })
    .then(r => r.json())
    .then(data => sendResponse({ ok: true, data }))
    .catch(err => sendResponse({ ok: false, err: err.message }));

  return true; // keep message channel open for async response
});
