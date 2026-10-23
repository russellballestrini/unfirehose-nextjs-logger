import type { ReportCurrency } from '@unturf/unfirehose/cost-report';

/**
 * The one rate a monthly cost report converts at.
 *
 * A claim wants a figure that does not move, so this is the published rate
 * for a fixed day — the month's last, or today for a month still running —
 * not the live rate our pages show. Fiat comes from the ECB through
 * Frankfurter (the source /api/mesh/rates already uses), crypto from
 * CoinGecko's daily history. Whatever cannot be had leaves the report in
 * dollars and says why: an unconverted number under a foreign currency
 * would be the one thing worse than a dollar figure.
 */

const COINGECKO_ID: Record<string, string> = {
  BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', XMR: 'monero', LTC: 'litecoin',
  DOGE: 'dogecoin', XRP: 'ripple', ADA: 'cardano', DOT: 'polkadot', AVAX: 'avalanche-2',
  MATIC: 'matic-network', LINK: 'chainlink', UNI: 'uniswap', ZEC: 'zcash',
};

const USD: ReportCurrency = { code: 'USD', rate: 1, rateDate: null, source: null };
const fallback = (code: string, reason: string): ReportCurrency => ({ ...USD, fallbackReason: `${code} unavailable: ${reason}` });

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** The primary display currency from settings: the first of `display_currency`. */
export function reportCurrencyCode(settings: Record<string, string | undefined>): string {
  return String(settings.display_currency || 'USD').split(',').map((s) => s.trim()).filter(Boolean)[0] || 'USD';
}

/** The day a month's rate is for: its last day, or today while it runs. YYYY-MM-DD. */
export function rateDateFor(month: string, now = new Date()): string {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const today = now.toISOString().slice(0, 10);
  return last < today ? last : today;
}

export async function reportRate(
  code: string,
  date: string,
  opts: { oracleDisabled?: boolean; fetch?: Fetch } = {},
): Promise<ReportCurrency> {
  if (code === 'USD') return USD;
  if (opts.oracleDisabled) return fallback(code, 'the currency oracle is turned off in settings');
  const get = opts.fetch ?? fetch;
  try {
    const id = COINGECKO_ID[code];
    if (id) {
      const [y, mo, d] = date.split('-');
      const res = await get(`https://api.coingecko.com/api/v3/coins/${id}/history?date=${d}-${mo}-${y}&localization=false`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return fallback(code, `CoinGecko answered ${res.status}`);
      const price = (await res.json())?.market_data?.current_price?.usd;
      if (!(price > 0)) return fallback(code, `CoinGecko has no price for ${date}`);
      return { code, rate: 1 / price, rateDate: date, source: 'CoinGecko daily history' };
    }
    const res = await get(`https://api.frankfurter.dev/v1/${date}?base=USD&symbols=${encodeURIComponent(code)}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return fallback(code, `Frankfurter answered ${res.status}`);
    const body = await res.json();
    const rate = body?.rates?.[code];
    if (!(rate > 0)) return fallback(code, 'the ECB does not publish this currency');
    // The ECB publishes on working days; Frankfurter answers with the last
    // one on or before the day asked, and says which.
    return { code, rate, rateDate: body.date ?? date, source: 'ECB via Frankfurter' };
  } catch (err) {
    return fallback(code, (err as Error).name === 'TimeoutError' ? 'the rate source timed out' : 'the rate source could not be reached');
  }
}
