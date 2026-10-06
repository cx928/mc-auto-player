// preload.js - 安全桥：把 ipcRenderer 封装成 window.api 暴露给界面
// 接口与 WebUI 版的 HTTP 接口保持一致，界面代码可以完全共用
'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  // 状态与设置
  getState: () => ipcRenderer.invoke('state'),
  saveAi: (cfg) => ipcRenderer.invoke('saveAi', cfg),
  testAi: () => ipcRenderer.invoke('testAi'),

  // 假人管理
  addBot: (cfg) => ipcRenderer.invoke('addBot', cfg),
  batchAdd: (cfg) => ipcRenderer.invoke('batchAdd', cfg),
  removeBot: (id) => ipcRenderer.invoke('removeBot', id),
  clearBots: () => ipcRenderer.invoke('clearBots'),
  startBot: (id) => ipcRenderer.invoke('startBot', id),
  stopBot: (id) => ipcRenderer.invoke('stopBot', id),
  startAll: () => ipcRenderer.invoke('startAll'),
  stopAll: () => ipcRenderer.invoke('stopAll'),
  setAiMode: (id, mode) => ipcRenderer.invoke('setAiMode', id, mode),

  // 手动操作
  action: (id, name, args) => ipcRenderer.invoke('action', id, name, args),

  // 事件订阅
  onLog: (cb) => ipcRenderer.on('log', (_e, payload) => cb(payload)),
  onBots: (cb) => ipcRenderer.on('bots', (_e, list) => cb(list)),
  onMsaCode: (cb) => ipcRenderer.on('msa-code', (_e, payload) => cb(payload)),
  onAi: (cb) => ipcRenderer.on('ai', (_e, s) => cb(s))
})
