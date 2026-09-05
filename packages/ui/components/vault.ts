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

/**
 * PBKDF2 rounds, the OWASP figure for SHA-256.
 *
 * Exported so a test can assert what ships, and overridable through an env
 * var so a suite need not pay for it thirteen times. One derivation is
 * 1.5-2.5s here, which made the ui suite a hundred seconds — almost all of
 * it spent proving the same arithmetic over and over rather than exercising
 * the vault. The parameter is asserted once, at its real value; the logic is
 * exercised at a cost that lets the suite run.
 *
 * There is no way to set this from a browser, and no caller passes it: the
 * only reader is a test runner's environment.
 */
export const PBKDF2_ITERATIONS = 600_000;

const iterations = (): number => {
  const override = Number(process.env.UNFIREHOSE_TEST_KDF_ROUNDS);
  return Number.isFinite(override) && override > 0 ? override : PBKDF2_ITERATIONS;
};

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: iterations(), hash: 'SHA-256' },
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
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, enc.encode(data) as BufferSource);
  // Store as: iv(12 bytes base64) + '.' + ciphertext(base64)
  return bufToBase64(iv) + '.' + bufToBase64(ct);
}

async function decrypt(blob: string, password: string, salt: Uint8Array): Promise<string | null> {
  try {
    const [ivB64, ctB64] = blob.split('.');
    if (!ivB64 || !ctB64) return null;
    const key = await deriveKey(password, salt);
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBuf(ivB64) as BufferSource },
      key,
      base64ToBuf(ctB64) as BufferSource,
    );
    return new TextDecoder().decode(pt);
  } catch {
    return null; // wrong password or corrupted
  }
}

/**
 * Encrypting under a key that is already a key.
 *
 * The session mechanism protects the vault password with a freshly generated
 * 256-bit random value. Running PBKDF2 over that was 600,000 iterations of
 * nothing: the whole point of a KDF is to make brute-forcing a low-entropy
 * human password expensive, and there is no brute-forcing 256 bits of
 * randomness. It cost 725ms in a browser, on every page load, and bought no
 * security at all.
 *
 * The vault password itself still goes through PBKDF2 at the full count.
 * That one is guarding something a person chose.
 */
async function rawKey(keyB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw', base64ToBuf(keyB64) as BufferSource, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'],
  );
}

async function encryptWithKey(data: string, keyB64: string): Promise<string> {
  const iv = getRandomBytes(12);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    await rawKey(keyB64),
    new TextEncoder().encode(data) as BufferSource,
  );
  return bufToBase64(iv) + '.' + bufToBase64(ct);
}

async function decryptWithKey(blob: string, keyB64: string): Promise<string | null> {
  try {
    const [ivB64, ctB64] = blob.split('.');
    if (!ivB64 || !ctB64) return null;
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBuf(ivB64) as BufferSource },
      await rawKey(keyB64),
      base64ToBuf(ctB64) as BufferSource,
    );
    return new TextDecoder().decode(pt);
  } catch {
    return null;
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
      const password = session.v === 2
        ? await decryptWithKey(session.data, session.sessionKey)
        // v1 sessions ran the session key through PBKDF2, which is why a
        // page load used to cost two derivations instead of one.
        : await decrypt(session.data, session.sessionKey, base64ToBuf(session.salt));
      if (!password) { this.clearSession(); return null; }
      const data = await this.unlock(password);
      if (!data) { this.clearSession(); return null; }
      // Carry a v1 session forward so the old cost is paid once, not daily.
      if (session.v !== 2) await this.createSession(password);
      return { data, password };
    } catch {
      this.clearSession();
      return null;
    }
  },

  /** Create a session for auto-unlock persistence. */
  async createSession(password: string): Promise<void> {
    // The session key is 256 bits of randomness, so it is used as an AES key
    // directly rather than fed to a KDF. `v: 2` marks the format; a v1
    // session still restores, once, and is rewritten on the way through.
    const sessionKey = bufToBase64(getRandomBytes(32));
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      v: 2,
      sessionKey,
      data: await encryptWithKey(password, sessionKey),
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
