'use client';

import { VaultProvider } from '@unturf/unfirehose-ui/VaultProvider';
import { VaultGate } from '@unturf/unfirehose-ui/VaultGate';
import type { ReactNode } from 'react';

export function VaultShell({ children }: { children: ReactNode }) {
  return (
    <VaultProvider>
      <VaultGate>{children}</VaultGate>
    </VaultProvider>
  );
}
