'use client';

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { Vault, type VaultData } from './vault';

interface VaultCtx {
  /** Whether vault state has been determined */
  ready: boolean;
  /** Whether the vault is unlocked */
  unlocked: boolean;
  /** Whether a vault exists (needs password to unlock) */
  exists: boolean;
  /** The decrypted vault data (null if locked) */
  data: VaultData | null;
  /** Create a new vault with a password */
  create: (password: string) => Promise<void>;
  /** Unlock existing vault */
  unlock: (password: string) => Promise<boolean>;
  /** Lock the vault (clears session) */
  lock: () => void;
  /** Update a key in the vault */
  setKey: (providerId: string, apiKey: string) => Promise<void>;
  /** Remove a key */
  removeKey: (providerId: string) => Promise<void>;
  /** Set preferred provider */
  setPreferred: (providerId: string) => Promise<void>;
  /** Set model override for a provider */
  setModel: (providerId: string, model: string) => Promise<void>;
  /** Set endpoint override for a provider */
  setEndpoint: (providerId: string, endpoint: string) => Promise<void>;
  /** Get the API key for a provider (or empty string) */
  getKey: (providerId: string) => string;
}

const VaultContext = createContext<VaultCtx>({
  ready: false, unlocked: false, exists: false, data: null,
  create: async () => {}, unlock: async () => false, lock: () => {},
  setKey: async () => {}, removeKey: async () => {},
  setPreferred: async () => {}, setModel: async () => {}, setEndpoint: async () => {},
  getKey: () => '',
});

export function useVault() {
  return useContext(VaultContext);
}

export function VaultProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const [exists, setExists] = useState(false);
  const [data, setData] = useState<VaultData | null>(null);
  const [password, setPassword] = useState<string | null>(null);

  // On mount: check if vault exists and try session restore
  useEffect(() => {
    (async () => {
      const has = Vault.hasVault();
      setExists(has);
      if (has) {
        const restored = await Vault.tryRestoreSession();
        if (restored) {
          setData(restored.data);
          setPassword(restored.password);
          setUnlocked(true);
        }
      }
      setReady(true);
    })();
  }, []);

  const persist = useCallback(async (newData: VaultData) => {
    if (!password) return;
    setData(newData);
    await Vault.save(newData, password);
  }, [password]);

  const create = useCallback(async (pw: string) => {
    const d = await Vault.create(pw);
    setData(d);
    setPassword(pw);
    setUnlocked(true);
    setExists(true);
  }, []);

  const unlock = useCallback(async (pw: string): Promise<boolean> => {
    const d = await Vault.unlock(pw);
    if (!d) return false;
    setData(d);
    setPassword(pw);
    setUnlocked(true);
    return true;
  }, []);

  const lock = useCallback(() => {
    Vault.lock();
    setData(null);
    setPassword(null);
    setUnlocked(false);
  }, []);

  const setKey = useCallback(async (providerId: string, apiKey: string) => {
    if (!data) return;
    const next = { ...data, keys: { ...data.keys, [providerId]: apiKey } };
    await persist(next);
  }, [data, persist]);

  const removeKey = useCallback(async (providerId: string) => {
    if (!data) return;
    const keys = { ...data.keys };
    delete keys[providerId];
    await persist({ ...data, keys });
  }, [data, persist]);

  const setPreferred = useCallback(async (providerId: string) => {
    if (!data) return;
    await persist({ ...data, preferred: providerId });
  }, [data, persist]);

  const setModel = useCallback(async (providerId: string, model: string) => {
    if (!data) return;
    await persist({ ...data, models: { ...data.models, [providerId]: model } });
  }, [data, persist]);

  const setEndpoint = useCallback(async (providerId: string, endpoint: string) => {
    if (!data) return;
    await persist({ ...data, endpoints: { ...data.endpoints, [providerId]: endpoint } });
  }, [data, persist]);

  const getKey = useCallback((providerId: string): string => {
    return data?.keys?.[providerId] ?? '';
  }, [data]);

  return (
    <VaultContext.Provider value={{
      ready, unlocked, exists, data,
      create, unlock, lock,
      setKey, removeKey, setPreferred, setModel, setEndpoint, getKey,
    }}>
      {children}
    </VaultContext.Provider>
  );
}
