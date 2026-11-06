#!/bin/sh
# Runs on a node over ssh from `make node-energy-prep HOST=...`. No sudo:
# installs the NVML python bindings for this user and reports the RAPL
# permission and its udev rule, printing the root step when one is missing.
python3 -m pip install --user --quiet nvidia-ml-py 2>/dev/null \
  || python3 -m pip install --user --quiet --break-system-packages nvidia-ml-py 2>/dev/null \
  || echo "nvml: pip install of nvidia-ml-py failed; on Debian/Ubuntu: sudo apt-get install python3-pynvml"
python3 -c 'import pynvml as n; n.nvmlInit(); h=n.nvmlDeviceGetHandleByIndex(0); print("nvml energy counter:", n.nvmlDeviceGetTotalEnergyConsumption(h), "mJ")' 2>&1 | tail -1
f=/sys/class/powercap/intel-rapl:0/energy_uj
rule=/etc/udev/rules.d/90-unfirehose-rapl.rules
if [ ! -e "$f" ]; then echo "rapl: no intel-rapl on this machine (not Intel, or the module is off)"
else
  [ -r "$f" ] && echo "rapl: readable (mode $(stat -c %a "$f"))" || echo "rapl: not readable (mode $(stat -c %a "$f"))"
  if [ -f "$rule" ]; then echo "rapl: udev rule present, survives reboots"
  else
    # A tmpfiles line alone races the module load (Fedora lost it on a
    # reboot, 2026-11-04); udev's add event fires after the attribute exists.
    echo "rapl: no udev rule, so a reboot may lock it again; as root on this host:"
    echo "  cat > $rule <<'EOF'"
    echo '  SUBSYSTEM=="powercap", ACTION=="add", TEST=="energy_uj", RUN+="/usr/bin/chmod 0444 /sys%p/energy_uj"'
    echo "  EOF"
    echo "  udevadm control --reload && udevadm trigger -s powercap -c add"
  fi
fi
