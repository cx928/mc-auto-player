// main.js - Electron 主进程
// 负责创建窗口、桥接多假人管理器与界面（IPC）
'use strict'

const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')
const { BotManager } = require('./bot/manager')

let win = null
let manager = null
let logFile = null

function ensureLogFile () {
  if (!logFile) {
    logFile = path.join(app.getPath('userData'), 'bot.log')
    try { fs.mkdirSync(path.dirname(logFile), { recursive: true }) } catch (_) {}
  }
  return logFile
}

function send (channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function createWindow () {
  win = new BrowserWindow({
    width: 1060,
    height: 820,
    minWidth: 880,
    minHeight: 620,
    title: 'MC 自动玩家 - 多假人 + AI',
    autoHideMenuBar: true,
    backgroundColor: '#14171c',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  win.on('closed', () => { win = null })
}

function registerIpc () {
  ipcMain.handle('state', () => ({
    ai: manager.ai,
    bots: manager.getBots(),
    presets: manager.presets,
    lastUsed: manager.lastUsed,
    autoStart: manager.autoStart,
    versions: manager.versionsInfo(),
    microsoft: manager.microsoftStatus()
  }))
  ipcMain.handle('addBot', (_e, cfg) => ({ id: manager.addBot(cfg || {}) }))
  ipcMain.handle('batchAdd', (_e, cfg) => ({ ids: manager.batchAdd(cfg || {}) }))
  ipcMain.handle('quickStart', (_e, cfg) => ({ ids: manager.quickStart(cfg || {}) }))
  ipcMain.handle('savePreset', (_e, p) => ({ preset: manager.savePreset(p || {}) }))
  ipcMain.handle('removePreset', (_e, name) => ({ ok: manager.removePreset(String(name || '')) }))
  ipcMain.handle('microsoftStatus', () => ({ status: manager.microsoftStatus() }))
  ipcMain.handle('removeBot', (_e, id) => ({ ok: manager.removeBot(id) }))
  ipcMain.handle('clearBots', () => { manager.clear(); return { ok: true } })
  ipcMain.handle('startBot', (_e, id) => ({ ok: manager.startBot(id) }))
  ipcMain.handle('stopBot', (_e, id) => ({ ok: manager.stopBot(id) }))
  ipcMain.handle('startAll', () => ({ count: manager.startAll() }))
  ipcMain.handle('stopAll', () => { manager.stopAll(); return { ok: true } })
  ipcMain.handle('setAiMode', (_e, id, mode) => ({ ok: manager.setAiMode(id, mode) }))
  ipcMain.handle('saveAi', (_e, cfg) => ({ ai: manager.updateAiSettings(cfg || {}) }))
  ipcMain.handle('testAi', async () => {
    try {
      return { ok: true, ...(await manager.testAi()) }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  })
  ipcMain.handle('action', (_e, id, name, args) => ({ ok: manager.action(id, name, args || {}) }))
}

app.whenReady().then(() => {
  manager = new BotManager({ settingsFile: path.join(app.getPath('userData'), 'settings.json') })

  // 日志批量推送：多假人时日志可达上百条/秒，逐条 IPC 会让界面做上百次渲染
  let logBuf = []
  let logTimer = null
  const flushLogs = () => {
    if (logTimer) { clearTimeout(logTimer); logTimer = null }
    if (!logBuf.length) return
    const batch = logBuf
    logBuf = []
    send('logBatch', batch)
  }
  manager.on('log', (e) => {
    try { fs.appendFileSync(ensureLogFile(), `[${e.botName}] ${e.line}\n`) } catch (_) {}
    logBuf.push({ botId: e.botId, botName: e.botName, line: e.line })
    if (logBuf.length >= 50) return flushLogs()
    if (!logTimer) logTimer = setTimeout(flushLogs, 150)
  })
  manager.on('bots', (list) => send('bots', list))
  manager.on('msa-code', (e) => send('msa-code', e))
  manager.on('ai', (s) => send('ai', s))
  manager.on('presets', (list) => send('presets', list))

  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (manager) manager.shutdown()
  app.quit()
})

app.on('before-quit', () => { if (manager) manager.shutdown() })
