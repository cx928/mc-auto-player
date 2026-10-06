#!/usr/bin/env bash
# MC 自动玩家 · macOS 一键安装并启动（把机器人跑在这台 Mac 上）
#
# 用法：
#   chmod +x scripts/macos-install.sh
#   ./scripts/macos-install.sh
#
# 说明：macOS 上用 Node 直接运行（不打包 .app）。原因见《使用方案.md》：
#   签名与公证必须在 macOS 上用 Xcode/codesign 完成，Apple Silicon 上未签名的可执行文件会被系统拒绝运行。
set -euo pipefail
cd "$(dirname "$0")/.."

echo "=================================================="
echo " MC 自动玩家 · macOS 安装脚本"
echo "=================================================="

# ---------- 1. Node.js ----------
if ! command -v node >/dev/null 2>&1; then
  echo "未检测到 Node.js。"
  if command -v brew >/dev/null 2>&1; then
    echo "用 Homebrew 安装 Node.js（约 1-2 分钟）..."
    brew install node
  else
    echo "请先安装 Homebrew（ https://brew.sh ）或从 https://nodejs.org 安装 Node.js 22+，然后重跑本脚本。"
    exit 1
  fi
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
echo "Node 版本: $(node -v)"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "⚠️  Node 版本偏低（建议 22+）。若安装依赖失败，请升级 Node 后重试。"
fi

# ---------- 2. 依赖 ----------
if [ ! -d node_modules ]; then
  echo "安装运行依赖（首次约 1-3 分钟）..."
  # 跳过 electron（网页版用不到，能省 200MB+）
  npm install --omit=dev --no-audit --no-fund || npm install --no-audit --no-fund
fi

# ---------- 3. 启动控制台 ----------
PORT="${MC_PORT:-8686}"
echo ""
echo "启动控制台： http://localhost:${PORT}"
echo "手机/平板同网段可用： http://<这台Mac的IP>:${PORT}  （系统设置-网络 里查看 IP）"
echo "停止服务： 按 Ctrl+C"
echo ""
exec node web/server.js --port "$PORT" --bind 0.0.0.0 --open
