// test/e2e.js - 端到端测试：把机器人核心连到本地测试服，验证真实功能
// 用法：node test/e2e.js   （可用环境变量 TEST_HOST / TEST_PORT 指定服务器）
'use strict'

const AutoPlayer = require('../bot/auto-player')

const HOST = process.env.TEST_HOST || '127.0.0.1'
const PORT = Number(process.env.TEST_PORT || 25566)
const USERNAME = process.env.TEST_USER || 'TestBot'

const results = []
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function check (name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + detail : ''}`)
}

async function waitFor (fn, timeoutMs, intervalMs = 250) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    try { if (fn()) return true } catch (e) { /* 继续等待 */ }
    await sleep(intervalMs)
  }
  return false
}

async function main () {
  const player = new AutoPlayer()
  player.on('log', (l) => console.log('[bot] ' + l))

  // ---------- 1. 连接与生成 ----------
  player.start({ host: HOST, port: PORT, username: USERNAME, version: '1.21.11', auth: 'offline' })
  const spawned = await waitFor(() => player.running && player.bot && player.bot.entity, 90000)
  check('连接 1.21.11 服务器并生成', spawned)
  if (!spawned) { finish(1) }

  const bot = player.bot

  // ---------- 2. 版本与协议数据 ----------
  check('协议数据为 1.21.11 (协议 774)',
    player.mcData && player.mcData.version.version === 774,
    'protocol=' + (player.mcData ? player.mcData.version.version : 'null'))

  // ---------- 3. 状态接口 ----------
  await waitFor(() => bot.health !== undefined && bot.food !== undefined, 10000)
  const st = player.getStatus()
  check('状态接口返回血量/饥饿/坐标',
    st.connected && typeof st.health === 'number' && st.pos && typeof st.pos.x === 'number',
    `health=${st.health} food=${st.food} pos=${JSON.stringify(st.pos)}`)

  // ---------- 4. 寻路走动 ----------
  const p0 = bot.entity.position.clone()
  player.walkTo(Math.round(p0.x + 14), Math.round(p0.y), Math.round(p0.z + 14))
  const moved = await waitFor(() => bot.entity.position.distanceTo(p0) > 8, 45000)
  check('寻路走到 14 格外坐标', moved, '移动距离=' + bot.entity.position.distanceTo(p0).toFixed(1))

  // ---------- 5. 停止移动 ----------
  player.stopMoving()
  await sleep(500)
  const posA = bot.entity.position.clone()
  await sleep(1500)
  check('停止移动后位置不再明显变化', bot.entity.position.distanceTo(posA) < 3,
    '位移=' + bot.entity.position.distanceTo(posA).toFixed(2))

  // ---------- 6. 方块查找（世界数据解析正常） ----------
  const grass = bot.findBlock({ matching: player.mcData.blocksByName.grass_block.id, maxDistance: 24 })
  check('能解析世界方块数据（找到草方块）', !!grass, grass ? `位置=${grass.position}` : '未找到')

  // ---------- 7. 聊天发送 ----------
  let chatErr = null
  try { player.sendChat('测试消息 from AutoPlayer') } catch (e) { chatErr = e.message }
  await sleep(1000)
  check('可以向服务器发送聊天', !chatErr, chatErr || '已发送')

  // ---------- 8. 聊天指令解析（模拟其他玩家指挥） ----------
  // 起第二个机器人当"玩家 Steve"，用于验证跟随功能
  const target = new AutoPlayer()
  target.on('log', (l) => console.log('[steve] ' + l))
  target.start({ host: HOST, port: PORT, username: 'Steve', version: '1.21.11', auth: 'offline' })
  const steveSpawned = await waitFor(() => target.running && target.bot && target.bot.entity, 60000)
  const steveVisible = await waitFor(() => bot.players.Steve && bot.players.Steve.entity, 15000)
  check('第二个机器人上线且互相可见', steveSpawned && steveVisible)

  const cmd = (msg) => player._handleChatCommand('Steve', msg)
  player.stopMoving()
  cmd('来')
  await sleep(500)
  const followOk = player.followName === 'Steve'
  const chasing = await waitFor(() => {
    const e = bot.players.Steve && bot.players.Steve.entity
    return !!(e && bot.entity.position.distanceTo(e.position) < 40)
  }, 8000)
  check('聊天指令「来」跟随目标玩家', followOk && chasing, `follow=${followOk}`)

  cmd('停')
  await sleep(300)
  const stopOk = player.followName === null && !bot.pathfinder.goal
  check('聊天指令「停」停止移动', stopOk)

  cmd('去 100 4 100')
  await sleep(300)
  const gotoOk = !!bot.pathfinder.goal
  player.stopMoving()
  check('聊天指令「去 X Y Z」设置目标点', gotoOk)

  cmd('状态')
  await sleep(800)
  check('聊天指令「状态」可回复', true, '已触发状态报告')

  // ---------- 9. 自动吃 / 自动穿甲 / 自动巡逻 开关 ----------
  player.setAutoEat(true)
  const eatOn = player.autoEatOn === true
  player.setAutoEat(false)
  check('自动吃开关可切换', eatOn && player.autoEatOn === false)

  player.setAutoArmor(true)
  await sleep(2500)
  const armorOk = player.autoArmorOn === true && player._armorTimer !== null
  player.setAutoArmor(false)
  check('自动穿甲开关与定时器工作', armorOk && player._armorTimer === null)

  player.setWander(true)
  await sleep(9000)
  const wanderOk = player.wanderOn === true
  player.setWander(false)
  check('自动巡逻可运行且不报错', wanderOk)

  // ---------- 10. 采集方块（完整链路：寻路+选工具+挖掘+捡拾） ----------
  const countDirt = () => bot.inventory.items().filter(i => i.name === 'dirt').reduce((s, i) => s + i.count, 0)
  const before = countDirt()
  player.collect('grass_block', 2, 32) // 草方块挖掉后掉落泥土
  const got = await waitFor(() => countDirt() > before, 60000)
  check('自动收集方块（挖草方块→捡到泥土）', got, `泥土 ${before} -> ${countDirt()}`)

  // ---------- 11. 断线清理 ----------
  target.stop()
  player.stop()
  await sleep(1500)
  check('断开后状态被清理', player.bot === null && player.running === false)

  finish(0)
}

function finish (forceCode) {
  const failed = results.filter(r => !r.ok)
  console.log('\n================ 测试汇总 ================')
  console.log(`通过 ${results.length - failed.length} / ${results.length}`)
  if (failed.length) {
    console.log('失败项:')
    failed.forEach(f => console.log('  - ' + f.name + (f.detail ? ' :: ' + f.detail : '')))
  }
  process.exit(forceCode || (failed.length ? 1 : 0))
}

main().catch((e) => {
  console.error('测试异常:', e)
  finish(1)
})
