import { createHash } from 'crypto';

export interface PIIReplacement {
  token: string;      // e.g. __EMAIL_1__
  piiType: string;    // email, credit_card, ssn, phone, ip
  originalHash: string; // SHA-256 hex of original value (never raw PII)
}

interface PIIPattern {
  piiType: string;
  regex: RegExp;
  validate?: (match: string) => boolean;
}

// Private IPv4 ranges to exclude from IP detection
function isPrivateIP(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => p < 0 || p > 255)) return false;

  // 127.x.x.x (loopback)
  if (parts[0] === 127) return true;
  // 0.0.0.0
  if (parts.every((p) => p === 0)) return true;
  // 10.x.x.x
  if (parts[0] === 10) return true;
  // 192.168.x.x
  if (parts[0] === 192 && parts[1] === 168) return true;
  // 172.16.0.0 – 172.31.255.255
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  // 169.254.x.x (link-local)
  if (parts[0] === 169 && parts[1] === 254) return true;
  // 255.255.255.255 (broadcast)
  if (parts.every((p) => p === 255)) return true;

  return false;
}

// Patterns ordered by specificity (more specific first to avoid partial matches)
const PII_PATTERNS: PIIPattern[] = [
  // Credit card: 13-19 digit sequences with optional separators (spaces, dashes)
  {
    piiType: 'credit_card',
    regex: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{1,7}\b/g,
  },
  // SSN: exactly NNN-NN-NNNN
  {
    piiType: 'ssn',
    regex: /\b\d{3}-\d{2}-\d{4}\b/g,
  },
  // Phone: US formats — (NNN) NNN-NNNN, NNN-NNN-NNNN, NNN.NNN.NNNN, +1NNNNNNNNNN, etc.
  {
    piiType: 'phone',
    regex: /\b(?:\+?1[-.\s]?)?\(?[2-9]\d{2}\)?[-.\s]?[2-9]\d{2}[-.\s]?\d{4}\b/g,
  },
  // Email
  {
    piiType: 'email',
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  // IPv4 addresses (public only — private ranges excluded via validate)
  {
    piiType: 'ip',
    regex: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
    validate: (match: string) => !isPrivateIP(match),
  },
];

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Sanitize PII from text using __TYPE_N__ placeholder tokens.
 * Counter N is 1-based, per-type within each text block.
 * Returns sanitized text and replacement metadata (with hashed originals, never raw PII).
 */
export function sanitizePII(text: string): {
  sanitized: string;
  replacements: PIIReplacement[];
} {
  if (!text) return { sanitized: text, replacements: [] };

  const replacements: PIIReplacement[] = [];
  const counters: Record<string, number> = {};

  // Track already-replaced ranges to avoid double-matching
  const replaced: Array<{ start: number; end: number; token: string }> = [];

  for (const pattern of PII_PATTERNS) {
    const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
      const start = match.index;
      const end = start + match[0].length;

      // Skip if this range overlaps with an already-replaced range
      if (replaced.some((r) => start < r.end && end > r.start)) continue;

      // Skip if validate function exists and rejects the match
      if (pattern.validate && !pattern.validate(match[0])) continue;

      const count = (counters[pattern.piiType] ?? 0) + 1;
      counters[pattern.piiType] = count;
      const token = `__${pattern.piiType.toUpperCase()}_${count}__`;

      replacements.push({
        token,
        piiType: pattern.piiType,
        originalHash: sha256(match[0]),
      });

      replaced.push({ start, end, token });
    }
  }

  // Apply replacements from end to start so indices stay valid
  replaced.sort((a, b) => b.start - a.start);
  let sanitized = text;
  for (const r of replaced) {
    sanitized = sanitized.slice(0, r.start) + r.token + sanitized.slice(r.end);
  }

  return { sanitized, replacements };
}
