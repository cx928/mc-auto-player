// test/auto-version-probe.js - 验证 mineflayer 的版本自动探测（version: false）
// 用法: node test/auto-version-probe.js [host] [port] [期望版本]
'use strict'

const mineflayer = require('mineflayer')

const host = process.argv[2] || '127.0.0.1'
const port = Number(process.argv[3]) || 25566
const expect = process.argv[4] || null

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + detail : ''}`)
}

console.log(`连接 ${host}:${port}，version 参数留空（自动探测）...`)
const t0 = Date.now()

const bot = mineflayer.createBot({
  host,
  port,
  username: 'AutoVerProbe',
  auth: 'offline',
  version: false, // ← 关键：让 mineflayer 自己 ping 服务器识别版本
  hideErrors: true,
  viewDistance: 'tiny'
})

let done = false
const finish = (code) => {
  if (done) return
  done = true
  const failed = results.filter(r => !r.ok).length
  console.log(`\n通过 ${results.length - failed} / ${results.length}`)
  try { bot.quit('probe done') } catch (_) {}
  setTimeout(() => process.exit(code ?? (failed ? 1 : 0)), 300)
}

bot.on('login', () => {
  check('版本留空时能成功登录（自动探测生效）', true, `耗时 ${Date.now() - t0} ms`)
  console.log(`     探测到: version=${bot.version}  protocolVersion=${bot.protocolVersion}  majorVersion=${bot.majorVersion}`)
  if (expect) {
    check(`探测结果与服务器版本一致（期望 ${expect}）`, bot.version === expect, `实际 ${bot.version}`)
  }
})

bot.once('spawn', () => {
  check('探测后能正常生成到世界', !!bot.entity)
  finish()
})

bot.on('error', (err) => {
  check('连接未报错', false, err.message)
  finish(1)
})

bot.on('kicked', (reason) => {
  check('未被踢出', false, JSON.stringify(reason).slice(0, 120))
  finish(1)
})

setTimeout(() => {
  check('30 秒内完成探测与登录', false, '超时')
  finish(1)
}, 30000)
