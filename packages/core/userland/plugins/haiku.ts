import type { Userland } from '../types';


export const Haiku: Userland = {
  id: 'haiku',
  label: 'Haiku',
  sysnames: ['Haiku'],
  notes: 'sysinfo -cpu / -mem. No load average concept; ps is teams not processes, so no harness rows.',
  body: `
  kv nproc "\`sysinfo -cpu 2>/dev/null | grep -c '^CPU #'\`"
  kv cpu "\`sysinfo -cpu 2>/dev/null | sed -n 's/^CPU #0: *//p' | sed -n 1p\`"
  kv mem_raw "\`sysinfo -mem 2>/dev/null | sed -n 1p\`"`,
};
