/**
 * Client-side encrypted vault for BYOK API keys.
 * Uses Web Crypto API (AES-GCM 256-bit) — no external dependencies.
 * Keys never leave the browser unencrypted.
 */

const VAULT_KEY = 'unfirehose_vault';
const SALT_KEY = 'unfirehose_vault_salt';
const SESSION_KEY = 'unfirehose_vault_session';

// --- Low-level crypto helpers using Web Crypto API ---

function getRandomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

function bufToBase64(buf: ArrayBuffer | Uint8Array): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function base64ToBuf(b64: string): Uint8Array {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf;
}

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 600_000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function encrypt(data: string, password: string, salt: Uint8Array): Promise<string> {
  const key = await deriveKey(password, salt);
  const iv = getRandomBytes(12);
  const enc = new TextEncoder();
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(data));
  // Store as: iv(12 bytes base64) + '.' + ciphertext(base64)
  return bufToBase64(iv) + '.' + bufToBase64(ct);
}

async function decrypt(blob: string, password: string, salt: Uint8Array): Promise<string | null> {
  try {
    const [ivB64, ctB64] = blob.split('.');
    if (!ivB64 || !ctB64) return null;
    const key = await deriveKey(password, salt);
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBuf(ivB64) },
      key,
      base64ToBuf(ctB64),
    );
    return new TextDecoder().decode(pt);
  } catch {
    return null; // wrong password or corrupted
  }
}

// --- Vault data structure ---

export interface VaultData {
  keys: Record<string, string>; // provider_id → api_key
  preferred?: string;           // preferred provider id
  models?: Record<string, string>; // provider_id → model override
  endpoints?: Record<string, string>; // provider_id → endpoint override
}

function defaultVault(): VaultData {
  return { keys: {}, models: {}, endpoints: {} };
}

// --- Salt management ---

function getOrCreateSalt(): Uint8Array {
  const stored = localStorage.getItem(SALT_KEY);
  if (stored) return base64ToBuf(stored);
  const salt = getRandomBytes(32);
  localStorage.setItem(SALT_KEY, bufToBase64(salt));
  return salt;
}

// --- Public API ---

export const Vault = {
  /** Check if a vault exists in localStorage */
  hasVault(): boolean {
    return !!localStorage.getItem(VAULT_KEY);
  },

  /** Create a new vault with a password. Returns the default vault data. */
  async create(password: string): Promise<VaultData> {
    const salt = getOrCreateSalt();
    const data = defaultVault();
    const blob = await encrypt(JSON.stringify(data), password, salt);
    localStorage.setItem(VAULT_KEY, JSON.stringify({ encrypted: blob, created: Date.now(), updated: Date.now() }));
    await this.createSession(password);
    return data;
  },

  /** Unlock an existing vault. Returns null if wrong password. */
  async unlock(password: string): Promise<VaultData | null> {
    const raw = localStorage.getItem(VAULT_KEY);
    if (!raw) return null;
    const vault = JSON.parse(raw);
    const salt = getOrCreateSalt();
    const json = await decrypt(vault.encrypted, password, salt);
    if (!json) return null;
    await this.createSession(password);
    return JSON.parse(json) as VaultData;
  },

  /** Save updated vault data (must already be unlocked — pass the password). */
  async save(data: VaultData, password: string): Promise<void> {
    const salt = getOrCreateSalt();
    const blob = await encrypt(JSON.stringify(data), password, salt);
    const raw = localStorage.getItem(VAULT_KEY);
    const existing = raw ? JSON.parse(raw) : {};
    localStorage.setItem(VAULT_KEY, JSON.stringify({ ...existing, encrypted: blob, updated: Date.now() }));
  },

  /** Try to restore session (auto-unlock without password). Returns vault data + password. */
  async tryRestoreSession(): Promise<{ data: VaultData; password: string } | null> {
    const sessionRaw = localStorage.getItem(SESSION_KEY);
    if (!sessionRaw) return null;
    try {
      const session = JSON.parse(sessionRaw);
      // Session key is stored as random bytes, password encrypted with it
      const sessionSalt = base64ToBuf(session.salt);
      const password = await decrypt(session.data, session.sessionKey, sessionSalt);
      if (!password) { this.clearSession(); return null; }
      const data = await this.unlock(password);
      if (!data) { this.clearSession(); return null; }
      return { data, password };
    } catch {
      this.clearSession();
      return null;
    }
  },

  /** Create a session for auto-unlock persistence. */
  async createSession(password: string): Promise<void> {
    const sessionKey = bufToBase64(getRandomBytes(32));
    const sessionSalt = getRandomBytes(16);
    const encPassword = await encrypt(password, sessionKey, sessionSalt);
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      sessionKey,
      salt: bufToBase64(sessionSalt),
      data: encPassword,
      created: Date.now(),
    }));
  },

  /** Lock the vault — clears session but keeps encrypted data. */
  lock(): void {
    this.clearSession();
  },

  /** Clear session data. */
  clearSession(): void {
    localStorage.removeItem(SESSION_KEY);
  },

  /** Delete vault entirely. */
  destroy(): void {
    localStorage.removeItem(VAULT_KEY);
    localStorage.removeItem(SALT_KEY);
    localStorage.removeItem(SESSION_KEY);
  },
};
