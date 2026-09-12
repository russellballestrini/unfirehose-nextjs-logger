import type { Userland } from '../types';


export const WindowsCmd: Userland = {
  id: 'windows-cmd',
  label: 'Windows (cmd.exe)',
  sysnames: [],
  notes: 'Not a Bourne branch: cmd.exe fed userland/cmd.ts on stdin when neither sh nor PowerShell exists (XP/2003 with a third-party sshd, or PowerShell disabled by policy).',
  body: `
`,
};
