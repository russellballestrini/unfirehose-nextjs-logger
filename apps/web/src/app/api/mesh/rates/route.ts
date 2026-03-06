import { NextResponse } from 'next/server';
import { getSetting } from '@unfirehose/core/db/ingest';

/**
 * GET /api/mesh/rates
 *
 * Returns currency conversion rates (USD base) for both fiat and crypto.
 * Uses the free, open-source Frankfurt ECB API for fiat (no key needed)
 * and CoinGecko free tier for crypto (no key needed, 10-30 rpm).
 *
 * Cached for 1 hour. Disabled if settings.mesh_currency_oracle === 'false'.
 */

interface RatesCache {
  fiat: Record<string, number>;
  crypto: Record<string, number>;
  source: string;
  updatedAt: string;
  fetchedAt: number;
}

let cache: RatesCache | null = null;
const CACHE_TTL = 3600_000; // 1 hour

const FIAT_CURRENCIES = ['EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'CNY', 'INR', 'BRL', 'KRW', 'MXN', 'SEK', 'NOK', 'PLN', 'CZK'];
const CRYPTO_IDS = ['bitcoin', 'ethereum', 'solana', 'monero', 'litecoin'];
const CRYPTO_SYMBOLS: Record<string, string> = {
  bitcoin: 'BTC', ethereum: 'ETH', solana: 'SOL', monero: 'XMR', litecoin: 'LTC',
};

async function fetchFiatRates(): Promise<Record<string, number>> {
  try {
    // Frankfurter API — free, open source, ECB data, no API key
    // https://github.com/hakanensari/frankfurter — MIT license
    const res = await fetch('https://api.frankfurter.dev/v1/latest?base=USD', { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return {};
    const data = await res.json();
    const rates: Record<string, number> = {};
    for (const cur of FIAT_CURRENCIES) {
      if (data.rates?.[cur]) rates[cur] = data.rates[cur];
    }
    return rates;
  } catch {
    return {};
  }
}

async function fetchCryptoRates(): Promise<Record<string, number>> {
  try {
    // CoinGecko free API — no key needed, generous rate limits
    // Returns price per 1 USD worth of crypto (i.e., 1/price)
    const ids = CRYPTO_IDS.join(',');
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return {};
    const data = await res.json();
    const rates: Record<string, number> = {};
    for (const id of CRYPTO_IDS) {
      const price = data[id]?.usd;
      if (price && price > 0) {
        rates[CRYPTO_SYMBOLS[id] ?? id.toUpperCase()] = 1 / price;
      }
    }
    return rates;
  } catch {
    return {};
  }
}

export async function GET() {
  // Check if oracle is disabled
  const oracleEnabled = getSetting('mesh_currency_oracle');
  if (oracleEnabled === 'false') {
    return NextResponse.json({ disabled: true, fiat: {}, crypto: {}, source: 'disabled', updatedAt: '' });
  }

  // Return cache if fresh
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL) {
    return NextResponse.json(cache);
  }

  // Fetch in parallel
  const [fiat, crypto] = await Promise.all([fetchFiatRates(), fetchCryptoRates()]);

  cache = {
    fiat,
    crypto,
    source: 'Frankfurter (ECB) + CoinGecko',
    updatedAt: new Date().toISOString(),
    fetchedAt: Date.now(),
  };

  return NextResponse.json(cache);
}
