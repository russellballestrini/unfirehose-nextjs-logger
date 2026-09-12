import type { Userland } from '../types';


export const WindowsPowershell: Userland = {
  id: 'windows-powershell',
  label: 'Windows (PowerShell)',
  sysnames: [],
  notes: 'Not a Bourne branch: what probeRemote runs when the remote has no sh at all. The script is userland/powershell.ts; this entry names the id the wire reports.',
  body: `
`,
};
