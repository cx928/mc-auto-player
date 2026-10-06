// test/cli-check.js - 验证命令行入口 cli.js 能正常连接、发言、查询状态
// 用法：node test/cli-check.js   （需本地测试服在 127.0.0.1:25566）
'use strict'

const { spawn } = require('child_process')
const path = require('path')

const HOST = process.env.TEST_HOST || '127.0.0.1'
const PORT = process.env.TEST_PORT || '25566'

const child = spawn(process.execPath, [
  'cli.js', '--host', HOST, '--port', PORT, '--user', 'CliBot', '--version', '1.21.11'
], { cwd: path.join(__dirname, '..'), stdio: ['pipe', 'pipe', 'pipe'] })

let out = ''
child.stdout.on('data', (d) => { out += d.toString(); process.stdout.write(d) })
child.stderr.on('data', (d) => process.stderr.write(d))

setTimeout(() => child.stdin.write('你好，我是命令行机器人\n'), 8000)
setTimeout(() => child.stdin.write('/status\n'), 11000)
setTimeout(() => {
  child.stdin.write('/quit\n')
}, 14000)

setTimeout(() => {
  const checks = [
    ['CLI 打印了使用提示', out.includes('命令行模式')],
    ['CLI 连接并登录成功', out.includes('登录成功')],
    ['CLI 已生成到世界', out.includes('已生成到世界中')],
    ['CLI 能发言', out.includes('你好，我是命令行机器人')],
    ['CLI 能查询状态', out.includes('"connected": true')]
  ]
  console.log('\n=========== CLI 检查汇总 ===========')
  checks.forEach(([n, ok]) => console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}`))
  const failed = checks.filter(([, ok]) => !ok).length
  console.log(`通过 ${checks.length - failed} / ${checks.length}`)
  child.kill()
  process.exit(failed ? 1 : 0)
}, 17000)
