#!/bin/sh
# Release the four npm packages at one version, from git, in one step.
#
#   scripts/publish.sh --dry-run [patch|minor|major|X.Y.Z]   pack, publish nothing, change nothing
#   scripts/publish.sh [patch|minor|major|X.Y.Z]             bump, commit, tag
#
# Versions used to be bumped by the CI publish job, in its own checkout, so
# git said 1.3.0 for every package while npm served 1.3.7. Here the bump is
# a commit and the tag points at it. The next version counts up from
# whichever is higher, npm's or ours.
#
# CI is our only publisher (fox, 2026-10-24): pushing the tag runs GitLab's
# publish job, which holds NPM_TOKEN and waits for the registry to answer
# for every package. No token lives on a laptop, so there is one publishing
# path and one place a token lives. Pushing stays a separate, deliberate
# step: the command is printed at the end.
set -eu

PKGS="packages/core packages/schema packages/router packages/ui"
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

DRY=0
BUMP=patch
for arg in "$@"; do
  case "$arg" in
    --dry-run|-n) DRY=1 ;;
    patch|minor|major) BUMP=$arg ;;
    [0-9]*.[0-9]*.[0-9]*) BUMP=$arg ;;
    *) echo "usage: $0 [--dry-run] [patch|minor|major|X.Y.Z]" >&2; exit 2 ;;
  esac
done

# Every package must agree before we pick a next version for all of them.
OURS=$(node -e '
  const v = new Set(process.argv.slice(1).map(d => require(`./${d}/package.json`).version));
  if (v.size !== 1) { console.error(`packages disagree: ${[...v].join(", ")}`); process.exit(1); }
  console.log([...v][0]);
' $PKGS)
NPM=$(npm view @unturf/unfirehose version 2>/dev/null || echo 0.0.0)

VERSION=$(node -e '
  const [ours, npm, bump] = process.argv.slice(1);
  const parse = s => s.split(".").map(Number);
  const cmp = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
  const base = cmp(parse(ours), parse(npm)) >= 0 ? parse(ours) : parse(npm);
  let next;
  if (/^\d+\.\d+\.\d+$/.test(bump)) {
    next = parse(bump);
    if (cmp(next, base) <= 0) { console.error(`${bump} is not above ${base.join(".")}`); process.exit(1); }
  } else {
    const [M, m, p] = base;
    next = bump === "major" ? [M + 1, 0, 0] : bump === "minor" ? [M, m + 1, 0] : [M, m, p + 1];
  }
  console.log(next.join("."));
' "$OURS" "$NPM" "$BUMP")
TAG="v$VERSION"

echo "git says $OURS, npm says $NPM -> $TAG$( [ $DRY = 1 ] && echo ' (dry run)')"

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "tag $TAG already exists" >&2; exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  if [ $DRY = 1 ]; then echo "warning: working tree is dirty; a real publish would refuse"
  else echo "working tree is dirty; commit or stash first" >&2; exit 1; fi
fi

# Write VERSION into every package.json and its lockfile entry.
set_version() {
  node -e '
    const fs = require("fs");
    const [v, ...dirs] = process.argv.slice(1);
    for (const d of dirs) {
      const f = `${d}/package.json`;
      const j = JSON.parse(fs.readFileSync(f, "utf8"));
      j.version = v;
      fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");
    }
    const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
    for (const d of dirs) if (lock.packages?.[d]) lock.packages[d].version = v;
    fs.writeFileSync("package-lock.json", JSON.stringify(lock, null, 2) + "\n");
  ' "$1" $PKGS
}

if [ $DRY = 1 ]; then
  # Bump in place so the tarballs carry the real version, then put every
  # file back however this exits.
  for f in package-lock.json $(for d in $PKGS; do echo "$d/package.json"; done); do
    cp "$f" "$f.publish-dry-run"
  done
  restore() {
    for f in package-lock.json $(for d in $PKGS; do echo "$d/package.json"; done); do
      [ -f "$f.publish-dry-run" ] && mv "$f.publish-dry-run" "$f"
    done
  }
  trap restore EXIT INT TERM
  set_version "$VERSION"
  for d in $PKGS; do
    echo "==> $d"
    (cd "$d" && npm publish --dry-run --access public 2>&1 | grep -E '^npm notice (name|version|total files|package size)|Publishing to' || true)
  done
  echo "dry run: nothing committed, tagged or published"
  exit 0
fi

make typecheck
set_version "$VERSION"
git add package-lock.json $(for d in $PKGS; do echo "$d/package.json"; done)
git commit -q -m "release: $TAG"
git tag -a "$TAG" -m "$TAG"

echo
echo "tagged $TAG. To publish it, push the commit and tag; CI's publish job does the rest:"
echo "  git push origin HEAD --follow-tags"
