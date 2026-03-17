.PHONY: dev fix-watches

fix-watches:
	sudo sysctl fs.inotify.max_user_watches=524288

dev: fix-watches
	npm run dev
