#!/bin/bash
# 风神看板 · 热更新本地助手（一次性安装）
#
# 用法：把本文件放在扩展根目录（fengshen-data/ext），双击运行即可。
# 它会把本地助手装到 ~/Library/Application Support/FengshenNative/，
# 并在 Chrome 的 NativeMessagingHosts 里登记，使「热更新」按钮能一键自动更新。
# 只需安装这一次，之后每次更新都由按钮全自动完成。
set -euo pipefail

# 本脚本应在扩展根目录内被双击，因此自身所在目录即扩展目录
EXT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ ! -f "$EXT_DIR/manifest.json" ]; then
  osascript -e 'display dialog "找不到扩展目录的 manifest.json，请确认是从扩展文件夹内双击本脚本。" buttons {"好"} default button 1 with icon stop' >/dev/null 2>&1 || true
  exit 1
fi

# 去掉代理变量（与 git 推送 / 下载踩过的坑同源），避免后续命令被代理挡住
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy FTP_PROXY ftp_proxy ALL_PROXY all_proxy

# 取 node 绝对路径，写进包装脚本，保证 Chrome 启动助手时一定能找到 node
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  osascript -e 'display dialog "本机未找到 node，请先安装 Node.js（https://nodejs.org）后再运行安装。" buttons {"好"} default button 1 with icon stop' >/dev/null 2>&1 || true
  exit 1
fi

# 取扩展 ID：优先用剪贴板（看板「热更新」面板里有，可先复制），否则弹窗输入
PROMPT="请输入本扩展的 ID（在看板的「热更新」面板里会显示，或到 chrome://extensions 详情页查看）。本地助手只需安装这一次。"
CLIP="$(pbpaste 2>/dev/null || true)"
if [[ "$CLIP" =~ ^[a-p]{32}$ ]]; then
  EXT_ID="$(osascript 2>/dev/null <<EOF
display dialog "$PROMPT" default answer "$CLIP" buttons {"取消","确定"} default button 2 with title "安装热更新本地助手"
text returned of result
EOF
)"
else
  EXT_ID="$(osascript 2>/dev/null <<EOF
display dialog "$PROMPT" default answer "" buttons {"取消","确定"} default button 2 with title "安装热更新本地助手"
text returned of result
EOF
)"
fi

if [[ ! "$EXT_ID" =~ ^[a-p]{32}$ ]]; then
  osascript -e 'display dialog "扩展 ID 格式不对（应为 32 位小写字母 a-p），安装已中止。可重新运行本脚本。" buttons {"好"} default button 1 with icon stop' >/dev/null 2>&1 || true
  exit 1
fi

SUPPORT="$HOME/Library/Application Support"
NATIVE_DIR="$SUPPORT/FengshenNative"
MANIFEST_DIR="$SUPPORT/Google/Chrome/NativeMessagingHosts"
mkdir -p "$NATIVE_DIR" "$MANIFEST_DIR"

# 复制助手主体与配置
cp "$EXT_DIR/native/host.js" "$NATIVE_DIR/host.js"

# 写配置（含扩展目录与 ID），助手靠它定位要覆盖的扩展目录
cat > "$NATIVE_DIR/host.config.json" <<JSON
{
  "version": "1.0.0",
  "extDir": "$EXT_DIR",
  "extId": "$EXT_ID"
}
JSON

# 写包装脚本：用绝对 node 路径启动 host.js，确保 Chrome 启动助手时环境里能找到 node
cat > "$NATIVE_DIR/host.sh" <<SH
#!/bin/bash
exec "$NODE_BIN" "$NATIVE_DIR/host.js" "\$@"
SH
chmod +x "$NATIVE_DIR/host.js" "$NATIVE_DIR/host.sh"

# 写 Native Messaging 清单（allowed_origins 只放行本扩展）
cat > "$MANIFEST_DIR/com.fengshen.hotupdate.json" <<JSON
{
  "name": "com.fengshen.hotupdate",
  "description": "风神看板热更新本地助手",
  "path": "$NATIVE_DIR/host.sh",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
JSON

osascript -e 'display notification "本地助手已安装。回到看板点「热更新」即可一键自动更新。" with title "风神看板"' >/dev/null 2>&1 || true
osascript -e 'display dialog "安装完成！\n\n现在回到看板，点工具栏「热更新」按钮：会自动下载新版本、由本助手静默覆盖插件目录、并自动重载——全程无需再双击脚本。\n\n（本助手只做一次安装，之后每次更新都自动完成。）" buttons {"好"} default button 1 with title "安装成功"' >/dev/null 2>&1 || true
echo "installed ok: extDir=$EXT_DIR extId=$EXT_ID"
