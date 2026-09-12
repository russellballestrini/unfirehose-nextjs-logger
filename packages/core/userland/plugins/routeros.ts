import type { Userland } from '../types';


export const Routeros: Userland = {
  id: 'routeros',
  label: 'MikroTik RouterOS',
  sysnames: [],
  notes: 'Network gear, no shell: `/system resource print` over ssh, translated in userland/network.ts. Unverified against a device.',
  body: `
`,
};
