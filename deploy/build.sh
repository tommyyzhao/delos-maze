#!/bin/sh
# Builds the static site into a FRESH directory (default dist/) for Cloudflare Pages. Functions are bundled from ../functions.
set -eu
cd "$(dirname "$0")/.."
out=${1:-dist}
if [ -e "$out" ] || [ -L "$out" ]; then printf 'build: output already exists; choose a fresh directory\n' >&2; exit 1; fi
mkdir -p "$out/vendor/three"
cp index.html 404.html og.png style.css app.js maze-view.js maze-renderer.mjs maze-geometry.mjs maze.mjs det-math.mjs replay.mjs maze-data.mjs "$out/"
cp vendor/three/three.module.js vendor/three/three.core.js vendor/three/LICENSE vendor/three/README.md "$out/vendor/three/"
