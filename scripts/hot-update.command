#!/bin/bash
# 风神考核看板 · 本机一键热更新（macOS 双击运行）
#
# 做三件事：读 GitHub 最新 version.json → 下载对应 Release zip → 解压覆盖到插件目录。
# 覆盖完成后，扩展的 updater.js 会在 1 分钟内检测到磁盘版本变化并 chrome.runtime.reload()，
# 也可以到看板点「检查更新」→「已覆盖 · 立即生效」立刻触发。
#
# 用法：
#   双击运行（默认更新到本脚本所在仓库的 ext 目录）
#   或终端执行：bash scripts/hot-update.command [插件目录]
#
# 说明：这是本机工具，不打包进扩展，也不需要扩展额外权限。
set -euo pipefail

EXT_DIR="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
API="https://api.github.com/repos/hubiqi/fengshen-ext/contents/version.json?ref=main"

say() { printf "\n\033[1;34m%s\033[0m\n" "$*"; }
die() { printf "\n\033[1;31m失败：%s\033[0m\n" "$*"; exit 1; }

[ -f "$EXT_DIR/version.json" ] || die "找不到 $EXT_DIR/version.json，请把插件目录作为第一个参数传入"

say "1/4 读取远端版本…"
JSON=$(curl -fsSL --max-time 20 "$API" -H "Accept: application/vnd.github.raw+json") || die "无法连接 GitHub（可稍后重试）"
VER=$(printf '%s' "$JSON" | /usr/bin/python3 -c 'import sys,json;print(json.load(sys.stdin)["version"])')
URL=$(printf '%s' "$JSON" | /usr/bin/python3 -c 'import sys,json;print(json.load(sys.stdin)["download"])')
LOCAL=$(/usr/bin/python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' "$EXT_DIR/version.json" 2>/dev/null || echo "0")

say "远端 v$VER / 本地 v$LOCAL（$EXT_DIR）"
if [ "$VER" = "$LOCAL" ]; then say "已是最新，无需更新。"; exit 0; fi

say "2/4 下载 zip…"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
curl -fL --max-time 180 -o "$TMP/ext.zip" "$URL" || die "下载失败：$URL"

say "3/4 校验 zip…"
unzip -tq "$TMP/ext.zip" >/dev/null || die "zip 校验失败，已中止（插件目录未改动）"

say "4/4 解压覆盖到插件目录…"
unzip -oq "$TMP/ext.zip" -d "$EXT_DIR"
NOW=$(/usr/bin/python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' "$EXT_DIR/version.json")
say "完成：已更新到 v$NOW"
say "扩展会在 1 分钟内自动重载；也可到看板点「检查更新」→「已覆盖 · 立即生效」。"
