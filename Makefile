.PHONY: dev fix-watches

fix-watches:
	sysctl fs.inotify.max_user_watches=524288

dev: fix-watches
	NODE_OPTIONS=--max-old-space-size=1024 npm run dev
