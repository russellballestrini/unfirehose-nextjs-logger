/**
 * systemd escapes a machine unit name -- a hyphen becomes \x2d, so a libvirt
 * guest tracked by machined reads "qemu\x2d1\x2dvm". Decode for display; the
 * raw form stays the cgroup key.
 *
 * On its own so our Containers tab (a client component) decodes names the
 * same way the probe parser does without importing the parser.
 */
export function unescapeMachineName(v: string): string {
  return v.replace(/\\x([0-9a-fA-F]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
}
