// Generated plugin list — order matters: the first plugin whose sysname
// pattern matches and whose refine test passes is the one that runs.
import { LinuxAndroid } from './plugins/linux-android';
import { LinuxBusybox } from './plugins/linux-busybox';
import { LinuxGnu } from './plugins/linux-gnu';
import { GnuHurd } from './plugins/gnu-hurd';
import { Freebsd } from './plugins/freebsd';
import { Openbsd } from './plugins/openbsd';
import { Netbsd } from './plugins/netbsd';
import { Darwin } from './plugins/darwin';
import { Sunos } from './plugins/sunos';
import { Aix } from './plugins/aix';
import { HpUx } from './plugins/hp-ux';
import { Irix } from './plugins/irix';
import { Osf1 } from './plugins/osf1';
import { Sco } from './plugins/sco';
import { Haiku } from './plugins/haiku';
import { Qnx } from './plugins/qnx';
import { Cygwin } from './plugins/cygwin';
import { WindowsSh } from './plugins/windows-sh';
import { WindowsPowershell } from './plugins/windows-powershell';
import { Generic } from './plugins/generic';

export const USERLANDS = [
  LinuxAndroid,
  LinuxBusybox,
  LinuxGnu,
  GnuHurd,
  Freebsd,
  Openbsd,
  Netbsd,
  Darwin,
  Sunos,
  Aix,
  HpUx,
  Irix,
  Osf1,
  Sco,
  Haiku,
  Qnx,
  Cygwin,
  WindowsSh,
  WindowsPowershell,
  Generic,
];
