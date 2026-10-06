'use strict'
/*
 * Live-client probe for PrankCraft.
 *
 * Connects a real (mineflayer) client to a throwaway server and reports what that client
 * actually observes while the staff-test path fires pranks at it. A log-only smoke test cannot
 * prove the things this exists to prove:
 *
 *   1. primed-TNT entities really are visible to the target's client (peakTnt > 0);
 *   2. nothing hurts or moves the target (health sampled continuously, position before/after);
 *   3. the client is never kicked or disconnected by an effect;
 *   4. what the target actually reads in chat, which is how the fake-chat and fake-death
 *      exclusion rules get verified from the receiving end rather than from the sender's log.
 *
 * The harness asks for labelled snapshots by saying "@sample <label>" in chat.
 *
 * Usage: node live-client-probe.js <host> <port> <version> <name> <msToRun> <outFile>
 */
const mineflayer = require('mineflayer')
const fs = require('fs')

const [host, portRaw, version, name, msRaw, outFile] = process.argv.slice(2)
const port = Number(portRaw) || 25565
const msToRun = Number(msRaw) || 90000

const report = {
  connected: false,
  name,
  version,
  connectError: null,
  pre: null,
  post: null,
  samples: {},
  minHealth: null,
  maxHealth: null,
  healthDrops: [],
  peakTnt: 0,
  tntValuesSeen: [],
  chat: [],
  kicked: false,
  endReason: 'timeout'
}

function snapshot (bot) {
  if (!bot.entity) return null
  return {
    at: Date.now(),
    health: typeof bot.health === 'number' ? bot.health : null,
    food: bot.food,
    x: Number(bot.entity.position.x.toFixed(3)),
    y: Number(bot.entity.position.y.toFixed(3)),
    z: Number(bot.entity.position.z.toFixed(3)),
    entities: Object.keys(bot.entities).length
  }
}

function primedTnt (bot) {
  return Object.values(bot.entities).filter(e =>
    e && (e.name === 'tnt' || e.displayName === 'Primed TNT' || e.entityType === 'tnt'))
}

function writeReport () {
  try {
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2))
  } catch (err) {
    console.error('[probe] could not write report: ' + err.message)
  }
}

function finish (bot, reason) {
  report.post = snapshot(bot)
  report.endReason = reason
  writeReport()
  try { if (bot && bot.quit) bot.quit('probe complete') } catch (_) { /* already gone */ }
  process.exit(0)
}

const bot = mineflayer.createBot({ host, port, username: name, version, auth: 'offline' })

bot.once('spawn', () => {
  report.connected = true
  report.pre = snapshot(bot)
  console.log(`[probe] spawned as ${bot.username} at ${JSON.stringify(report.pre)}`)
  bot.chat('probe-ready')
})

bot.on('chat', (username, message) => {
  report.chat.push({ username, message })
  if (message.startsWith('@sample')) {
    const label = message.split(/\s+/)[1] || `sample-${Object.keys(report.samples).length}`
    report.samples[label] = snapshot(bot)
    console.log(`[probe] sample ${label}: ${JSON.stringify(report.samples[label])}`)
  }
  console.log(`[probe] chat <${username}> ${message}`)
})

bot.on('kicked', (reason) => {
  report.kicked = true
  report.endReason = 'kicked: ' + JSON.stringify(reason)
  console.log('[probe] kicked: ' + JSON.stringify(reason))
  writeReport()
  process.exit(0)
})

bot.on('error', (err) => {
  report.connectError = String(err && err.message ? err.message : err)
  console.log('[probe] error: ' + report.connectError)
})

bot.on('end', (reason) => {
  if (!report.post) report.post = snapshot(bot)
  if (!report.endReason || report.endReason === 'timeout') report.endReason = 'end: ' + reason
  writeReport()
  process.exit(0)
})

/*
 * Sample continuously. The TNT is only on screen for about two seconds, so a slow poll misses
 * it entirely; and health has to be sampled rather than read once, because a single hit between
 * the before/after snapshots would otherwise be invisible - and "did the prank hurt anybody" is
 * the most important question this probe answers.
 */
const sampler = setInterval(() => {
  if (!bot.entity) return

  const health = typeof bot.health === 'number' ? bot.health : null
  if (health !== null) {
    if (report.minHealth === null || health < report.minHealth) {
      report.minHealth = health
      if (health < 20) {
        report.healthDrops.push({ health, at: Date.now() })
        console.log(`[probe] health ${health}`)
      }
    }
    if (report.maxHealth === null || health > report.maxHealth) report.maxHealth = health
  }

  const tnt = primedTnt(bot)
  if (tnt.length > report.peakTnt) {
    report.peakTnt = tnt.length
    console.log(`[probe] peak primed TNT visible: ${tnt.length}`)
  }
  if (tnt.length > 0) {
    const fuse = tnt.map(e => e.metadata && e.metadata[6]).filter(v => typeof v === 'number')
    report.tntValuesSeen.push({ count: tnt.length, fuse, at: Date.now() })
  }
}, 100)

setTimeout(() => {
  clearInterval(sampler)
  finish(bot, 'completed')
}, msToRun)
