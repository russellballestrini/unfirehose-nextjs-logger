import { describe, it, expect } from 'vitest';
import { sanitizePII } from './pii';

describe('sanitizePII', () => {
  it('returns unchanged text when no PII present', () => {
    const text = 'This is a normal message about code.';
    const { sanitized, replacements } = sanitizePII(text);
    expect(sanitized).toBe(text);
    expect(replacements).toHaveLength(0);
  });

  it('returns empty results for empty/null input', () => {
    expect(sanitizePII('').sanitized).toBe('');
    expect(sanitizePII('').replacements).toHaveLength(0);
  });

  describe('credit cards', () => {
    it('replaces card number with spaces', () => {
      const { sanitized, replacements } = sanitizePII(
        'My card is 4111 1111 1111 1111 please charge it'
      );
      expect(sanitized).toContain('__CREDIT_CARD_1__');
      expect(sanitized).not.toContain('4111');
      expect(replacements).toHaveLength(1);
      expect(replacements[0].piiType).toBe('credit_card');
    });

    it('replaces card number with dashes', () => {
      const { sanitized } = sanitizePII('Card: 5500-0000-0000-0004');
      expect(sanitized).toContain('__CREDIT_CARD_1__');
    });

    it('replaces card number without separators', () => {
      const { sanitized } = sanitizePII('Card: 4111111111111111');
      expect(sanitized).toContain('__CREDIT_CARD_1__');
    });

    it('replaces multiple cards with incrementing counters', () => {
      const { sanitized, replacements } = sanitizePII(
        'Cards: 4111111111111111 and 5500000000000004'
      );
      expect(sanitized).toContain('__CREDIT_CARD_1__');
      expect(sanitized).toContain('__CREDIT_CARD_2__');
      expect(replacements).toHaveLength(2);
    });
  });

  describe('SSN', () => {
    it('replaces SSN format', () => {
      const { sanitized, replacements } = sanitizePII('SSN: 123-45-6789');
      expect(sanitized).toBe('SSN: __SSN_1__');
      expect(replacements[0].piiType).toBe('ssn');
    });

    it('replaces multiple SSNs with incrementing counters', () => {
      const { sanitized } = sanitizePII(
        'SSNs: 123-45-6789 and 987-65-4321'
      );
      expect(sanitized).toContain('__SSN_1__');
      expect(sanitized).toContain('__SSN_2__');
    });

    it('does not match non-SSN patterns', () => {
      const { replacements } = sanitizePII('Version 1.2.3-45-6789abc');
      const ssnMatches = replacements.filter((r) => r.piiType === 'ssn');
      expect(ssnMatches).toHaveLength(0);
    });
  });

  describe('phone numbers', () => {
    it('replaces (NNN) NNN-NNNN format', () => {
      const { sanitized } = sanitizePII('Call (555) 867-5309');
      expect(sanitized).toContain('__PHONE_1__');
    });

    it('replaces NNN-NNN-NNNN format', () => {
      const { sanitized } = sanitizePII('Phone: 555-867-5309');
      expect(sanitized).toContain('__PHONE_1__');
    });

    it('replaces +1 prefixed numbers', () => {
      const { sanitized } = sanitizePII('Call +1-555-867-5309');
      expect(sanitized).toContain('__PHONE_1__');
    });

    it('replaces dot-separated format', () => {
      const { sanitized } = sanitizePII('Ph: 555.867.5309');
      expect(sanitized).toContain('__PHONE_1__');
    });

    it('replaces +1 with no separator', () => {
      const { sanitized } = sanitizePII('Call +15558675309');
      expect(sanitized).toContain('__PHONE_1__');
    });
  });

  describe('email', () => {
    it('replaces email addresses', () => {
      const { sanitized, replacements } = sanitizePII(
        'Email me at user@example.com for details'
      );
      expect(sanitized).toBe('Email me at __EMAIL_1__ for details');
      expect(replacements[0].piiType).toBe('email');
    });

    it('replaces multiple emails with incrementing counters', () => {
      const { sanitized } = sanitizePII(
        'CC: alice@test.org and bob@test.org'
      );
      expect(sanitized).toContain('__EMAIL_1__');
      expect(sanitized).toContain('__EMAIL_2__');
    });
  });

  describe('IPv4 addresses', () => {
    it('replaces public IPv4 addresses', () => {
      const { sanitized, replacements } = sanitizePII(
        'Server at 8.8.8.8 is reachable'
      );
      expect(sanitized).toBe('Server at __IP_1__ is reachable');
      expect(replacements).toHaveLength(1);
      expect(replacements[0].piiType).toBe('ip');
    });

    it('replaces multiple public IPs with incrementing counters', () => {
      const { sanitized } = sanitizePII(
        'DNS: 8.8.8.8 and 1.1.1.1'
      );
      expect(sanitized).toContain('__IP_1__');
      expect(sanitized).toContain('__IP_2__');
    });

    it('does NOT replace 127.0.0.1 (loopback)', () => {
      const { sanitized, replacements } = sanitizePII(
        'Listening on 127.0.0.1:3000'
      );
      expect(sanitized).toContain('127.0.0.1');
      const ipMatches = replacements.filter((r) => r.piiType === 'ip');
      expect(ipMatches).toHaveLength(0);
    });

    it('does NOT replace 0.0.0.0', () => {
      const { replacements } = sanitizePII('Bind to 0.0.0.0');
      const ipMatches = replacements.filter((r) => r.piiType === 'ip');
      expect(ipMatches).toHaveLength(0);
    });

    it('does NOT replace 192.168.x.x (private)', () => {
      const { replacements } = sanitizePII('Router at 192.168.1.1');
      const ipMatches = replacements.filter((r) => r.piiType === 'ip');
      expect(ipMatches).toHaveLength(0);
    });

    it('does NOT replace 10.x.x.x (private)', () => {
      const { replacements } = sanitizePII('VPN at 10.0.0.1');
      const ipMatches = replacements.filter((r) => r.piiType === 'ip');
      expect(ipMatches).toHaveLength(0);
    });

    it('does NOT replace 172.16-31.x.x (private)', () => {
      const { replacements } = sanitizePII('Docker at 172.17.0.2');
      const ipMatches = replacements.filter((r) => r.piiType === 'ip');
      expect(ipMatches).toHaveLength(0);
    });

    it('does NOT replace 169.254.x.x (link-local)', () => {
      const { replacements } = sanitizePII('Link-local 169.254.1.1');
      const ipMatches = replacements.filter((r) => r.piiType === 'ip');
      expect(ipMatches).toHaveLength(0);
    });
  });

  describe('mixed PII', () => {
    it('handles multiple PII types in one text', () => {
      const { sanitized, replacements } = sanitizePII(
        'Contact: 555-867-5309, email user@test.com, SSN 123-45-6789'
      );
      expect(sanitized).toContain('__PHONE_1__');
      expect(sanitized).toContain('__EMAIL_1__');
      expect(sanitized).toContain('__SSN_1__');
      expect(replacements).toHaveLength(3);
    });

    it('handles PII types including IP in mixed text', () => {
      const { sanitized, replacements } = sanitizePII(
        'User user@corp.com from 203.0.113.5 called 555-867-5309'
      );
      expect(sanitized).toContain('__EMAIL_1__');
      expect(sanitized).toContain('__IP_1__');
      expect(sanitized).toContain('__PHONE_1__');
      expect(replacements).toHaveLength(3);
    });

    it('counters are per-type', () => {
      const { replacements } = sanitizePII(
        'Phones: 555-867-5309 and 415-555-0199. Emails: a@b.com and c@d.com'
      );
      const phones = replacements.filter((r) => r.piiType === 'phone');
      const emails = replacements.filter((r) => r.piiType === 'email');
      expect(phones).toHaveLength(2);
      expect(emails).toHaveLength(2);
      expect(phones[0].token).toBe('__PHONE_1__');
      expect(phones[1].token).toBe('__PHONE_2__');
      expect(emails[0].token).toBe('__EMAIL_1__');
      expect(emails[1].token).toBe('__EMAIL_2__');
    });
  });

  describe('hashing', () => {
    it('generates consistent SHA-256 hashes for same input', () => {
      const r1 = sanitizePII('SSN: 123-45-6789');
      const r2 = sanitizePII('SSN: 123-45-6789');
      expect(r1.replacements[0].originalHash).toBe(
        r2.replacements[0].originalHash
      );
    });

    it('generates different hashes for different values', () => {
      const r1 = sanitizePII('SSN: 123-45-6789');
      const r2 = sanitizePII('SSN: 987-65-4321');
      expect(r1.replacements[0].originalHash).not.toBe(
        r2.replacements[0].originalHash
      );
    });

    it('hash is a 64-character hex string', () => {
      const { replacements } = sanitizePII('Email: test@example.com');
      expect(replacements[0].originalHash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('preserves non-PII content', () => {
    it('does not match git hashes', () => {
      const { replacements } = sanitizePII(
        'Commit abc123def456 on branch main'
      );
      expect(replacements).toHaveLength(0);
    });

    it('does not match timestamps', () => {
      const { replacements } = sanitizePII('2026-03-04T19:12:05.000Z');
      expect(replacements).toHaveLength(0);
    });

    it('does not match port numbers', () => {
      const { replacements } = sanitizePII('localhost:3000');
      expect(replacements).toHaveLength(0);
    });

    it('does not match short numeric constants', () => {
      // 12 digits or fewer should not match credit card pattern (needs 13+)
      const { replacements } = sanitizePII(
        'const MAX_RETRIES = 123456789012;'
      );
      const ccMatches = replacements.filter(
        (r) => r.piiType === 'credit_card'
      );
      expect(ccMatches).toHaveLength(0);
    });
  });
});
