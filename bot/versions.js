// bot/versions.js - Minecraft 版本支持清单与解析
// 说明：
//   - minecraft-data 里带全部 837 个版本（含快照/预发布）的数据，其中正式版 103 个，1.12 及以后共 54 个
//   - mineflayer 自带"官方测试过的版本"清单（lib/version.js），范围是 1.8.8 → 26.1
//   - 连接时把 version 传 false，mineflayer 会自己 ping 服务器识别版本（实测 1.21.11 耗时约 1.4 秒）
'use strict'

const mcData = require('minecraft-data')

const AUTO = 'auto'

// mineflayer 官方测试清单（做成软依赖，读不到就退化）
let TESTED = []
try {
  TESTED = (require('mineflayer/lib/version').testedVersions || []).slice()
} catch (_) { /* 忽略 */ }
const NEWEST_TESTED = TESTED[TESTED.length - 1] || '26.1'
const OLDEST_TESTED = TESTED[0] || '1.8.8'
const TESTED_SET = new Set(TESTED)

// 只保留正式版（过滤 26w14a、1.21.11-pre1、-rc 之类）
const isReleaseName = (s) => /^\d+(\.\d+){0,2}$/.test(s)

function parts (s) {
  return String(s).split('.').map((x) => Number(x) || 0)
}

// 版本号比较：兼容新的年份版本号（26.1 > 1.21.11）
function compareVersion (a, b) {
  const x = parts(a)
  const y = parts(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0)
    if (d) return d > 0 ? 1 : -1
  }
  return 0
}

let cache = null

// 全部正式版，按新到旧（minecraft-data 本身即新在前）
function listVersions () {
  if (cache) return cache
  const seen = new Set()
  const list = []
  for (const v of mcData.versions.pc) {
    const name = v.minecraftVersion
    if (!name || seen.has(name) || !isReleaseName(name)) continue
    seen.add(name)
    list.push({
      version: name,
      protocol: v.version,
      tested: TESTED_SET.has(name),
      supported: compareVersion(name, OLDEST_TESTED) >= 0 && compareVersion(name, NEWEST_TESTED) <= 0
    })
  }
  cache = list
  return cache
}

// 1.12 及以后（含新的年份版本号）——用户要的范围
function listModernVersions () {
  return listVersions().filter((v) => {
    const m = /^(\d+)\.(\d+)/.exec(v.version)
    if (!m) return false
    const major = Number(m[1])
    return major >= 26 || (major === 1 && Number(m[2]) >= 12)
  })
}

// 前端下拉框用的分组清单
function versionOptions () {
  const modern = listModernVersions()
  const tested = modern.filter((v) => v.tested)
  const rest = modern.filter((v) => !v.tested)
  return {
    auto: AUTO,
    recommended: tested.map((v) => v.version),
    all: modern.map((v) => ({ version: v.version, protocol: v.protocol, tested: v.tested })),
    restCount: rest.length,
    range: { oldest: OLDEST_TESTED, newest: NEWEST_TESTED }
  }
}

// 把用户输入/配置里的版本解析成传给 mineflayer 的值
//   'auto' / '' / false / '自动' -> false（让 mineflayer 自己 ping 探测）
function resolveVersion (input) {
  const s = String(input == null ? '' : input).trim()
  if (!s || s === AUTO || s === 'false' || s === '自动' || s === '自动探测') return false
  return s
}

// 这个版本是否在官方测试范围内
function isTested (name) {
  return TESTED_SET.has(String(name))
}

// 人类可读的支持范围说明
function rangeText () {
  return `${OLDEST_TESTED} ~ ${NEWEST_TESTED}（官方测试范围），数据覆盖到 ${listVersions()[0].version}`
}

// 判断探测/指定的版本能否被支持，返回 { ok, level, message }
function checkSupport (name) {
  const n = String(name || '').trim()
  if (!n) return { ok: false, level: 'unknown', message: '未知版本' }
  const known = listVersions().some((v) => v.version === n)
  if (TESTED_SET.has(n)) return { ok: true, level: 'tested', message: `${n}（官方测试过）` }
  if (!known) return { ok: false, level: 'unknown', message: `${n}：没有这个版本的协议数据，无法连接` }
  if (compareVersion(n, OLDEST_TESTED) < 0) {
    return { ok: false, level: 'too-old', message: `${n} 太旧了，mineflayer 最旧支持 ${OLDEST_TESTED}` }
  }
  if (compareVersion(n, NEWEST_TESTED) > 0) {
    return { ok: true, level: 'untested-new', message: `${n} 比官方测试范围(${NEWEST_TESTED})更新，可能可用，需实测` }
  }
  return { ok: true, level: 'untested', message: `${n} 在支持范围内但未被官方测试` }
}

module.exports = {
  AUTO,
  TESTED,
  NEWEST_TESTED,
  OLDEST_TESTED,
  compareVersion,
  listVersions,
  listModernVersions,
  versionOptions,
  resolveVersion,
  isTested,
  rangeText,
  checkSupport
}
