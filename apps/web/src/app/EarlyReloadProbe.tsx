/**
 * Early (pre-hydration) interceptor for window.location.reload / assign /
 * replace and history.go. Runs as a synchronous inline script in <head>
 * via Next's Script(strategy="beforeInteractive"), so Turbopack's HMR
 * client — which caches Location.prototype.reload at boot — gets our
 * wrapped version instead of the original.
 *
 * The wrapped functions write a tiny breadcrumb to sessionStorage that
 * DevReloadProbe picks up on the next page load and renders into the
 * red corner banner with the original stack trace.
 *
 * Production builds skip this — it's only meaningful for dev-mode HMR
 * spuriously triggering full refreshes.
 */
import Script from 'next/script';

const INLINE = `
(function () {
  if (typeof window === 'undefined') return;
  var KEY = 'unfh_reload_probe_v1';
  function rec(cause, detail) {
    try {
      var rec = {
        at: Date.now(),
        url: location.pathname + location.search,
        cause: cause,
        detail: String(detail || '').slice(0, 600),
      };
      sessionStorage.setItem(KEY, JSON.stringify(rec));
    } catch (e) {}
  }
  function stackHere() {
    try { return (new Error().stack || '').split('\\n').slice(2, 7).join(' | '); } catch (e) { return ''; }
  }
  // ---- location.reload / assign / replace ----
  try {
    var origReload = Location.prototype.reload;
    Location.prototype.reload = function () { rec('reload(EARLY)', stackHere()); return origReload.apply(this, arguments); };
    var origAssign = Location.prototype.assign;
    Location.prototype.assign = function (u) { rec('assign(EARLY)', String(u) + ' :: ' + stackHere()); return origAssign.apply(this, arguments); };
    var origReplace = Location.prototype.replace;
    Location.prototype.replace = function (u) { rec('replace(EARLY)', String(u) + ' :: ' + stackHere()); return origReplace.apply(this, arguments); };
  } catch (e) {}
  // ---- history.go / pushState reload-loops ----
  try {
    var origGo = History.prototype.go;
    History.prototype.go = function (n) {
      if (n === 0 || typeof n === 'undefined') rec('history.go(0)', stackHere());
      return origGo.apply(this, arguments);
    };
  } catch (e) {}
})();
`;

export function EarlyReloadProbe() {
  if (process.env.NODE_ENV === 'production') return null;
  return (
    <Script id="early-reload-probe" strategy="beforeInteractive">
      {INLINE}
    </Script>
  );
}
