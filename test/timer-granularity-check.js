// test/timer-granularity-check.js - 验证"事件循环延迟 16ms"是不是 Windows 定时器粒度的测量假象
'use strict'

const { monitorEventLoopDelay } = require('perf_hooks')

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function measure (label, busyMs) {
  const h = monitorEventLoopDelay({ resolution: 1 })
  h.enable()
  const t0 = Date.now()
  const end = t0 + 4000
  while (Date.now() < end) {
    await sleep(busyMs)
  }
  h.disable()
  console.log(`  ${label.padEnd(28)} mean=${(h.mean / 1e6).toFixed(2)} ms  p50=${(h.percentile(50) / 1e6).toFixed(2)}  p99=${(h.percentile(99) / 1e6).toFixed(2)}  max=${(h.max / 1e6).toFixed(2)}`)
}

async function main () {
  console.log('本机定时器粒度与事件循环延迟实测：')
  console.log(`  平台: ${process.platform}  Node: ${process.version}`)
  await measure('空闲，每 50ms 一个定时器', 50)
  await measure('空闲，每 1000ms 一个定时器', 1000)

  // 用 setImmediate 测真实的事件循环吞吐（不受定时器粒度影响）
  const t0 = Date.now()
  let ticks = 0
  while (Date.now() - t0 < 2000) { await new Promise((r) => setImmediate(r)); ticks++ }
  console.log(`  setImmediate 吞吐: ${(ticks / 2).toFixed(0)} 次/秒（越高说明事件循环越空闲）`)
}

main().catch((e) => { console.error(e); process.exit(1) })
