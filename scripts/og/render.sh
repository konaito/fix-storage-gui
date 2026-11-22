#!/usr/bin/env bash
# scripts/og/og-card.html を 1200x630 で撮り、site/og-image.png に書き出す。
# 必要なもの: agent-browser、macOS の sips
set -euo pipefail
cd "$(dirname "$0")/../.."
root="$(pwd)"
out="$root/site/og-image.png"
session="og-card-$$"

agent-browser --session "$session" set viewport 1200 630 >/dev/null
agent-browser --session "$session" open "file://$root/scripts/og/og-card.html" >/dev/null
agent-browser --session "$session" wait 500 >/dev/null
agent-browser --session "$session" screenshot "$out" >/dev/null
agent-browser --session "$session" close >/dev/null

w=$(sips -g pixelWidth "$out" | awk '/pixelWidth/ {print $2}')
h=$(sips -g pixelHeight "$out" | awk '/pixelHeight/ {print $2}')
if [ "$w" != 1200 ] || [ "$h" != 630 ]; then
  echo "サイズが 1200x630 ではない: ${w}x${h}" >&2
  exit 1
fi
echo "$out ${w}x${h} $(wc -c <"$out" | tr -d ' ') bytes"
