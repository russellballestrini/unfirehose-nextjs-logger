'use client';

import useSWR from 'swr';

const fetcher = (url: string) => fetch(url).then((r) => r.json());

// Symbol prefixes for known currencies
const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$', EUR: '\u20ac', GBP: '\u00a3', JPY: '\u00a5', CAD: 'C$', AUD: 'A$',
  CHF: 'CHF ', CNY: '\u00a5', INR: '\u20b9', BRL: 'R$', KRW: '\u20a9',
  MXN: 'MX$', SEK: 'kr ', NOK: 'kr ', PLN: 'z\u0142', CZK: 'K\u010d ',
  BTC: '\u20bf', ETH: '\u039e', SOL: 'SOL ', XMR: 'XMR ', LTC: '\u0141',
};

// Crypto needs more decimal places
const CRYPTO_CODES = new Set(['BTC', 'ETH', 'SOL', 'XMR', 'LTC']);

export interface CurrencyFormatter {
  /** Format a USD amount in the user's chosen currency */
  format: (usd: number) => string;
  /** The currency code (e.g. "EUR", "BTC") */
  code: string;
  /** The conversion rate from USD */
  rate: number;
  /** Whether rates are still loading */
  loading: boolean;
}

export function useCurrency(): CurrencyFormatter {
  const { data: settings } = useSWR('/api/settings', fetcher, { revalidateOnFocus: false });
  const code = settings?.display_currency || 'USD';

  const { data: rates, isLoading } = useSWR(
    code !== 'USD' ? '/api/mesh/rates' : null,
    fetcher,
    { revalidateOnFocus: false, refreshInterval: 3600_000 }
  );

  const rate = code === 'USD'
    ? 1
    : (rates?.fiat?.[code] ?? rates?.crypto?.[code] ?? null);

  const format = (usd: number): string => {
    if (code === 'USD' || rate === null) {
      return formatUSD(usd);
    }
    const converted = usd * rate;
    const sym = CURRENCY_SYMBOLS[code] ?? `${code} `;
    if (CRYPTO_CODES.has(code)) {
      // Show enough precision for crypto
      if (converted < 0.0001) return `${sym}${converted.toExponential(2)}`;
      if (converted < 1) return `${sym}${converted.toPrecision(4)}`;
      return `${sym}${converted.toFixed(4)}`;
    }
    // Fiat
    if (converted >= 1) return `${sym}${converted.toFixed(2)}`;
    if (converted >= 0.01) return `${sym}${converted.toFixed(2)}`;
    if (converted > 0) return `${sym}${converted.toFixed(4)}`;
    return `${sym}0.00`;
  };

  return { format, code, rate: rate ?? 1, loading: isLoading };
}

function formatUSD(usd: number): string {
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(2)}`;
  if (usd > 0) return `$${usd.toFixed(4)}`;
  return '$0.00';
}

export const AVAILABLE_CURRENCIES = [
  { code: 'USD', label: 'USD — US Dollar' },
  { code: 'EUR', label: 'EUR — Euro' },
  { code: 'GBP', label: 'GBP — British Pound' },
  { code: 'JPY', label: 'JPY — Japanese Yen' },
  { code: 'CAD', label: 'CAD — Canadian Dollar' },
  { code: 'AUD', label: 'AUD — Australian Dollar' },
  { code: 'CHF', label: 'CHF — Swiss Franc' },
  { code: 'CNY', label: 'CNY — Chinese Yuan' },
  { code: 'INR', label: 'INR — Indian Rupee' },
  { code: 'BRL', label: 'BRL — Brazilian Real' },
  { code: 'KRW', label: 'KRW — Korean Won' },
  { code: 'MXN', label: 'MXN — Mexican Peso' },
  { code: 'SEK', label: 'SEK — Swedish Krona' },
  { code: 'NOK', label: 'NOK — Norwegian Krone' },
  { code: 'PLN', label: 'PLN — Polish Zloty' },
  { code: 'CZK', label: 'CZK — Czech Koruna' },
  { code: 'BTC', label: 'BTC — Bitcoin' },
  { code: 'ETH', label: 'ETH — Ethereum' },
  { code: 'SOL', label: 'SOL — Solana' },
  { code: 'XMR', label: 'XMR — Monero' },
  { code: 'LTC', label: 'LTC — Litecoin' },
];
