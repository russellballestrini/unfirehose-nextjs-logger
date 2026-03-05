# uncloseai-com: Extension Bundle Build System

**Repo:** uncloseai-com
**Priority:** Medium
**Todo IDs:** 2904-2910

## Feature

Unified esbuild-based bundle pipeline for the browser extension:

1. Add esbuild, marked, highlight.js devDependencies to main repo
2. Create `scripts/bundle-extension.mjs` esbuild build script
3. Update Makefile, .gitignore, biome.json
4. Update `shared/content.js` with progressive enhancement injection
5. Update all three browser `manifest.json` with `web_accessible_resources`
6. Update browser-toys `build.js` to copy bundle from main repo
7. Build bundle, build extension, run tests

## Notes
Currently the extension build is scattered. This consolidates into a single esbuild pipeline that produces bundles for Chrome, Firefox, and Safari. The progressive enhancement injection means the content script works even without the full extension loaded.
