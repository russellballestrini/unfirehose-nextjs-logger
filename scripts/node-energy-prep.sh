#!/bin/sh
# Runs on a node over ssh from `make node-energy-prep HOST=...`. No sudo:
# installs the NVML python bindings for this user and reports the RAPL
# permission, printing the one root step when it is still needed.
python3 -m pip install --user --quiet nvidia-ml-py 2>/dev/null \
  || python3 -m pip install --user --quiet --break-system-packages nvidia-ml-py 2>/dev/null \
  || echo "nvml: pip install of nvidia-ml-py failed; on Debian/Ubuntu: sudo apt-get install python3-pynvml"
python3 -c 'import pynvml as n; n.nvmlInit(); h=n.nvmlDeviceGetHandleByIndex(0); print("nvml energy counter:", n.nvmlDeviceGetTotalEnergyConsumption(h), "mJ")' 2>&1 | tail -1
f=/sys/class/powercap/intel-rapl:0/energy_uj
if [ ! -e "$f" ]; then echo "rapl: no intel-rapl on this machine (not Intel, or the module is off)"
elif [ -r "$f" ]; then echo "rapl: readable"
else
  echo "rapl: not readable (mode $(stat -c %a "$f")); as root on this host:"
  echo "  printf 'z /sys/class/powercap/intel-rapl:0/energy_uj 0444 - - -\nz /sys/class/powercap/intel-rapl:1/energy_uj 0444 - - -\n' > /etc/tmpfiles.d/unfirehose-rapl.conf"
  echo "  systemd-tmpfiles --create /etc/tmpfiles.d/unfirehose-rapl.conf"
fi
