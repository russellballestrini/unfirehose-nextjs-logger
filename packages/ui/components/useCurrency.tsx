'use client';

import useSWR from 'swr';
import { fetcher } from './fetcher';

/**
 * Showing costs in the currency someone actually thinks in.
 *
 * This used to keep three parallel tables — a symbol map, a set of crypto
 * codes, and the list offered in settings — and they had already drifted:
 * FJD carried a symbol but appeared in no list, so nothing could ever select
 * it. One row per currency, with the other two derived, makes that shape of
 * mistake unrepresentable.
 */

export interface Currency {
  code: string;
  label: string;
  /** How settings groups it, and how we know what needs crypto precision. */
  group: 'Major' | 'Asia-Pacific' | 'Americas' | 'Europe' | 'Middle East & Africa' | 'Crypto';
  /** Prefix, including any trailing space it needs. */
  symbol: string;
}

export const AVAILABLE_CURRENCIES: Currency[] = [
  // Major
  { code: 'USD', label: 'US Dollar', group: 'Major', symbol: '$' },
  { code: 'EUR', label: 'Euro', group: 'Major', symbol: '\u20ac' },
  { code: 'GBP', label: 'British Pound', group: 'Major', symbol: '\u00a3' },
  { code: 'JPY', label: 'Japanese Yen', group: 'Major', symbol: '\u00a5' },
  { code: 'CAD', label: 'Canadian Dollar', group: 'Major', symbol: 'C$' },
  { code: 'AUD', label: 'Australian Dollar', group: 'Major', symbol: 'A$' },
  { code: 'CHF', label: 'Swiss Franc', group: 'Major', symbol: 'CHF ' },
  { code: 'CNY', label: 'Chinese Yuan', group: 'Major', symbol: '\u00a5' },

  // Asia-Pacific
  { code: 'INR', label: 'Indian Rupee', group: 'Asia-Pacific', symbol: '\u20b9' },
  { code: 'KRW', label: 'Korean Won', group: 'Asia-Pacific', symbol: '\u20a9' },
  { code: 'HKD', label: 'Hong Kong Dollar', group: 'Asia-Pacific', symbol: 'HK$' },
  { code: 'SGD', label: 'Singapore Dollar', group: 'Asia-Pacific', symbol: 'S$' },
  { code: 'TWD', label: 'Taiwan Dollar', group: 'Asia-Pacific', symbol: 'NT$' },
  { code: 'THB', label: 'Thai Baht', group: 'Asia-Pacific', symbol: '\u0e3f' },
  { code: 'PHP', label: 'Philippine Peso', group: 'Asia-Pacific', symbol: '\u20b1' },
  { code: 'IDR', label: 'Indonesian Rupiah', group: 'Asia-Pacific', symbol: 'Rp ' },
  { code: 'MYR', label: 'Malaysian Ringgit', group: 'Asia-Pacific', symbol: 'RM ' },
  { code: 'VND', label: 'Vietnamese Dong', group: 'Asia-Pacific', symbol: '\u20ab' },
  { code: 'NZD', label: 'New Zealand Dollar', group: 'Asia-Pacific', symbol: 'NZ$' },
  { code: 'PKR', label: 'Pakistani Rupee', group: 'Asia-Pacific', symbol: 'Rs ' },
  { code: 'BDT', label: 'Bangladeshi Taka', group: 'Asia-Pacific', symbol: '\u09f3' },
  { code: 'LKR', label: 'Sri Lankan Rupee', group: 'Asia-Pacific', symbol: 'Rs ' },
  { code: 'NPR', label: 'Nepalese Rupee', group: 'Asia-Pacific', symbol: 'Rs ' },

  // Americas
  { code: 'BRL', label: 'Brazilian Real', group: 'Americas', symbol: 'R$' },
  { code: 'MXN', label: 'Mexican Peso', group: 'Americas', symbol: 'MX$' },
  { code: 'ARS', label: 'Argentine Peso', group: 'Americas', symbol: 'AR$' },
  { code: 'CLP', label: 'Chilean Peso', group: 'Americas', symbol: 'CL$' },
  { code: 'COP', label: 'Colombian Peso', group: 'Americas', symbol: 'CO$' },
  { code: 'PEN', label: 'Peruvian Sol', group: 'Americas', symbol: 'S/' },
  { code: 'UYU', label: 'Uruguayan Peso', group: 'Americas', symbol: '$U ' },

  // Europe
  { code: 'SEK', label: 'Swedish Krona', group: 'Europe', symbol: 'kr ' },
  { code: 'NOK', label: 'Norwegian Krone', group: 'Europe', symbol: 'kr ' },
  { code: 'DKK', label: 'Danish Krone', group: 'Europe', symbol: 'kr ' },
  { code: 'PLN', label: 'Polish Zloty', group: 'Europe', symbol: 'z\u0142' },
  { code: 'CZK', label: 'Czech Koruna', group: 'Europe', symbol: 'K\u010d ' },
  { code: 'HUF', label: 'Hungarian Forint', group: 'Europe', symbol: 'Ft ' },
  { code: 'RON', label: 'Romanian Leu', group: 'Europe', symbol: 'lei ' },
  { code: 'BGN', label: 'Bulgarian Lev', group: 'Europe', symbol: 'лв ' },
  { code: 'HRK', label: 'Croatian Kuna', group: 'Europe', symbol: 'kn ' },
  { code: 'RSD', label: 'Serbian Dinar', group: 'Europe', symbol: 'din ' },
  { code: 'ISK', label: 'Icelandic Krona', group: 'Europe', symbol: 'kr ' },
  { code: 'TRY', label: 'Turkish Lira', group: 'Europe', symbol: '\u20ba' },
  { code: 'RUB', label: 'Russian Ruble', group: 'Europe', symbol: '\u20bd' },
  { code: 'UAH', label: 'Ukrainian Hryvnia', group: 'Europe', symbol: '\u20b4' },

  // Middle East & Africa
  { code: 'ILS', label: 'Israeli Shekel', group: 'Middle East & Africa', symbol: '\u20aa' },
  { code: 'AED', label: 'UAE Dirham', group: 'Middle East & Africa', symbol: 'AED ' },
  { code: 'SAR', label: 'Saudi Riyal', group: 'Middle East & Africa', symbol: 'SAR ' },
  { code: 'EGP', label: 'Egyptian Pound', group: 'Middle East & Africa', symbol: 'E\u00a3' },
  { code: 'ZAR', label: 'South African Rand', group: 'Middle East & Africa', symbol: 'R ' },
  { code: 'NGN', label: 'Nigerian Naira', group: 'Middle East & Africa', symbol: '\u20a6' },
  { code: 'KES', label: 'Kenyan Shilling', group: 'Middle East & Africa', symbol: 'KSh ' },
  { code: 'GHS', label: 'Ghanaian Cedi', group: 'Middle East & Africa', symbol: 'GH\u20b5' },

  // Crypto
  { code: 'BTC', label: 'Bitcoin', group: 'Crypto', symbol: '\u20bf' },
  { code: 'ETH', label: 'Ethereum', group: 'Crypto', symbol: '\u039e' },
  { code: 'SOL', label: 'Solana', group: 'Crypto', symbol: 'SOL ' },
  { code: 'XMR', label: 'Monero', group: 'Crypto', symbol: 'XMR ' },
  { code: 'LTC', label: 'Litecoin', group: 'Crypto', symbol: '\u0141' },
  { code: 'DOGE', label: 'Dogecoin', group: 'Crypto', symbol: '\u00d0' },
  { code: 'XRP', label: 'XRP', group: 'Crypto', symbol: 'XRP ' },
  { code: 'ADA', label: 'Cardano', group: 'Crypto', symbol: 'ADA ' },
  { code: 'DOT', label: 'Polkadot', group: 'Crypto', symbol: 'DOT ' },
  { code: 'AVAX', label: 'Avalanche', group: 'Crypto', symbol: 'AVAX ' },
  { code: 'MATIC', label: 'Polygon', group: 'Crypto', symbol: 'MATIC ' },
  { code: 'LINK', label: 'Chainlink', group: 'Crypto', symbol: 'LINK ' },
  { code: 'UNI', label: 'Uniswap', group: 'Crypto', symbol: 'UNI ' },
  { code: 'ZEC', label: 'Zcash', group: 'Crypto', symbol: 'ZEC ' },
];

const SYMBOL: Record<string, string> = Object.fromEntries(
  AVAILABLE_CURRENCIES.map((c) => [c.code, c.symbol]),
);

/** Crypto is worth more per unit, so two decimals would round most of it away. */
const IS_CRYPTO = new Set(
  AVAILABLE_CURRENCIES.filter((c) => c.group === 'Crypto').map((c) => c.code),
);

/**
 * A USD amount in one currency at one rate.
 *
 * A null rate means we could not convert, and showing an unconverted number
 * under a foreign symbol would be a lie — so it falls back to dollars.
 */
export function formatCurrency(usd: number, code: string, rate: number | null): string {
  const converted = code === 'USD' || rate === null ? usd : usd * rate;
  const symbol = code === 'USD' || rate === null ? '$' : (SYMBOL[code] ?? `${code} `);

  if (code !== 'USD' && rate !== null && IS_CRYPTO.has(code)) {
    if (converted < 0.0001) return `${symbol}${converted.toExponential(2)}`;
    if (converted < 1) return `${symbol}${converted.toPrecision(4)}`;
    return `${symbol}${converted.toFixed(4)}`;
  }

  // Below a cent, two decimals would show every small amount as 0.00.
  if (converted >= 0.01) return `${symbol}${converted.toFixed(2)}`;
  if (converted > 0) return `${symbol}${converted.toFixed(4)}`;
  return `${symbol}0.00`;
}

export interface CurrencyFormatter {
  /** Format a USD amount in the user's primary currency. */
  format: (usd: number) => string;
  /** Format in every selected currency, joined by a separator. */
  formatAll: (usd: number, sep?: string) => string;
  /** The primary currency code, e.g. "EUR" or "BTC". */
  code: string;
  /** Every selected code, primary first. */
  codes: string[];
  /** The primary conversion rate from USD. */
  rate: number;
  loading: boolean;
}

export function useCurrency(): CurrencyFormatter {
  const { data: settings } = useSWR('/api/settings', fetcher, { revalidateOnFocus: false });
  const codes: string[] = String(settings?.display_currency || 'USD')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const code = codes[0] || 'USD';

  // Rates cost a network call, so only ask when something needs converting.
  const needsRates = codes.some((c) => c !== 'USD');
  const { data: rates, isLoading } = useSWR(
    needsRates ? '/api/mesh/rates' : null,
    fetcher,
    { revalidateOnFocus: false, refreshInterval: 3600_000 },
  );

  const rateFor = (c: string): number | null =>
    c === 'USD' ? 1 : (rates?.fiat?.[c] ?? rates?.crypto?.[c] ?? null);

  return {
    format: (usd) => formatCurrency(usd, code, rateFor(code)),
    formatAll: (usd, sep = ' · ') =>
      codes.map((c) => formatCurrency(usd, c, rateFor(c))).join(sep),
    code,
    codes,
    rate: rateFor(code) ?? 1,
    loading: isLoading,
  };
}
