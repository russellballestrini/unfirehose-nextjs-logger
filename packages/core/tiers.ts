export const TIERS = {
  free: 0,
  solo: 14,
  team: 33,
} as const;

export type TierName = keyof typeof TIERS;
export type TierLevel = typeof TIERS[TierName];

const STRING_MAP: Record<string, TierLevel> = {
  free: 0,
  pro: 14,   // unsandbox.com calls solo "pro"
  solo: 14,
  team: 33,
};

const LEVEL_MAP: Record<number, TierName> = {
  0: 'free',
  14: 'solo',
  33: 'team',
};

export function tierFromString(s: string): TierLevel {
  const level = STRING_MAP[s.toLowerCase()];
  if (level === undefined) return 0;
  return level;
}

export function tierName(level: TierLevel): TierName {
  return LEVEL_MAP[level] ?? 'free';
}

interface TierLimits {
  maxKeys: number;
  ingestRatePerMin: number;
  dataWindowDays: number;
  canBackfill: boolean;
}

export function tierLimits(level: TierLevel): TierLimits {
  switch (level) {
    case 33:
      return { maxKeys: Infinity, ingestRatePerMin: Infinity, dataWindowDays: Infinity, canBackfill: true };
    case 14:
      return { maxKeys: 5, ingestRatePerMin: 10000, dataWindowDays: Infinity, canBackfill: true };
    default:
      return { maxKeys: 1, ingestRatePerMin: 100, dataWindowDays: 7, canBackfill: false };
  }
}
