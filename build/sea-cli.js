// build/sea-cli.js - 命令行版的 SEA 启动入口（会被注入到 exe 里，必须自包含，只能用内置模块）
'use strict'

const path = require('path')
const { createRequire } = require('module')

// SEA 下 process.argv = [exe, exe, ...用户参数]，真正的参数从下标 2 开始
const appDir = path.join(path.dirname(process.execPath), 'app')
const entry = path.join(appDir, 'cli.js')
process.argv = [process.execPath, entry].concat(process.argv.slice(2))

try {
  // 用 createRequire 指向 app 目录，这样 node_modules 可以放在 exe 同级目录
  createRequire(path.join(appDir, 'package.json'))('./cli.js')
} catch (e) {
  console.error('')
  console.error('[启动失败] ' + (e && e.message))
  console.error('请确认本可执行文件与 app、node_modules 两个目录放在同一层。')
  console.error('')
  process.exit(1)
}
