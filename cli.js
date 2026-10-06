// cli.js - 命令行模式（不依赖 Electron），支持多假人与 AI
// 用法示例:
//   mc-auto-player.exe --host 1.2.3.4 --port 25565 --user Bot --version 1.21.11
//   mc-auto-player.exe --host 1.2.3.4 --user Bot --count 5            # 一次开 5 个假人 Bot1..Bot5
//   mc-auto-player.exe --host 1.2.3.4 --user Bot --ai-mode passive --ai-key sk-xxx
'use strict'

const readline = require('readline')
const { BotManager } = require('./bot/manager')
const { splitHostPort } = require('./bot/util')

function parseArgs (argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const k = a.slice(2)
      const v = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : 'true'
      out[k] = v
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
// 容错：支持把端口直接写在地址里（--host 1.2.3.4:43042），这里统一解析成 host + port
const { host: HOST, port: PORT } = splitHostPort(args.host, args.port)
const VERSION = args.version || '1.21.11'
const AUTH = args.auth === 'microsoft' ? 'microsoft' : 'offline'
const BASE_NAME = args.user || args.name || 'AutoPlayer'
const COUNT = Math.min(Math.max(Number(args.count) || 1, 1), 20)
const AI_MODE = ['passive', 'autonomous'].includes(args['ai-mode']) ? args['ai-mode'] : 'off'

const manager = new BotManager({ persist: false })

manager.on('log', (e) => console.log(`[${e.botName}] ${e.line}`))
manager.on('msa-code', (e) => {
  console.log(`\n>>> 正版登录（${e.botName}）：打开 ${e.code.verification_uri || 'https://microsoft.com/link'} 输入代码 ${e.code.user_code}\n`)
})

// AI 设置（命令行里给了才生效）
if (args['ai-key'] || args['ai-base-url'] || args['ai-model'] || AI_MODE !== 'off') {
  manager.updateAiSettings({
    provider: args['ai-provider'] === 'ollama' ? 'ollama' : 'openai',
    baseUrl: args['ai-base-url'] || undefined,
    apiKey: args['ai-key'] || '',
    model: args['ai-model'] || undefined,
    autonomousInterval: Number(args['ai-interval']) || 20
  })
}

console.log('==================================================')
console.log(' MC 自动玩家 - 命令行模式' + (COUNT > 1 ? `（${COUNT} 个假人）` : ''))
console.log(` 目标服务器: ${HOST}:${PORT}  版本: ${VERSION}  认证: ${AUTH}`)
console.log('--------------------------------------------------')
console.log(' 假人管理: /bots  /use <名字>  /start [名字]  /stop [名字]')
console.log('           /startall  /stopall  /ai <off|passive|autonomous> [名字]')
console.log(' 机器人操作: /walk x y z  /follow 玩家  /stopmove  /collect 方块 [数量]')
console.log('           /dig x y z  /attack  /give 物品 [数量]  /status')
console.log('           /eat on|off  /armor on|off  /wander on|off')
console.log(' 直接输入其它文字 = 以当前假人身份在游戏里发言；/quit 退出')
console.log('==================================================')

// 创建并上线
if (COUNT > 1) {
  manager.batchAdd({ count: COUNT, namePrefix: BASE_NAME, startIndex: 1, host: HOST, port: PORT, version: VERSION, auth: AUTH, aiMode: AI_MODE })
} else {
  manager.addBot({ name: BASE_NAME, host: HOST, port: PORT, version: VERSION, auth: AUTH, aiMode: AI_MODE })
}
manager.startAll()

let targetId = manager.getBots()[0] ? manager.getBots()[0].id : null
const botOf = (id) => manager.bots.get(id)
const named = (key) => {
  if (!key) return botOf(targetId)
  const list = [...manager.bots.values()]
  return list.find((b) => b.config.name === key) || list.find((b) => b.id === key) || null
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
rl.on('line', (line) => {
  const s = line.trim()
  if (!s) return
  if (!s.startsWith('/')) {
    const b = botOf(targetId)
    if (b) b.player.sendChat(s)
    return
  }
  const parts = s.slice(1).split(/\s+/)
  const cmd = parts[0]
  const rest = parts.slice(1)
  switch (cmd) {
    case 'bots': {
      console.log('--- 假人列表 ---')
      for (const x of manager.getBots()) {
        console.log(`  ${x.id}  ${x.name}  ${x.connected ? '在线' : '离线'}  AI=${x.aiMode}  ` +
          (x.connected ? `❤${x.health} 🍗${x.food} 📍${x.pos ? `${x.pos.x},${x.pos.y},${x.pos.z}` : '-'} 调用${x.aiCalls}` : ''))
      }
      break
    }
    case 'use': {
      const t = named(rest[0])
      if (t) { targetId = t.id; console.log('当前假人: ' + t.config.name) } else console.log('找不到: ' + rest[0])
      break
    }
    case 'start': case 'stop': {
      const t = named(rest[0]) || botOf(targetId)
      if (!t) break
      if (cmd === 'start') manager.startBot(t.id); else manager.stopBot(t.id)
      break
    }
    case 'startall': console.log('已启动 ' + manager.startAll() + ' 个假人'); break
    case 'stopall': manager.stopAll(); console.log('已全部下线'); break
    case 'ai': {
      const t = named(rest[1]) || botOf(targetId)
      if (!t) break
      if (!['off', 'passive', 'autonomous'].includes(rest[0])) { console.log('用法: /ai off|passive|autonomous [名字]'); break }
      manager.setAiMode(t.id, rest[0])
      break
    }
    case 'status': {
      const t = botOf(targetId)
      if (t) console.log(JSON.stringify(t.player.getStatus(), null, 2))
      break
    }
    case 'walk': manager.action(targetId, 'walk', { x: Number(rest[0]), y: Number(rest[1]), z: Number(rest[2]) }); break
    case 'follow': manager.action(targetId, 'follow', { name: rest[0] }); break
    case 'stopmove': manager.action(targetId, 'stopmove', {}); break
    case 'collect': manager.action(targetId, 'collect', { name: rest[0], count: Number(rest[1]) || 1 }); break
    case 'dig': manager.action(targetId, 'dig', { x: Number(rest[0]), y: Number(rest[1]), z: Number(rest[2]) }); break
    case 'attack': manager.action(targetId, 'attack', {}); break
    case 'give': manager.action(targetId, 'give', { name: rest[0], count: Number(rest[1]) || 1 }); break
    case 'eat': manager.action(targetId, 'autoeat', { on: rest[0] !== 'off' }); break
    case 'armor': manager.action(targetId, 'autoarmor', { on: rest[0] !== 'off' }); break
    case 'wander': manager.action(targetId, 'wander', { on: rest[0] !== 'off' }); break
    case 'quit': case 'exit':
      manager.shutdown()
      rl.close()
      setTimeout(() => process.exit(0), 400)
      break
    default:
      console.log('未知指令: ' + cmd + '（输入 /bots 查看假人，直接输入文字为发言）')
  }
})

process.on('SIGINT', () => {
  console.log('\n正在退出...')
  manager.shutdown()
  process.exit(0)
})
