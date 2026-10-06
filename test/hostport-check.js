// test/hostport-check.js - 回归测试：地址里带端口时能否正确解析
// 背景：用户执行 --host 47.97.161.148:43042 时，整串被当成域名做 DNS 解析 -> ENOTFOUND
// 用法: node test/hostport-check.js   （需本地 1.21.11 测试服在 127.0.0.1:25566）
'use strict'

const path = require('path')
const { spawn } = require('child_process')
const { splitHostPort } = require('../bot/util')

const MC_HOST = process.env.TEST_HOST || '127.0.0.1'
const MC_PORT = Number(process.env.TEST_PORT || 25566)

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + detail : ''}`)
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function testParse () {
  const cases = [
    [['1.2.3.4', undefined], { host: '1.2.3.4', port: 25565 }],
    [['1.2.3.4:43042', undefined], { host: '1.2.3.4', port: 43042 }],
    [['47.97.161.148:43042', undefined], { host: '47.97.161.148', port: 43042 }],
    [['[2001:db8::1]:43042', undefined], { host: '2001:db8::1', port: 43042 }],
    [['2001:db8::1', undefined], { host: '2001:db8::1', port: 25565 }],
    [['mc.example.com', '25566'], { host: 'mc.example.com', port: 25566 }],
    [['mc.example.com:43042', '25566'], { host: 'mc.example.com', port: 43042 }], // 地址里的端口优先
    [['  1.2.3.4:43042  ', undefined], { host: '1.2.3.4', port: 43042 }],
    [[undefined, undefined], { host: '127.0.0.1', port: 25565 }]
  ]
  for (const [[h, p], want] of cases) {
    const got = splitHostPort(h, p)
    check(`解析 ${JSON.stringify(h)} / port=${JSON.stringify(p)}`,
      got.host === want.host && got.port === want.port,
      `得到 ${got.host}:${got.port}，期望 ${want.host}:${want.port}`)
  }
}

async function runCli (args, waitMs, sendLines = []) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'cli.js')].concat(args), {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, MC_SETTINGS: path.join(require('os').tmpdir(), 'mc-hostport-settings.json') }
  })
  let out = ''
  child.stdout.on('data', (d) => { out += d.toString() })
  child.stderr.on('data', (d) => { out += d.toString() })
  await sleep(waitMs)
  for (const l of sendLines) { child.stdin.write(l + '\n'); await sleep(2000) }
  try { child.kill() } catch (_) {}
  return out
}

async function main () {
  testParse()

  // 1. 用 host:port 写法连本地测试服，应该真的连上
  const out1 = await runCli(['--host', `${MC_HOST}:${MC_PORT}`, '--user', 'HpBot', '--version', '1.21.11'], 12000, ['/status'])
  check('host:port 写法能连上服务器', out1.includes('登录成功'),
    (out1.match(/正在连接[^\n]*/) || [''])[0].trim())
  check('状态查询正常（端口确实生效）', out1.includes('"connected": true'))

  // 2. 主机名真的解析不了时，给人话提示而不是原始堆栈
  const out2 = await runCli(['--host', 'no-such-host.invalid', '--user', 'HpBot2'], 9000)
  check('解析失败时给出人话提示', /域名\/IP 解析失败/.test(out2),
    (out2.match(/连接失败：[^\n]*/) || [''])[0].trim().slice(0, 120))
  check('不再打印原始堆栈（输出干净）', !/at GetAddrInfoReqWrap/.test(out2))

  // 3. 地址格式明显不对（冒号过多）时给出针对性提示
  const out3 = await runCli(['--host', 'a:b:c', '--user', 'HpBot3'], 9000)
  check('格式错误时提示正确写法', /冒号过多/.test(out3),
    (out3.match(/连接失败：[^\n]*/) || [''])[0].trim().slice(0, 120))

  const failed = results.filter(r => !r.ok)
  console.log(`\n通过 ${results.length - failed.length} / ${results.length}`)
  if (failed.length) failed.forEach(f => console.log('  失败: ' + f.name))
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
