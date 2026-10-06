// build/sea-web.js - WebUI 版的 SEA 启动入口（会被注入到 exe 里，必须自包含，只能用内置模块）
'use strict'

const path = require('path')
const { createRequire } = require('module')

const appDir = path.join(path.dirname(process.execPath), 'app')
const entry = path.join(appDir, 'web', 'server.js')

// 双击运行（不带任何参数）时自动打开浏览器，方便直接使用
const userArgs = process.argv.slice(2)
if (userArgs.length === 0) userArgs.push('--open')

process.argv = [process.execPath, entry].concat(userArgs)

try {
  createRequire(path.join(appDir, 'package.json'))('./web/server.js')
} catch (e) {
  console.error('')
  console.error('[启动失败] ' + (e && e.message))
  console.error('请确认本可执行文件与 app、node_modules 两个目录放在同一层。')
  console.error('')
  process.exit(1)
}
