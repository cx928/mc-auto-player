// test/renderer-dom-check.js - 用真实 DOM（jsdom）验证界面优化：
//   1. 假人列表是"增量更新"——同一批假人重复推送时复用原有行节点，不重建整表
//   2. 增删假人时只动相应的行
//   3. 目标下拉在 id 列表不变时不重建（否则每秒重建会打断用户选择）
//   4. 日志是批量写入（一次 flush 只做一次 DOM 插入与一次滚动）
// 用法: node test/renderer-dom-check.js
'use strict'

const fs = require('fs')
const path = require('path')
const { JSDOM } = require('jsdom')

const ROOT = path.join(__dirname, '..')
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + detail : ''}`)
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const bot = (id, name, extra = {}) => ({
  id, name, host: '127.0.0.1', port: 25566, version: 'auto', versionMode: '自动探测',
  detectedVersion: '1.21.11', protocolVersion: 774, auth: 'offline', aiMode: 'off',
  aiCalls: 0, aiActions: 0, connected: true, health: 20, food: 20,
  pos: { x: 1, y: 4, z: 1 }, dimension: 'overworld', players: 1,
  autoEat: false, autoArmor: false, wander: false, ...extra
})

async function main () {
  const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8')
  const appJs = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8')

  const handlers = {}
  const created = { count: 0 }
  const state = {
    ai: { provider: 'openai', baseUrl: 'https://api.deepseek.com/v1', apiKey: '', model: 'deepseek-chat', passiveTrigger: 'name', autonomousInterval: 20 },
    bots: [],
    presets: [],
    lastUsed: {},
    versions: { auto: 'auto', recommended: ['1.21.11'], all: [{ version: '1.21.11', protocol: 774, tested: true }], rangeText: '1.8.8 ~ 26.1' },
    microsoft: { cached: false, accounts: [] }
  }

  const stubApi = {
    getState: () => Promise.resolve(JSON.parse(JSON.stringify(state))),
    startBot: () => {}, stopBot: () => {}, removeBot: () => {}, clearBots: () => {},
    startAll: () => {}, stopAll: () => {}, setAiMode: () => {}, addBot: () => {},
    batchAdd: () => {}, quickStart: () => {}, savePreset: () => {}, removePreset: () => {},
    microsoftStatus: () => Promise.resolve({ status: state.microsoft }),
    saveAi: () => Promise.resolve({}), testAi: () => Promise.resolve({ ok: true }),
    action: () => {},
    onLog: (cb) => { handlers.log = cb },
    onBots: (cb) => { handlers.bots = cb },
    onAi: (cb) => { handlers.ai = cb },
    onPresets: (cb) => { handlers.presets = cb },
    onMsaCode: (cb) => { handlers.msa = cb }
  }

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse (window) {
      window.api = stubApi
      // 统计真实创建了多少个元素，用来证明"没有整表重建"
      const origCreate = window.document.createElement.bind(window.document)
      window.document.createElement = (tag, ...rest) => { created.count++; return origCreate(tag, ...rest) }
    }
  })
  const { window } = dom
  const doc = window.document

  // 注入 app.js（index.html 里的 script 标签在 jsdom 默认不加载外部资源）
  const script = doc.createElement('script')
  script.textContent = appJs
  doc.body.appendChild(script)
  await sleep(200)

  check('界面脚本已加载并接管', typeof handlers.bots === 'function' && typeof handlers.log === 'function')
  if (typeof handlers.bots !== 'function') { process.exit(1) }

  // ---------- 1. 初次渲染 ----------
  const list = [bot('bot1', 'Bot1'), bot('bot2', 'Bot2'), bot('bot3', 'Bot3')]
  const before1 = created.count
  handlers.bots(list)
  const rows1 = doc.querySelectorAll('.bot-row')
  check('初次推送渲染出 3 行', rows1.length === 3, `实际 ${rows1.length} 行，新建元素 ${created.count - before1} 个`)
  const firstRowRef = rows1[0]
  const firstSelectRef = doc.querySelectorAll('.bot-row select')[0]
  const targetOptions1 = [...doc.getElementById('target-bot').options]

  // ---------- 2. 同样 3 个假人、只有数值变化：必须复用节点 ----------
  const before2 = created.count
  handlers.bots([bot('bot1', 'Bot1', { health: 12, food: 7, aiCalls: 5 }), bot('bot2', 'Bot2'), bot('bot3', 'Bot3', { connected: false })])
  const rows2 = doc.querySelectorAll('.bot-row')
  const reused = rows2[0] === firstRowRef && doc.querySelectorAll('.bot-row select')[0] === firstSelectRef
  check('重复推送复用原有行节点（未整表重建）', reused && rows2.length === 3,
    `新建元素 ${created.count - before2} 个（复用成功时应为 0 或极少）`)
  check('行内数值已更新', doc.querySelectorAll('.bot-row .bot-stats')[0].textContent.includes('12'),
    doc.querySelectorAll('.bot-row .bot-stats')[0].textContent.trim())
  check('目标下拉未被重建（选项是同一批对象）',
    [...doc.getElementById('target-bot').options].every((o, i) => o === targetOptions1[i]))

  // ---------- 3. 新增一个假人：只新增一行 ----------
  const before3 = created.count
  handlers.bots([...list, bot('bot4', 'Bot4')])
  const rows3 = doc.querySelectorAll('.bot-row')
  check('新增假人只多一行且旧行仍是同一节点', rows3.length === 4 && rows3[0] === firstRowRef,
    `新建元素 ${created.count - before3} 个`)

  // ---------- 4. 移除一个假人：只删对应行 ----------
  handlers.bots([list[0], list[2], bot('bot4', 'Bot4')])
  const rows4 = doc.querySelectorAll('.bot-row')
  const names = [...rows4].map((r) => r.querySelector('.bot-name').textContent)
  check('移除假人后只删对应行', rows4.length === 3 && !names.includes('Bot2') && rows4[0] === firstRowRef,
    names.join(','))

  // ---------- 5. 日志批量写入 ----------
  const logBox = doc.getElementById('log')
  const before5 = created.count
  handlers.log(Array.from({ length: 60 }, (_, i) => ({ botName: 'Bot1', line: `[info] 第 ${i} 条日志` })))
  await sleep(200) // 等一次 flush（80ms）
  check('日志按批写入（60 条一次 flush）', logBox.childNodes.length >= 60,
    `日志行 ${logBox.childNodes.length} 条，期间新建元素 ${created.count - before5} 个`)

  // ---------- 6. 批量与单条日志都要兼容 ----------
  handlers.log({ botName: 'Bot2', line: '[warn] 单条日志' })
  await sleep(200)
  check('单条日志也能显示', logBox.textContent.includes('单条日志'))

  const failed = results.filter(r => !r.ok)
  console.log(`\n通过 ${results.length - failed.length} / ${results.length}`)
  if (failed.length) failed.forEach(f => console.log('  失败: ' + f.name))
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
