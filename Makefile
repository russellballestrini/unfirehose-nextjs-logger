.PHONY: dev fix-watches persist-watches

# Raise inotify watch ceiling for this boot. Needs root — invoking via sudo
# so make dev does not silently no-op when the user lacks privilege (the prior
# `sysctl ... = 524288` line failed silently and dev kept exhausting watches).
fix-watches:
	sudo sysctl fs.inotify.max_user_watches=524288

# Persist across reboots — write a sysctl drop-in. One-time setup.
persist-watches:
	echo 'fs.inotify.max_user_watches=524288' | sudo tee /etc/sysctl.d/90-inotify.conf
	sudo sysctl --system

# 4GB Node heap — the prior 1GB cap was OOM-killing next dev on this monorepo,
# which presented as random "dev server crashed, hard restart" symptoms.
dev: fix-watches
	NODE_OPTIONS=--max-old-space-size=4096 npm run dev
