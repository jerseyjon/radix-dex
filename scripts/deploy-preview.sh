#!/bin/sh
# Build the read-only preview (static site + fresh data snapshot) and publish it to the gh-pages branch.
# Usage: scripts/deploy-preview.sh [number-of-markets]
set -eu
cd "$(dirname "$0")/.."
REPO_URL=$(git remote get-url origin)
WORK=$(mktemp -d)
trap 'rm -r "$WORK"' EXIT
(cd apps/web && VITE_STATIC=1 VITE_BASE=/radix-dex/ npx vite build --outDir "$WORK/site" --emptyOutDir)
npx tsx scripts/snapshot.ts "$WORK/site/snapshot" "${1:-20}"
touch "$WORK/site/.nojekyll"
cd "$WORK/site"
git init -q -b gh-pages
git add -A
git -c user.name="radix-dex preview" -c user.email="preview@localhost" commit -qm "Read-only preview build"
git push -f "$REPO_URL" gh-pages
