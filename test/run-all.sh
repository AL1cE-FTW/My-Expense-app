#!/bin/sh
# 全テストを順に実行する。1本でも落ちたら終了コード1を返す。
#   sh test/run-all.sh
# Chromium を自分で用意している場合は CHROMIUM_PATH で指定する。
set -u
dir=$(dirname "$0")
failed=0
for f in "$dir"/verify-*.mjs; do
  printf '%-34s ' "$(basename "$f")"
  if out=$(node "$f" 2>&1); then
    echo "$out" | tail -1
  else
    echo "FAILED"
    echo "$out" | tail -20 | sed 's/^/    /'
    failed=1
  fi
done
exit $failed
