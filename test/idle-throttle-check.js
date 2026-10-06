// test/idle-throttle-check.js - 空闲省电机制的功能与效果验证
//   1. 空闲的假人应当被暂停本地物理（physicsEnabled=false）
//   2. 一旦下指令走路，物理必须立刻恢复并且真的能走动
//   3. 采集/巡逻等动作同样要能唤醒
// 需要本地测试服在 127.0.0.1:25566
'use strict'

const { BotManager } = require('../bot/manager')

const MC_HOST = process.env.TEST_HOST || '127.0.0.1'
const MC_PORT = Number(process.env.TEST_PORT || 25566)

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + detail : ''}`)
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
async function waitFor (fn, timeoutMs, step = 300) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    try { if (await fn()) return true } catch (_) {}
    await sleep(step)
  }
  return false
}

function idleReasons (p) {
  const b = p.bot
  if (!b || !b.entity) return ['尚未生成']
  const r = []
  if (p.collecting) r.push('collecting')
  if (p.eating) r.push('eating')
  if (p.wanderOn) r.push('wanderOn')
  if (b.vehicle) r.push('vehicle')
  if (b.pathfinder && b.pathfinder.goal) r.push('有寻路目标')
  if (b.pathfinder && b.pathfinder.isMoving && b.pathfinder.isMoving()) r.push('isMoving')
  if (!b.entity.onGround) r.push('不在 ground')
  const v = b.entity.velocity
  if (v && (Math.abs(v.x) > 0.02 || Math.abs(v.z) > 0.02)) r.push(`速度(${v.x.toFixed(3)},${v.z.toFixed(3)})`)
  return r
}

async function main () {
  const mgr = new BotManager({ persist: false })
  mgr.on('log', (e) => { if (/省电|连接失败|error/.test(e.line)) console.log('   ' + e.line) })

  const ids = mgr.batchAdd({ count: 2, namePrefix: 'IdleBot', host: MC_HOST, port: MC_PORT, version: 'auto', auth: 'offline' })
  mgr.startAll()
  const up = await waitFor(() => ids.every((id) => { const b = mgr.bots.get(id); return b.player.bot && b.player.bot.entity }), 60000)
  check('两个假人已上线', up)
  if (!up) { mgr.shutdown(); process.exit(1) }

  const p1 = mgr.bots.get(ids[0]).player
  const p2 = mgr.bots.get(ids[1]).player

  console.log('   等待空闲省电生效（约 2 秒）...')
  const throttled = await waitFor(() => p1.bot.physicsEnabled === false && p2.bot.physicsEnabled === false, 12000)
  const reasons = ids.map((id) => idleReasons(mgr.bots.get(id).player).join('+') || '（无阻塞原因）')
  check('空闲时本地物理被暂停', throttled,
    `物理开关 p1=${p1.bot.physicsEnabled} p2=${p2.bot.physicsEnabled}；未判定为空闲的原因: ${reasons.join(' / ')}`)

  // 位置在暂停期间不应漂移
  const posBefore = p1.bot.entity.position.clone()
  await sleep(3000)
  const drift = p1.bot.entity.position.distanceTo(posBefore)
  check('暂停物理期间位置不漂移', drift < 0.5, `漂移 ${drift.toFixed(3)} 格`)

  // 下指令走路：必须立刻恢复物理并真的移动
  const beforeWalk = p1.bot.entity.position.clone()
  p1.walkTo(Math.round(beforeWalk.x + 12), Math.round(beforeWalk.y), Math.round(beforeWalk.z + 12))
  const wokeUp = await waitFor(() => p1.bot.physicsEnabled === true, 3000)
  check('收到移动指令后立刻恢复物理', wokeUp, `physicsEnabled=${p1.bot.physicsEnabled}`)
  const moved = await waitFor(() => p1.bot.entity.position.distanceTo(beforeWalk) > 6, 40000)
  check('恢复后真的能正常走动', moved,
    `移动 ${p1.bot.entity.position.distanceTo(beforeWalk).toFixed(1)} 格`)

  // 停下后应重新进入省电
  p1.stopMoving()
  const reThrottled = await waitFor(() => p1.bot.physicsEnabled === false, 15000)
  check('停下后重新进入省电', reThrottled)

  // 巡逻（wanderOn）期间不应被省电，否则不会动
  p1.setWander(true)
  await sleep(1500)
  check('巡逻期间不暂停物理', p1.bot.physicsEnabled === true)
  p1.setWander(false)

  // 关掉省电开关应当完全不介入
  const p3 = mgr.bots.get(ids[1]).player
  p3.idleThrottle = false
  p3._wake()
  await sleep(4000)
  check('可关闭省电（idleThrottle=false 时不介入）', p3.bot.physicsEnabled === true)

  mgr.shutdown()
  const failed = results.filter(r => !r.ok)
  console.log(`\n通过 ${results.length - failed.length} / ${results.length}`)
  if (failed.length) failed.forEach(f => console.log('  失败: ' + f.name))
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
