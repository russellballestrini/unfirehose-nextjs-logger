import type { Userland } from '../types';


export const Esxi: Userland = {
  id: 'esxi',
  label: 'VMware ESXi',
  sysnames: ['VMkernel'],
  notes: 'ESXi: a busybox-ish sh with esxcli and vsish, no /proc. The hypervisor most homelabs run, so it sits in tier 1. Its uptime command prints load averages.',
  body: `
  kv nproc "\`esxcli hardware cpu global get 2>/dev/null | sed -n 's/^ *CPU Threads: *//p'\`"
  kv cpu "\`esxcli hardware cpu list 2>/dev/null | sed -n 's/^ *Brand: *//p' | sed -n 1p\`"
  kv model "\`esxcli hardware platform get 2>/dev/null | sed -n 's/^ *Product Name: *//p'\`"
  kv osrel "\`vmware -v 2>/dev/null\`"
  kv mem_total "\`esxcli hardware memory get 2>/dev/null | sed -n 's/^ *Physical Memory: *//p'\`"
  kv mem_avail "\`vsish -e get /memory/comprehensive 2>/dev/null | sed -n 's/^ *Free: *//p' | sed -n 1p\`"
  kv vms "\`esxcli vm process list 2>/dev/null | grep -c 'World ID'\`"
  esxcli storage core device list 2>/dev/null | awk '/^[^ ]/ {d=$1} /Is SSD:/ { r = ($3=="true") ? 0 : 1; if (d !~ /^mpx\\./) print "DISK", d, r }'`,
};
