// web/server.js - WebUI 版：本地 HTTP 服务 + 浏览器控制面板
// 不依赖 Electron，可在 Linux 服务器无界面运行；支持多假人与 AI 对话/操控
// 用法: node web/server.js [--port 8686] [--bind 0.0.0.0] [--open]
'use strict'

const http = require('http')
const fs = require('fs')
const path = require('path')
const { exec } = require('child_process')
const { BotManager } = require('../bot/manager')

function parseArgs (argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const k = a.slice(2)
      const v = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : 'true'
      out[k] = v
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const PORT = Number(args.port) || 8686
const BIND = args.bind || '0.0.0.0'
const RENDERER_DIR = path.join(__dirname, '..', 'renderer')
const SETTINGS_FILE = process.env.MC_SETTINGS || path.join(process.cwd(), 'mc-auto-player-settings.json')

const manager = new BotManager({ settingsFile: SETTINGS_FILE })

// ---------- SSE 广播 ----------
const clients = new Set()
function broadcast (type, payload) {
  const data = `data: ${JSON.stringify({ type, payload })}\n\n`
  for (const res of clients) {
    try { res.write(data) } catch (_) { clients.delete(res) }
  }
}

manager.on('log', (e) => broadcast('log', e))
manager.on('bots', (list) => broadcast('bots', list))
manager.on('msa-code', (e) => broadcast('msa-code', e))
manager.on('ai', (s) => broadcast('ai', s))
manager.on('presets', (list) => broadcast('presets', list))

// ---------- 静态文件 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.ico': 'image/x-icon'
}

function serveStatic (res, urlPath) {
  const name = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '')
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) { res.writeHead(400); return res.end('bad request') }
  const file = path.join(RENDERER_DIR, name)
  if (!file.startsWith(RENDERER_DIR)) { res.writeHead(403); return res.end('forbidden') }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found') }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' })
    res.end(buf)
  })
}

// ---------- 动作路由（与 Electron preload 的 window.api 一一对应） ----------
const actions = {
  addBot: (b) => ({ id: manager.addBot(b || {}) }),
  batchAdd: (b) => ({ ids: manager.batchAdd(b || {}) }),
  removeBot: (b) => ({ ok: manager.removeBot(b.id) }),
  clearBots: () => { manager.clear(); return { ok: true } },
  startBot: (b) => ({ ok: manager.startBot(b.id) }),
  stopBot: (b) => ({ ok: manager.stopBot(b.id) }),
  startAll: () => ({ count: manager.startAll() }),
  stopAll: () => { manager.stopAll(); return { ok: true } },
  setAiMode: (b) => ({ ok: manager.setAiMode(b.id, b.mode) }),
  saveAi: (b) => ({ ai: manager.updateAiSettings(b || {}) }),
  savePreset: (b) => ({ preset: manager.savePreset(b || {}) }),
  removePreset: (b) => ({ ok: manager.removePreset(String(b.name || '')) }),
  quickStart: (b) => ({ ids: manager.quickStart(b || {}) }),
  microsoftStatus: () => ({ status: manager.microsoftStatus() }),
  action: (b) => ({ ok: manager.action(b.id, b.name, b.args || {}) })
}

function readBody (req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy() })
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}) } catch (_) { resolve({}) }
    })
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const p = url.pathname

  if (p === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    })
    res.write(': connected\n\n')
    clients.add(res)
    const hb = setInterval(() => { try { res.write(': ping\n\n') } catch (_) {} }, 15000)
    req.on('close', () => { clearInterval(hb); clients.delete(res) })
    return
  }

  if (p === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    return res.end(JSON.stringify({
      ai: manager.ai,
      bots: manager.getBots(),
      presets: manager.presets,
      lastUsed: manager.lastUsed,
      autoStart: manager.autoStart,
      versions: manager.versionsInfo(),
      microsoft: manager.microsoftStatus()
    }))
  }

  if (p === '/api/testAi') {
    let out
    try {
      out = { ok: true, ...(await manager.testAi()) }
    } catch (e) {
      out = { ok: false, error: e.message }
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    return res.end(JSON.stringify(out))
  }

  if (p.startsWith('/api/')) {
    const name = p.slice(5)
    const fn = actions[name]
    if (!fn) { res.writeHead(404); return res.end('{"ok":false}') }
    const body = await readBody(req)
    let out = { ok: true }
    try {
      out = { ok: true, ...fn(body) }
    } catch (e) {
      console.error('动作失败', name, e.message)
      out = { ok: false, error: e.message }
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    return res.end(JSON.stringify(out))
  }

  serveStatic(res, p)
})

server.listen(PORT, BIND, () => {
  const shown = BIND === '0.0.0.0' ? 'localhost' : BIND
  console.log('==================================================')
  console.log(' MC 自动玩家 - WebUI 模式（多假人 + AI）')
  console.log(` 控制面板: http://${shown}:${PORT}`)
  console.log(` 配置文件: ${SETTINGS_FILE}`)
  console.log(' 停止服务: Ctrl+C')
  console.log('==================================================')
  if (args.open === 'true') {
    const cmd = process.platform === 'win32' ? `start "" http://localhost:${PORT}`
      : process.platform === 'darwin' ? `open http://localhost:${PORT}`
        : `xdg-open http://localhost:${PORT}`
    exec(cmd, () => {})
  }
})

process.on('SIGINT', () => {
  console.log('\n正在关闭...')
  manager.shutdown()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 800)
})
