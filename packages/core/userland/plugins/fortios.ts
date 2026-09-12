import type { Userland } from '../types';


export const Fortios: Userland = {
  id: 'fortios',
  label: 'Fortinet FortiOS',
  sysnames: [],
  notes: 'Network gear, no shell: `get system status` / `get system performance status`, translated in userland/network.ts. Unverified against a device.',
  body: `
`,
};
