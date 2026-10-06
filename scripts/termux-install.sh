#!/data/data/com.termux/files/usr/bin/bash
# MC 自动玩家 · 安卓 Termux 一键安装并启动
#
# 前置：从 F-Droid 或 GitHub 安装 Termux（不要用 Google Play 版，那个已停止更新）
# 用法：
#   把整个项目文件夹拷到手机（或 git clone），在 Termux 里执行：
#     cd /sdcard/mc-auto-player        # 或你的实际路径
#     bash scripts/termux-install.sh
#
# 之后手机浏览器打开 http://localhost:8686 即可；可「添加到主屏幕」当 App 用。
set -euo pipefail
cd "$(dirname "$0")/.."

echo "=================================================="
echo " MC 自动玩家 · Termux（安卓）安装脚本"
echo "=================================================="

# ---------- 1. Node.js ----------
if ! command -v node >/dev/null 2>&1; then
  echo "安装 Node.js ..."
  pkg update -y || true
  pkg install -y nodejs-lts || pkg install -y nodejs
fi
echo "Node 版本: $(node -v 2>/dev/null || echo '安装失败')"

# ---------- 2. 依赖（走国内镜像） ----------
if [ ! -d node_modules ]; then
  echo "安装运行依赖（首次约 2-5 分钟，安卓上较慢请耐心）..."
  npm config set registry https://registry.npmmirror.com || true
  npm install --omit=dev --no-audit --no-fund
fi

# ---------- 3. 防止被系统杀掉 ----------
if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock
  echo "已申请唤醒锁（termux-wake-lock），避免后台被安卓回收"
  echo "提示：建议在 Termux 里执行 termux-setup-storage 授予存储权限；"
  echo "      想常驻可再装 tmux： pkg install tmux && tmux new -s bot"
fi

# ---------- 4. 启动 ----------
PORT="${MC_PORT:-8686}"
echo ""
echo "控制台已启动：用手机浏览器打开 http://localhost:${PORT}"
echo "在浏览器菜单里选「添加到主屏幕」，就能像 App 一样打开。"
echo "停止服务： 在 Termux 里按 Ctrl+C"
echo ""
exec node web/server.js --port "$PORT" --bind 127.0.0.1
