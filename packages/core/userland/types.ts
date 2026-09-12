/**
 * A userland is what a machine offers a shell once SSH gets us there: the
 * commands that answer "how many CPUs", "how much memory", "what is the
 * load", and the syntax those commands speak. Kernels share userlands
 * (GNU on Linux, kFreeBSD and Hurd) and userlands differ on one kernel
 * (GNU, busybox and toybox on Linux), so the plugin is keyed on the
 * userland, detected from `uname -s` plus a probe of what is installed.
 *
 * Each plugin contributes one branch of a `case` in a single Bourne-shell
 * script. The branch must:
 *   - never fail the script (every command guarded with `2>/dev/null`,
 *     `|| true`, or an `if have x`),
 *   - never block (no interactive tools, no `sleep` past 0.2s),
 *   - emit only the wire lines below.
 *
 * Wire format (one probe, stdout):
 *   uf=1                      first line; proves a POSIX shell ran the script
 *   key=raw value             one per line — RAW: the command's own words,
 *                             parsed by our TypeScript, never by `expr`
 *                             (32-bit on old boxes, overflows on bytes)
 *   DISK name rota            rota 1 spinning, 0 flash, ? unknown
 *   HPROC <ps aux row>        11 columns: user pid %cpu %mem vsz rss tty
 *                             stat start time command...
 *   RAPL r1 r1b r2 r2b        intel-rapl energy_uj before/after 100ms
 *   GPU <nvidia-smi csv row>  power.draw,name,memory.total,memory.used,util
 *   END                       last line; absence means the script was cut
 */
export interface Userland {
  /** Stable id, also the `userland=` wire value. */
  id: string;
  /** Human name for a settings page or an error message. */
  label: string;
  /**
   * Shell `case` patterns on `uname -s` that select this plugin, e.g.
   * `['FreeBSD', 'MidnightBSD', 'DragonFly']` or `['CYGWIN_NT*']`. Order
   * of the registry decides between plugins whose patterns overlap.
   */
  sysnames: string[];
  /**
   * Optional Bourne-shell test evaluated after the sysname matched; when it
   * fails the next plugin with a matching sysname is tried. Used to tell
   * GNU, busybox and toybox apart on Linux.
   */
  refine?: string;
  /** Bourne-shell body of this plugin's `case` branch. */
  body: string;
  /** Where the design came from, for the next person. */
  notes?: string;
}

/** Keys every plugin should try to emit; a missing key is a blank field. */
export const WIRE_KEYS = [
  'os', 'osrel', 'userland', 'hostname', 'nproc', 'cpu', 'arch', 'pagesize',
  'mem_total', 'mem_avail', 'swap_total', 'swap_free', 'swap_raw',
  'load', 'uptime_s', 'boottime', 'etime1', 'uptime_raw', 'now',
] as const;
export type WireKey = typeof WIRE_KEYS[number];
