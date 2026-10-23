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

// Two credential detectors live here on purpose, tuned for opposite costs.
// redactForExport (below the ledger's) is for a file that leaves this
// machine, where a missed key is a leak, so it errs toward redacting.
// findSecrets is for the action ledger's flags, where a false alarm teaches
// people to ignore the flag, so it errs toward precision. Their vendor key
// shapes overlap; keep the two lists in step when a vendor changes one.

// ── Secrets ──────────────────────────────────────────────────────────────────
//
// Credentials, as distinct from personal data. sanitizePII above runs on
// every text block at ingest and these do not join it: redacting a key out
// of a transcript is a decision about what we store, and it belongs to its
// own change. These answer a narrower question for the action ledger — did
// a tool call write a credential into a file, or carry one on a command
// line — and redact them out of what the ledger itself keeps.
//
// Precision over recall. Each pattern is a vendor's published token shape,
// or a credential-named assignment whose value looks random; a placeholder
// like `sk-ant-...` or `API_KEY=your-key-here` never matches.

export interface SecretMatch {
  /** private_key, aws_access_key, github_token, anthropic_key, … */
  kind: string;
  start: number;
  end: number;
}

interface SecretPattern {
  kind: string;
  regex: RegExp;
  /** Which capture group is the secret itself; 0 = the whole match. */
  group?: number;
  validate?: (value: string) => boolean;
}

const PLACEHOLDER = /(?:your|example|placeholder|changeme|dummy|redacted|xxxx|\*\*\*|\.\.\.|<|>|\$\{?|process\.env|os\.environ)/i;

/** A value that reads as random: letters and digits both, not one repeated run. */
function looksRandom(v: string): boolean {
  if (PLACEHOLDER.test(v)) return false;
  if (!/[A-Za-z]/.test(v) || !/\d/.test(v)) return false;
  return new Set(v).size >= 8;
}

// Ordered most specific first; a later pattern never claims a span an
// earlier one already matched (sk-ant- before the generic sk-).
const SECRET_PATTERNS: SecretPattern[] = [
  { kind: 'private_key', regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g },
  { kind: 'aws_access_key', regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'github_token', regex: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g },
  { kind: 'gitlab_token', regex: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'anthropic_key', regex: /\bsk-ant-[A-Za-z0-9_-]{24,}/g, validate: looksRandom },
  { kind: 'openai_key', regex: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/g, validate: looksRandom },
  { kind: 'unsandbox_key', regex: /\bunsb-sk-[A-Za-z0-9_-]{16,}/g, validate: looksRandom },
  { kind: 'slack_token', regex: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, validate: looksRandom },
  { kind: 'stripe_key', regex: /\b[sr]k_live_[A-Za-z0-9]{20,}\b/g },
  { kind: 'google_api_key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'npm_token', regex: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { kind: 'bearer_token', regex: /\bBearer\s+([A-Za-z0-9._~+/-]{24,}=*)/g, group: 1, validate: looksRandom },
  {
    kind: 'assigned_secret',
    regex: /\b[A-Za-z0-9_]*(?:PASSWORD|PASSWD|SECRET|API_?KEY|ACCESS_?TOKEN|AUTH_?TOKEN|PRIVATE_?KEY)[A-Za-z0-9_]*["']?\s*[:=]\s*["']?([A-Za-z0-9+/_.=-]{16,})/gi,
    group: 1,
    validate: looksRandom,
  },
];

/** Every credential in `text`, by kind and span. Spans never overlap. */
export function findSecrets(text: string): SecretMatch[] {
  if (!text) return [];
  const found: SecretMatch[] = [];
  for (const p of SECRET_PATTERNS) {
    const regex = new RegExp(p.regex.source, p.regex.flags);
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
      const value = p.group ? m[p.group] : m[0];
      if (!value) continue;
      const start = p.group ? m.index + m[0].lastIndexOf(value) : m.index;
      const end = start + value.length;
      if (found.some((f) => start < f.end && end > f.start)) continue;
      if (p.validate && !p.validate(value)) continue;
      found.push({ kind: p.kind, start, end });
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

/** `text` with each credential replaced by `__SECRET_<KIND>__`. */
export function redactSecrets(text: string): string {
  const hits = findSecrets(text);
  let out = text;
  for (const h of [...hits].reverse()) {
    out = out.slice(0, h.start) + `__SECRET_${h.kind.toUpperCase()}__` + out.slice(h.end);
  }
  return out;
}

// ── Export redaction: secrets, home paths, then PII ──────────────────────────
//
// sanitizePII is what ingest applies before a row is stored, and it covers
// people (emails, phones, cards, SSNs, public IPs). A file that leaves this
// machine, such as a training set, also has to lose credentials and the
// username in every home path, which ingest keeps on purpose (a session page
// that cannot show `/home/fox/git/x` cannot link to it). So an export runs
// redactForExport: secrets first, while their shape is intact, then home
// paths, then sanitizePII. Each is replaced by a `__TYPE_N__` token, never
// dropped, so a sentence keeps its shape and a reader can see something was
// there.

/**
 * Only the secret goes and its surroundings stay: every regex here has three
 * groups, (before)(secret)(after), and the first and last are written back.
 */
interface ExportSecretPattern {
  piiType: string;
  regex: RegExp;
}

/** A token this module wrote. A redaction never redacts one again. */
const TOKEN_RE = /^__[A-Z_]+_\d+__/;

/** Start of text, or a character a key cannot contain: where a key may begin. */
const KEY_START = '(^|[^A-Za-z0-9_-])';

const KEY_PREFIXES = [
  'sk-ant-[A-Za-z0-9_-]{20,}',                       // Anthropic
  'sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}', // OpenAI and look-alikes
  'gh[pousr]_[A-Za-z0-9]{30,}',                      // GitHub
  'github_pat_[A-Za-z0-9_]{30,}',                    // GitHub fine-grained
  'glpat-[A-Za-z0-9_-]{20,}',                        // GitLab
  'xox[abposr]-[A-Za-z0-9-]{10,}',                   // Slack
  '(?:AKIA|ASIA)[0-9A-Z]{16}',                       // AWS access key id
  'AIza[0-9A-Za-z_-]{35}',                           // Google
  'npm_[A-Za-z0-9]{36}',                             // npm
  'hf_[A-Za-z0-9]{30,}',                             // Hugging Face
  'unsb-(?:sk|pk)-[A-Za-z0-9-]{8,}',                 // unsandbox
  '(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}',     // Stripe
  'SG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}',    // SendGrid
];

const EXPORT_SECRET_PATTERNS: ExportSecretPattern[] = [
  {
    // A truncated block (no END line) still goes, to the end of the text.
    piiType: 'private_key',
    regex: /()(-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$))()/g,
  },
  {
    piiType: 'jwt',
    regex: new RegExp(`${KEY_START}(eyJ[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,})()`, 'g'),
  },
  {
    piiType: 'api_key',
    regex: new RegExp(`${KEY_START}(${KEY_PREFIXES.join('|')})()`, 'g'),
  },
  {
    piiType: 'bearer_token',
    regex: /(\b(?:Bearer|Basic|Token)\s+)([A-Za-z0-9._~+/=-]{16,})()/gi,
  },
  {
    // scheme://user:password@host: the password goes, user and host stay.
    piiType: 'url_credentials',
    regex: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)([^\s@/]+)(@)/gi,
  },
  {
    // api_key=…, "password": "…", GITHUB_TOKEN=…, client_secret: …
    piiType: 'secret_assignment',
    regex: /((?:api[_-]?key|secret[_-]?key|client[_-]?secret|secret|access[_-]?token|auth[_-]?token|refresh[_-]?token|token|password|passwd)["']?\s*[:=]\s*["']?)([^\s"'`,;)}\]]{8,})()/gi,
  },
  {
    // /home/<user>/, /Users/<user>/, C:\Users\<user>\: the username goes,
    // the path keeps its shape.
    piiType: 'home_path',
    regex: /((?:^|[^A-Za-z0-9_.~-])(?:\/home\/|\/Users\/|[A-Za-z]:\\{1,2}Users\\{1,2}))([^/\\\s"'`:;,)}\]]+)()/g,
  },
  {
    // An encoded project dir, as Claude Code names them: -home-<user>-git-x
    piiType: 'home_path',
    regex: /((?:^|[\s/"'=`(])-(?:home|Users)-)([A-Za-z0-9_.]+)(-)/g,
  },
];

export interface ExportRedaction {
  text: string;
  /** Redactions made in this text, by type (api_key, email, home_path, …). */
  counts: Record<string, number>;
}

/**
 * Redact a string for a file that leaves this machine: credentials, the
 * username in home paths, then everything sanitizePII catches. Tokens are
 * numbered per type within one call, as sanitizePII numbers them.
 */
export function redactForExport(text: string): ExportRedaction {
  const counts: Record<string, number> = {};
  if (!text) return { text, counts };
  // One value keeps one token within a text: /home/fox/a and /home/fox/b
  // both read __HOME_PATH_1__, so a reader can still tell they are one user.
  const seen = new Map<string, string>();
  const next: Record<string, number> = {};
  let out = text;
  for (const pattern of EXPORT_SECRET_PATTERNS) {
    const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
    out = out.replace(regex, (whole: string, before: string, secret: string, after: string) => {
      if (TOKEN_RE.test(secret)) return whole;
      counts[pattern.piiType] = (counts[pattern.piiType] ?? 0) + 1;
      const key = `${pattern.piiType}\u0000${secret}`;
      let token = seen.get(key);
      if (!token) {
        next[pattern.piiType] = (next[pattern.piiType] ?? 0) + 1;
        token = `__${pattern.piiType.toUpperCase()}_${next[pattern.piiType]}__`;
        seen.set(key, token);
      }
      return `${before}${token}${after}`;
    });
  }
  // Our tokens are word characters, so `https://admin:__URL_CREDENTIALS_1__@db.example.com`
  // would read as an email to sanitizePII. Each token sits behind a
  // private-use placeholder while it runs, then comes back.
  const held: string[] = [];
  out = out.replace(/__[A-Z_]+_\d+__/g, (t) => `${held.push(t) - 1}`);
  const { sanitized, replacements } = sanitizePII(out);
  for (const r of replacements) counts[r.piiType] = (counts[r.piiType] ?? 0) + 1;
  return { text: sanitized.replace(/(\d+)/g, (m: string, i: string) => held[Number(i)] ?? m), counts };
}
