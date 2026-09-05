// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { Vault, PBKDF2_ITERATIONS, type VaultData } from './vault';

beforeEach(() => {
  localStorage.clear();
});

describe('Vault', () => {
  it('derives at the iteration count OWASP asks for', () => {
    // The rest of this suite runs at a lower count so it can finish, set
    // through UNFIREHOSE_TEST_KDF_ROUNDS in vitest.config.ts. This is the
    // assertion that keeps the shipped figure honest — without it, lowering
    // the cost for the tests would quietly lower it for everyone.
    expect(PBKDF2_ITERATIONS).toBe(600_000);
  });

  describe('hasVault', () => {
    it('returns false when no vault exists', () => {
      expect(Vault.hasVault()).toBe(false);
    });

    it('returns true after vault creation', async () => {
      await Vault.create('testpass123');
      expect(Vault.hasVault()).toBe(true);
    });
  });

  describe('create', () => {
    it('creates vault with default data', async () => {
      const data = await Vault.create('password123');
      expect(data).toEqual({ keys: {}, models: {}, endpoints: {} });
    });

    it('persists encrypted data to localStorage', async () => {
      await Vault.create('password123');
      const raw = localStorage.getItem('unfirehose_vault');
      expect(raw).toBeTruthy();
      const parsed = JSON.parse(raw!);
      expect(parsed.encrypted).toBeTruthy();
      expect(parsed.created).toBeGreaterThan(0);
    });

    it('creates salt in localStorage', async () => {
      await Vault.create('password123');
      expect(localStorage.getItem('unfirehose_vault_salt')).toBeTruthy();
    });

    it('creates a session for auto-unlock', async () => {
      await Vault.create('password123');
      expect(localStorage.getItem('unfirehose_vault_session')).toBeTruthy();
    });
  });

  describe('unlock', () => {
    it('decrypts vault with correct password', async () => {
      await Vault.create('correct-password');
      const data = await Vault.unlock('correct-password');
      expect(data).toEqual({ keys: {}, models: {}, endpoints: {} });
    });

    it('returns null with wrong password', async () => {
      await Vault.create('correct-password');
      const data = await Vault.unlock('wrong-password');
      expect(data).toBeNull();
    });

    it('returns null when no vault exists', async () => {
      const data = await Vault.unlock('anything');
      expect(data).toBeNull();
    });
  });

  describe('save', () => {
    it('persists updated vault data', async () => {
      const pw = 'save-test-pw';
      await Vault.create(pw);

      const updated: VaultData = {
        keys: { anthropic: 'sk-ant-123' },
        preferred: 'anthropic',
        models: { anthropic: 'claude-opus-4-6' },
        endpoints: {},
      };
      await Vault.save(updated, pw);

      const restored = await Vault.unlock(pw);
      expect(restored).toEqual(updated);
    });

    it('preserves created timestamp on save', async () => {
      const pw = 'ts-test';
      await Vault.create(pw);
      const raw1 = JSON.parse(localStorage.getItem('unfirehose_vault')!);
      const created = raw1.created;

      await Vault.save({ keys: { x: 'y' } }, pw);
      const raw2 = JSON.parse(localStorage.getItem('unfirehose_vault')!);
      expect(raw2.created).toBe(created);
      expect(raw2.updated).toBeGreaterThanOrEqual(created);
    });
  });

  describe('session management', () => {
    it('tryRestoreSession returns null when no session', async () => {
      const result = await Vault.tryRestoreSession();
      expect(result).toBeNull();
    });

    it('tryRestoreSession restores after create', async () => {
      const pw = 'session-test';
      await Vault.create(pw);
      const restored = await Vault.tryRestoreSession();
      expect(restored).not.toBeNull();
      expect(restored!.password).toBe(pw);
      expect(restored!.data).toEqual({ keys: {}, models: {}, endpoints: {} });
    });

    it('lock clears session but keeps vault', async () => {
      await Vault.create('lock-test');
      expect(Vault.hasVault()).toBe(true);
      Vault.lock();
      expect(localStorage.getItem('unfirehose_vault_session')).toBeNull();
      expect(Vault.hasVault()).toBe(true);
    });
  });

  describe('destroy', () => {
    it('removes all vault data', async () => {
      await Vault.create('destroy-test');
      expect(Vault.hasVault()).toBe(true);
      Vault.destroy();
      expect(Vault.hasVault()).toBe(false);
      expect(localStorage.getItem('unfirehose_vault_salt')).toBeNull();
      expect(localStorage.getItem('unfirehose_vault_session')).toBeNull();
    });
  });

  describe('encryption round-trip', () => {
    it('handles multiple keys and complex data', async () => {
      const pw = 'complex-test';
      await Vault.create(pw);
      const complex: VaultData = {
        keys: {
          anthropic: 'sk-ant-long-key-with-special-chars!@#$%',
          openai: 'sk-proj-another-key',
          groq: 'gsk_test123',
        },
        preferred: 'anthropic',
        models: {
          anthropic: 'claude-opus-4-6',
          openai: 'gpt-4o-mini',
        },
        endpoints: {
          custom: 'http://localhost:11434/v1/chat/completions',
        },
      };
      await Vault.save(complex, pw);
      const restored = await Vault.unlock(pw);
      expect(restored).toEqual(complex);
    });

    it('uses unique IV per encryption (different ciphertext each time)', async () => {
      const pw = 'iv-test';
      await Vault.create(pw);
      const raw1 = JSON.parse(localStorage.getItem('unfirehose_vault')!).encrypted;

      // Re-save same data
      await Vault.save({ keys: {}, models: {}, endpoints: {} }, pw);
      const raw2 = JSON.parse(localStorage.getItem('unfirehose_vault')!).encrypted;

      // Different IV means different ciphertext even for identical plaintext
      expect(raw1).not.toBe(raw2);
    });
  });
});

describe('session cost', () => {
  /**
   * A session protects the vault password with a freshly generated 256-bit
   * random value. Running PBKDF2 over that was 600,000 iterations of
   * nothing — a KDF exists to make brute-forcing a low-entropy human
   * password expensive, and there is no brute-forcing 256 bits. It cost
   * 725ms in a browser on every page load and bought no security at all.
   */
  const SESSION = 'unfirehose_vault_session';
  const session = () => JSON.parse(localStorage.getItem(SESSION) ?? 'null');

  it('stores a session without running the password KDF over a random key', async () => {
    await Vault.create('correct horse battery');
    expect(session().v).toBe(2);
    // No salt, because a KDF salt is meaningless when there is no KDF.
    expect(session().salt).toBeUndefined();
  });

  it('keeps the session key at 256 bits, which is what makes the KDF pointless', async () => {
    // If this ever shrinks, the reasoning above stops holding and the raw
    // key becomes something worth attacking.
    await Vault.create('correct horse battery');
    expect(Buffer.from(session().sessionKey, 'base64')).toHaveLength(32);
  });

  it('still restores the password it stored', async () => {
    await Vault.create('correct horse battery');
    const restored = await Vault.tryRestoreSession();
    expect(restored?.password).toBe('correct horse battery');
  });

  it('does not leave the password readable beside its key', async () => {
    // The session key sits in localStorage next to the ciphertext, which is
    // the trade a "remember me" always makes. What must not happen is the
    // password sitting there in the clear.
    await Vault.create('correct horse battery');
    expect(localStorage.getItem(SESSION)).not.toContain('correct horse battery');
  });

  it('refuses a session whose key has been swapped, and clears it', async () => {
    await Vault.create('correct horse battery');
    const raw = session();
    raw.sessionKey = Buffer.from(new Uint8Array(32).fill(7)).toString('base64');
    localStorage.setItem(SESSION, JSON.stringify(raw));
    expect(await Vault.tryRestoreSession()).toBeNull();
    // Cleared rather than retried on every page load.
    expect(localStorage.getItem(SESSION)).toBeNull();
  });

  it('refuses a session whose ciphertext has been tampered with', async () => {
    await Vault.create('correct horse battery');
    const raw = session();
    const [iv] = raw.data.split('.');
    raw.data = `${iv}.${Buffer.from(new Uint8Array(48).fill(9)).toString('base64')}`;
    localStorage.setItem(SESSION, JSON.stringify(raw));
    expect(await Vault.tryRestoreSession()).toBeNull();
  });

  it('still opens a session written by the previous version, and upgrades it', async () => {
    // Anybody upgrading has a v1 session in localStorage already, and it
    // must not lock them out. Built here with the same algorithm the old
    // code used, at the iteration count this suite runs at.
    const password = 'correct horse battery';
    await Vault.create(password);

    const enc = new TextEncoder();
    const sessionKey = Buffer.from(new Uint8Array(32).fill(3)).toString('base64');
    const salt = new Uint8Array(16).fill(5);
    const km = await crypto.subtle.importKey('raw', enc.encode(sessionKey), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: Number(process.env.UNFIREHOSE_TEST_KDF_ROUNDS), hash: 'SHA-256' },
      km, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(password));
    const b64 = (b: ArrayBuffer | Uint8Array) => Buffer.from(b as ArrayBuffer).toString('base64');
    localStorage.setItem(SESSION, JSON.stringify({
      sessionKey, salt: b64(salt), data: `${b64(iv)}.${b64(ct)}`, created: Date.now(),
    }));

    const restored = await Vault.tryRestoreSession();
    expect(restored?.password).toBe(password);
    // Rewritten in the new format, so the old cost is paid once, not daily.
    expect(session().v).toBe(2);
  });
});
