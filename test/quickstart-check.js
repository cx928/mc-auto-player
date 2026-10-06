// test/quickstart-check.js - 验证：版本自动探测 / 一键挂机 / 服务器预设 / 名字去重
// 需要本地测试服在 127.0.0.1:25566
'use strict'

const path = require('path')
const fs = require('fs')
const os = require('os')
const { spawn } = require('child_process')

const MC_HOST = process.env.TEST_HOST || '127.0.0.1'
const MC_PORT = Number(process.env.TEST_PORT || 25566)
const SETTINGS = path.join(os.tmpdir(), 'mc-quickstart-settings.json')

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + detail : ''}`)
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function main () {
  fs.rmSync(SETTINGS, { force: true })
  const child = spawn(process.execPath, [
    path.join(__dirname, '..', 'cli.js'),
    '--host', `${MC_HOST}:${MC_PORT}`, // 故意用 host:port 写法，顺带回归测试端口解析
    '--user', 'QBot',
    '--count', '2',
    '--settings', SETTINGS
  ], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, MC_SETTINGS: SETTINGS } })

  let out = ''
  child.stdout.on('data', (d) => { out += d.toString() })
  child.stderr.on('data', (d) => { out += d.toString() })

  const send = async (line, waitMs = 2500) => { child.stdin.write(line + '\n'); await sleep(waitMs) }

  await sleep(12000)

  check('横幅显示版本为「自动探测」', out.includes('版本: 自动探测'), (out.match(/目标服务器:[^\n]*/) || [''])[0].trim())
  check('横幅显示支持版本范围', /支持版本: 1\.8\.8 ~ 26\.1/.test(out))
  check('连接成功（未手填版本）', out.includes('登录成功'))
  check('自动探测出服务器版本并标注官方测试状态', /服务器版本: 1\.21\.11（官方测试过）/.test(out),
    (out.match(/服务器版本:[^\n]*/) || [''])[0].trim())
  check('两个假人名字正确（QBot1/QBot2）', out.includes('QBot1') && out.includes('QBot2'))

  await send('/versions', 1500)
  check('/versions 列出了 1.12.2', out.includes('1.12.2'))
  check('/versions 列出了 26.3', out.includes('26.3'))
  check('/versions 提示可用 auto', /连接时版本用 auto/.test(out))

  await send('/preset save 本地测试服', 1500)
  check('/preset save 成功', /已保存预设「本地测试服」/.test(out))

  await send('/quick 2', 9000)
  check('/quick 一键再开一批', /一键上线 2 个假人/.test(out))
  check('新一批假人已上线（QBot3/QBot4）', out.includes('QBot3') && out.includes('QBot4'))

  await send('/bots', 2000)
  const botLines = out.split('\n').filter(l => /QBot\d+\s+(在线|离线)/.test(l))
  check('假人列表显示 4 个假人', botLines.length >= 4, `列表行数=${botLines.length}`)

  await send('/msa', 1200)
  check('/msa 报告正版登录状态', /尚未缓存正版登录|正版登录已缓存/.test(out))

  await send('/quit', 1500)
  try { child.kill() } catch (_) {}

  // 预设是否落盘
  let saved = null
  try { saved = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')) } catch (_) {}
  check('预设已持久化到配置文件', !!(saved && saved.presets && saved.presets.length >= 1),
    saved ? `预设=${(saved.presets || []).map(p => p.name).join(',')}` : '无配置文件')
  check('配置文件里没有残留假人（CLI 不自动恢复）', !(saved && saved.bots && saved.bots.length),
    saved ? `bots=${(saved.bots || []).length}` : '')

  fs.rmSync(SETTINGS, { force: true })

  const failed = results.filter(r => !r.ok)
  console.log(`\n通过 ${results.length - failed.length} / ${results.length}`)
  if (failed.length) {
    failed.forEach(f => console.log('  失败: ' + f.name))
    console.log('\n--- 程序输出（末 30 行）---')
    console.log(out.split('\n').slice(-30).join('\n'))
  }
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
