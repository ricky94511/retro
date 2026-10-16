#!/bin/bash
# 打包成 Cowork 可上傳的 zip（不需要金鑰）。在 Mac 上執行：
#   bash scripts/pack.sh [輸出路徑，預設 ~/Downloads/fupan.zip]
set -euo pipefail
cd "$(dirname "$0")/.."
out="${1:-$HOME/Downloads/fupan.zip}"
case "$out" in /*) ;; *) out="$PWD/$out" ;; esac
case "$out" in "$PWD"/*) echo "輸出路徑不能在 fupan 資料夾裡：$out" >&2; exit 1 ;; esac

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
# 只打包 git 裡的檔案（HEAD）；zip 根目錄就是外掛本體（沒有頂層 bin/）
git archive --format=tar HEAD -- .claude-plugin hooks types README.md | tar -x -C "$tmp"
rm -f "$out"
(cd "$tmp" && zip -qr "$out" .)
echo "已打包：$out"
