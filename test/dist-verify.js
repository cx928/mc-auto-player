// test/dist-verify.js - 分发产物总校验：核对 6 个 zip 的结构，并实际运行 Windows 版做端到端验证
// 用法: node test/dist-verify.js
'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFileSync, spawn } = require('child_process')

const PROJ = path.resolve(__dirname, '..')
const DIST = path.join(PROJ, 'dist')
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + detail : ''}`)
}

// 注意：bsdtar 在 Windows 上输出的中文文件名是 GBK 编码，脚本里按 UTF-8 读会变乱码，
// 所以中文文件名只按扩展名判断（.txt），不比对具体名字
const SPECS = [
  { zip: 'mc-auto-player-cli-win-x64.zip', root: 'mc-auto-player-cli-win-x64', must: ['mc-auto-player.exe'], dirs: ['app', 'node_modules'], app: ['cli.js', 'bot/auto-player.js'], txt: true },
  { zip: 'mc-auto-player-cli-linux-x64.zip', root: 'mc-auto-player-cli-linux-x64', must: ['mc-auto-player', 'start.sh'], dirs: ['app', 'node_modules'], app: ['cli.js', 'bot/auto-player.js'], txt: true },
  { zip: 'mc-auto-player-webui-win-x64.zip', root: 'mc-auto-player-webui-win-x64', must: ['mc-auto-player.exe'], dirs: ['app', 'node_modules'], app: ['web/server.js', 'renderer/index.html', 'bot/auto-player.js'], txt: true },
  { zip: 'mc-auto-player-webui-linux-x64.zip', root: 'mc-auto-player-webui-linux-x64', must: ['mc-auto-player', 'start.sh'], dirs: ['app', 'node_modules'], app: ['web/server.js', 'renderer/index.html', 'bot/auto-player.js'], txt: true },
  { zip: 'mc-auto-player-electron-win-x64.zip', root: 'mc-auto-player-electron-win-x64', must: [], anyExt: ['.exe'], txt: true },
  { zip: 'mc-auto-player-electron-linux-x64.zip', root: 'mc-auto-player-electron-linux-x64', must: [], anyExt: ['.tar.gz'], txt: true }
]

function listZip (zip) {
  return execFileSync('tar', ['-tf', zip], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean)
}

async function main () {
  console.log('--- 1. 逐个核对压缩包结构 ---')
  for (const s of SPECS) {
    const zip = path.join(DIST, s.zip)
    if (!fs.existsSync(zip)) { check(`${s.zip} 存在`, false); continue }
    const mb = (fs.statSync(zip).size / 1048576).toFixed(0)
    const entries = listZip(zip)
    const has = (rel) => entries.some(e => e.replace(/\\/g, '/').endsWith(`/${rel}`) || e.replace(/\\/g, '/').endsWith(`/${rel}/`))
    const missing = s.must.filter(f => !has(f))
    const missingDirs = (s.dirs || []).filter(f => !has(f))
    const missingApp = (s.app || []).filter(f => !has(f))
    const extOk = !s.anyExt || s.anyExt.some(ext => entries.some(e => e.endsWith(ext)))
    const txtOk = !s.txt || entries.some(e => e.toLowerCase().endsWith('.txt'))
    const ok = !missing.length && !missingDirs.length && !missingApp.length && extOk && txtOk
    check(`${s.zip} (${mb} MB) 结构完整`, ok,
      ok ? `共 ${entries.length} 项` : `缺: ${[...missing, ...missingDirs, ...missingApp].join(', ')}${extOk ? '' : ' 无可执行产物'}${txtOk ? '' : ' 无使用说明'}`)
  }

  console.log('\n--- 2. 从 zip 解压后实际运行 Windows 命令行版 ---')
  const tmp = path.join(os.tmpdir(), 'mc-dist-verify')
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.mkdirSync(tmp, { recursive: true })
  execFileSync('tar', ['-xf', path.join(DIST, 'mc-auto-player-cli-win-x64.zip'), '-C', tmp])
  const exe = path.join(tmp, 'mc-auto-player-cli-win-x64', 'mc-auto-player.exe')
  check('从 zip 解压出的 exe 存在', fs.existsSync(exe))

  const child = spawn(exe, ['--host', process.env.TEST_HOST || '127.0.0.1', '--port', process.env.TEST_PORT || '25566',
    '--user', 'ZipBot', '--version', '1.21.11'], { stdio: ['pipe', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (d) => { out += d.toString() })
  child.stderr.on('data', (d) => { out += d.toString() })
  await sleep(9000)
  check('解压后的程序能连上 1.21.11 服务器', out.includes('登录成功'))
  child.stdin.write('/status\n')
  await sleep(2500)
  check('解压后的程序状态查询正常', out.includes('"connected": true'))
  child.stdin.write('/quit\n')
  await sleep(1500)
  try { child.kill() } catch (_) {}
  if (!out.includes('登录成功')) console.log('程序输出:\n' + out.slice(-600))

  fs.rmSync(tmp, { recursive: true, force: true })

  const failed = results.filter(r => !r.ok)
  console.log(`\n========== 分发产物校验汇总 ==========`)
  console.log(`通过 ${results.length - failed.length} / ${results.length}`)
  if (failed.length) failed.forEach(f => console.log('  失败: ' + f.name))
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
