#!/bin/sh
# Builds the static site into a FRESH directory (default dist/) for Cloudflare Pages. Functions are bundled from ../functions.
# Assets go under a content-hashed directory so a new index.html can never load JS/CSS cached from an older deploy
# (the zone gives assets a 4 h browser TTL; mixing versions crashed the page at "Loading…"). Hashed files are immutable.
set -eu
cd "$(dirname "$0")/.."
out=${1:-dist}
if [ -e "$out" ] || [ -L "$out" ]; then printf 'build: output already exists; choose a fresh directory\n' >&2; exit 1; fi
assets="style.css app.js maze-view.js maze-renderer.mjs maze-geometry.mjs maze.mjs det-math.mjs replay.mjs maze-data.mjs"
three="vendor/three/three.module.js vendor/three/three.core.js vendor/three/LICENSE vendor/three/README.md"
v=$(cat $assets $three | shasum -a 256 | cut -c1-12)
mkdir -p "$out/$v/vendor/three"
cp $assets "$out/$v/"
cp $three "$out/$v/vendor/three/"
cp og.png "$out/"
sed -e "s#href=\"\./#href=\"./$v/#g" -e "s#src=\"\./#src=\"./$v/#g" index.html > "$out/index.html"
sed "s#/style\.css#/$v/style.css#" 404.html > "$out/404.html"
[ -z "$(grep -oE '(href|src)="\./[^"]*"' "$out/index.html" | grep -v "\./$v/")" ] && grep -q "$v/style.css" "$out/404.html" || { printf 'build: asset path rewrite failed\n' >&2; exit 1; }
printf '/%s/*\n  Cache-Control: public, max-age=31536000, immutable\n' "$v" > "$out/_headers"
