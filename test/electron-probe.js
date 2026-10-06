// test/electron-probe.js - 最小探针：验证 Electron 运行时与窗口创建是否正常
'use strict'

const { app, BrowserWindow } = require('electron')

console.log('[probe] electron=', process.versions.electron, 'chrome=', process.versions.chrome, 'node=', process.versions.node)
console.log('[probe] ELECTRON_RUN_AS_NODE=', process.env.ELECTRON_RUN_AS_NODE)

app.whenReady().then(async () => {
  console.log('[probe] app ready OK')
  try {
    const win = new BrowserWindow({ width: 400, height: 300, show: false })
    await win.loadURL('data:text/html,<h1>probe</h1>')
    console.log('[probe] window created + loaded OK')
    win.destroy()
  } catch (e) {
    console.error('[probe] window failed:', e.message)
  }
  console.log('[probe] DONE')
  app.quit()
}).catch((e) => {
  console.error('[probe] app.whenReady failed:', e)
  process.exit(2)
})
