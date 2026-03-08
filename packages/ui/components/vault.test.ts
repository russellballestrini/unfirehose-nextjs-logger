// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { Vault, type VaultData } from './vault';

beforeEach(() => {
  localStorage.clear();
});

describe('Vault', () => {
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
