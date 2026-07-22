#!/usr/bin/env bash
# 按编号顺序应用 patches/ 下的全部补丁（在 metabot 仓库根目录或任意位置执行均可）。
# 用法: bash patches/apply-all.sh
set -euo pipefail
cd "$(dirname "$0")/.."

for p in patches/[0-9][0-9]-*.patch; do
  echo "==> applying $p"
  git apply --recount "$p"
done

echo
echo "全部补丁应用完成。"
echo "提醒：补丁 02 的配套测试 tests/media-batch.test.ts 不在 .patch 内，"
echo "如需要请执行: git checkout local-patches -- tests/media-batch.test.ts"
