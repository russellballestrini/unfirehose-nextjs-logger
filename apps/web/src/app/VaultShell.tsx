'use client';

import { VaultProvider } from '@unturf/unfirehose-ui/VaultProvider';
import type { ReactNode } from 'react';

/**
 * The vault, without a gate in front of the app.
 *
 * VaultGate used to sit here and render a boot screen until the vault had
 * restored its session — two PBKDF2 derivations at 600,000 iterations, about
 * 1.5 seconds in a browser, in front of every page, including pages that
 * never touch a key. The gate's own copy said "skip it and you can still
 * browse everything", and it was right; the only place a key is needed is
 * the API Keys tab in settings, which has its own inline create-and-unlock.
 *
 * So the provider still restores the session in the background, and the
 * pages render while it does. A locked vault is a locked tab, not a locked
 * dashboard.
 */
export function VaultShell({ children }: { children: ReactNode }) {
  return <VaultProvider>{children}</VaultProvider>;
}
