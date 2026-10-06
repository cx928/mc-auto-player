// test/profile-summary.js - 解析 Node 的 .cpuprofile，按自身耗时排出热点函数
// 用法: node test/profile-summary.js <xxx.cpuprofile> [显示条数]
'use strict'

const fs = require('fs')

const file = process.argv[2]
const topN = Number(process.argv[3]) || 25
if (!file) { console.error('用法: node test/profile-summary.js <cpuprofile> [条数]'); process.exit(2) }

const prof = JSON.parse(fs.readFileSync(file, 'utf8'))
const byId = new Map(prof.nodes.map((n) => [n.id, n]))

// 汇总每个函数的自身采样数
const self = new Map()
let total = 0
for (const n of prof.nodes) {
  const hits = n.hitCount || 0
  if (!hits) continue
  total += hits
  const cf = n.callFrame || {}
  const url = (cf.url || '').replace(/^file:\/\/\//, '').replace(/\\/g, '/')
  const short = url.includes('node_modules/')
    ? url.slice(url.lastIndexOf('node_modules/') + 13).split('/').slice(0, 2).join('/')
    : (url.split('/').slice(-1)[0] || '(node)')
  const key = `${cf.functionName || '(anonymous)'}  @ ${short}:${cf.lineNumber + 1}`
  self.set(key, (self.get(key) || 0) + hits)
}

const dur = (prof.endTime - prof.startTime) / 1e6 // ms
console.log(`采样总时长 ${(dur / 1000).toFixed(1)} 秒，有效样本 ${total} 个（约 ${((prof.endTime - prof.startTime) / 1000 / Math.max(total, 1)).toFixed(2)} ms/样本）`)
console.log(`\n自身耗时 TOP ${topN}：`)
console.log('  占比     样本   函数')
for (const [k, v] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN)) {
  console.log(`  ${((v / total) * 100).toFixed(1).padStart(5)}%  ${String(v).padStart(6)}   ${k}`)
}

// 按"包"聚合，看清是哪一层在烧 CPU
const byPkg = new Map()
for (const [k, v] of self.entries()) {
  const m = /@ ([^:]+):/.exec(k)
  let pkg = m ? m[1] : '(unknown)'
  const mm = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(k)
  if (mm) pkg = mm[1]
  else if (pkg.includes('mineflayer')) pkg = 'mineflayer'
  byPkg.set(pkg, (byPkg.get(pkg) || 0) + v)
}
console.log('\n按来源聚合：')
for (const [k, v] of [...byPkg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`  ${((v / total) * 100).toFixed(1).padStart(5)}%  ${k}`)
}
