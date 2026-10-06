// renderer/app.js - 界面逻辑：多假人管理、AI 设置、手动操作、日志
'use strict'

const $ = (id) => document.getElementById(id)

// 同一套界面同时支持两种运行方式：
//   Electron 版：preload 注入的 window.api（IPC）
//   WebUI  版：浏览器里没有 window.api，自动退回 HTTP + SSE
function createWebApi () {
  const listeners = { log: [], bots: [], 'msa-code': [], ai: [] }
  const es = new EventSource('/api/events')
  es.onmessage = (e) => {
    try {
      const d = JSON.parse(e.data)
      ;(listeners[d.type] || []).forEach((cb) => cb(d.payload))
    } catch (_) { /* 忽略心跳 */ }
  }
  const on = (type) => (cb) => listeners[type].push(cb)
  const post = (name, body) => fetch('/api/' + name, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  }).then((r) => r.json()).catch(() => ({ ok: false }))
  return {
    getState: () => fetch('/api/state').then((r) => r.json()).catch(() => ({ bots: [], ai: {} })),
    addBot: (cfg) => post('addBot', cfg),
    batchAdd: (cfg) => post('batchAdd', cfg),
    removeBot: (id) => post('removeBot', { id }),
    clearBots: () => post('clearBots', {}),
    startBot: (id) => post('startBot', { id }),
    stopBot: (id) => post('stopBot', { id }),
    startAll: () => post('startAll', {}),
    stopAll: () => post('stopAll', {}),
    setAiMode: (id, mode) => post('setAiMode', { id, mode }),
    saveAi: (cfg) => post('saveAi', cfg),
    testAi: () => post('testAi', {}),
    action: (id, name, args) => post('action', { id, name, args }),
    onLog: on('log'),
    onBots: on('bots'),
    onMsaCode: on('msa-code'),
    onAi: on('ai')
  }
}

const api = window.api || createWebApi()

const els = {
  host: $('host'), port: $('port'), version: $('version'), auth: $('auth'),
  namePrefix: $('namePrefix'), startIndex: $('startIndex'), count: $('count'), newAiMode: $('newAiMode'),
  btnBatch: $('btn-batch'), btnBatchStart: $('btn-batch-start'),
  btnStartAll: $('btn-start-all'), btnStopAll: $('btn-stop-all'), btnClear: $('btn-clear'),
  aiProvider: $('ai-provider'), aiBaseUrl: $('ai-baseUrl'), aiApiKey: $('ai-apiKey'), aiModel: $('ai-model'),
  aiTrigger: $('ai-trigger'), aiInterval: $('ai-interval'),
  btnAiSave: $('btn-ai-save'), btnAiTest: $('btn-ai-test'), aiStatus: $('ai-status'),
  botCount: $('bot-count'), botList: $('bot-list'),
  targetBot: $('target-bot'),
  chatInput: $('chat-input'), btnChat: $('btn-chat'),
  walkX: $('walk-x'), walkY: $('walk-y'), walkZ: $('walk-z'), btnWalk: $('btn-walk'),
  followName: $('follow-name'), btnFollow: $('btn-follow'), btnStopmove: $('btn-stopmove'),
  collectName: $('collect-name'), collectCount: $('collect-count'), btnCollect: $('btn-collect'),
  digX: $('dig-x'), digY: $('dig-y'), digZ: $('dig-z'), btnDig: $('btn-dig'), btnAttack: $('btn-attack'),
  tgEat: $('tg-eat'), tgArmor: $('tg-armor'), tgWander: $('tg-wander'),
  stateDot: $('state-dot'), stateText: $('state-text'),
  log: $('log')
}

let bots = []
let ai = {}
let targetId = null
let suppressToggle = false // 状态刷新时避免把 checkbox 的 change 当成用户操作

// ---------- 日志 ----------
const LEVELS = { error: 'l-error', warn: 'l-warn', info: 'l-info', chat: 'l-chat', server: 'l-server', debug: 'l-server' }

function appendLog (line, botName) {
  const m = /\[(\w+)\]/.exec(line)
  const cls = m && LEVELS[m[1]] ? LEVELS[m[1]] : ''
  const div = document.createElement('div')
  if (cls) div.className = cls
  div.textContent = botName ? `[${botName}] ${line}` : line
  els.log.appendChild(div)
  while (els.log.childNodes.length > 1500) els.log.removeChild(els.log.firstChild)
  els.log.scrollTop = els.log.scrollHeight
}

// ---------- 假人列表 ----------
function botRow (b) {
  const row = document.createElement('div')
  row.className = 'bot-row' + (b.connected ? ' on' : '')

  const dot = document.createElement('span')
  dot.className = 'dot ' + (b.connected ? 'on' : 'off')
  row.appendChild(dot)

  const name = document.createElement('span')
  name.className = 'bot-name'
  name.textContent = b.name
  row.appendChild(name)

  const addr = document.createElement('span')
  addr.className = 'bot-addr'
  addr.textContent = `${b.host}:${b.port} · ${b.version}`
  row.appendChild(addr)

  const stats = document.createElement('span')
  stats.className = 'bot-stats'
  stats.textContent = b.connected
    ? `❤ ${b.health}  🍗 ${b.food}  📍 ${b.pos ? `${b.pos.x},${b.pos.y},${b.pos.z}` : '-'}  👥 ${b.players}  AI调用 ${b.aiCalls}`
    : '未连接'
  row.appendChild(stats)

  const aiSel = document.createElement('select')
  aiSel.className = 'mini'
  for (const [val, label] of [['off', 'AI 关'], ['passive', 'AI 被动'], ['autonomous', 'AI 自主']]) {
    const o = document.createElement('option')
    o.value = val
    o.textContent = label
    if (b.aiMode === val) o.selected = true
    aiSel.appendChild(o)
  }
  aiSel.addEventListener('change', () => api.setAiMode(b.id, aiSel.value))
  row.appendChild(aiSel)

  const btnStart = document.createElement('button')
  btnStart.className = 'btn small'
  btnStart.textContent = '上线'
  btnStart.disabled = b.connected
  btnStart.addEventListener('click', () => api.startBot(b.id))
  row.appendChild(btnStart)

  const btnStop = document.createElement('button')
  btnStop.className = 'btn small'
  btnStop.textContent = '下线'
  btnStop.disabled = !b.connected
  btnStop.addEventListener('click', () => api.stopBot(b.id))
  row.appendChild(btnStop)

  const btnDel = document.createElement('button')
  btnDel.className = 'btn small danger'
  btnDel.textContent = '移除'
  btnDel.addEventListener('click', () => api.removeBot(b.id))
  row.appendChild(btnDel)

  return row
}

function renderBots (list) {
  bots = list || []
  els.botCount.textContent = bots.length
  els.botList.textContent = ''
  if (!bots.length) {
    const p = document.createElement('p')
    p.className = 'empty'
    p.textContent = '还没有假人，上面添加一个吧'
    els.botList.appendChild(p)
  } else {
    for (const b of bots) els.botList.appendChild(botRow(b))
  }

  // 目标假人下拉
  const prev = targetId || els.targetBot.value
  els.targetBot.textContent = ''
  for (const b of bots) {
    const o = document.createElement('option')
    o.value = b.id
    o.textContent = `${b.name}${b.connected ? '（在线）' : '（离线）'}`
    els.targetBot.appendChild(o)
  }
  if (bots.some((b) => b.id === prev)) els.targetBot.value = prev
  targetId = els.targetBot.value || (bots[0] ? bots[0].id : null)

  const online = bots.filter((b) => b.connected).length
  els.stateDot.className = 'dot ' + (online ? 'on' : 'off')
  els.stateText.textContent = online ? `${online}/${bots.length} 在线` : '未连接'

  updateTargetControls()
}

function currentBot () {
  return bots.find((b) => b.id === targetId) || null
}

function updateTargetControls () {
  const b = currentBot()
  const on = !!(b && b.connected)
  const ctrls = [els.chatInput, els.btnChat, els.btnWalk, els.followName, els.btnFollow,
    els.btnStopmove, els.collectName, els.btnCollect, els.btnDig, els.btnAttack,
    els.tgEat, els.tgArmor, els.tgWander]
  ctrls.forEach((c) => { c.disabled = !on })
  if (on) {
    suppressToggle = true
    els.tgEat.checked = !!b.autoEat
    els.tgArmor.checked = !!b.autoArmor
    els.tgWander.checked = !!b.wander
    suppressToggle = false
  }
}

// ---------- AI 设置 ----------
function renderAi (s) {
  ai = s || {}
  els.aiProvider.value = ai.provider || 'openai'
  els.aiBaseUrl.value = ai.baseUrl || ''
  els.aiApiKey.value = ai.apiKey || ''
  els.aiModel.value = ai.model || ''
  els.aiTrigger.value = ai.passiveTrigger || 'name'
  els.aiInterval.value = ai.autonomousInterval || 20
  syncProviderPlaceholder()
}

function syncProviderPlaceholder () {
  const ollama = els.aiProvider.value === 'ollama'
  els.aiBaseUrl.placeholder = ollama ? 'http://127.0.0.1:11434' : 'https://api.deepseek.com/v1'
  els.aiModel.placeholder = ollama ? 'qwen2.5:7b' : 'deepseek-chat'
  els.aiApiKey.disabled = ollama
}

function collectAiForm () {
  return {
    provider: els.aiProvider.value,
    baseUrl: els.aiBaseUrl.value.trim(),
    apiKey: els.aiApiKey.value.trim(),
    model: els.aiModel.value.trim(),
    passiveTrigger: els.aiTrigger.value,
    autonomousInterval: Number(els.aiInterval.value) || 20
  }
}

function batchCfg () {
  return {
    host: els.host.value.trim(),
    port: Number(els.port.value) || 25565,
    version: els.version.value,
    auth: els.auth.value,
    namePrefix: els.namePrefix.value.trim() || 'Bot',
    startIndex: Number(els.startIndex.value) || 1,
    count: Number(els.count.value) || 1,
    aiMode: els.newAiMode.value
  }
}

// ---------- 事件绑定 ----------
els.btnBatch.addEventListener('click', () => { api.batchAdd(batchCfg()) })
els.btnBatchStart.addEventListener('click', async () => {
  const r = await api.batchAdd(batchCfg())
  for (const id of (r && r.ids) || []) await api.startBot(id)
})
els.btnStartAll.addEventListener('click', () => api.startAll())
els.btnStopAll.addEventListener('click', () => api.stopAll())
els.btnClear.addEventListener('click', () => {
  if (confirm('确定清空所有假人吗？（会先全部下线）')) api.clearBots()
})

els.aiProvider.addEventListener('change', syncProviderPlaceholder)
els.btnAiSave.addEventListener('click', async () => {
  const r = await api.saveAi(collectAiForm())
  els.aiStatus.textContent = '已保存'
  els.aiStatus.className = 'ai-status ok'
  if (r && r.ai) renderAi(r.ai)
})
els.btnAiTest.addEventListener('click', async () => {
  els.aiStatus.textContent = '测试中...'
  els.aiStatus.className = 'ai-status'
  await api.saveAi(collectAiForm())
  const r = await api.testAi()
  if (r && r.ok) {
    els.aiStatus.textContent = '✅ ' + r.detail
    els.aiStatus.className = 'ai-status ok'
  } else {
    els.aiStatus.textContent = '❌ ' + ((r && r.error) || '连接失败')
    els.aiStatus.className = 'ai-status bad'
  }
})

els.targetBot.addEventListener('change', () => { targetId = els.targetBot.value; updateTargetControls() })

els.btnChat.addEventListener('click', () => {
  const msg = els.chatInput.value.trim()
  if (msg && targetId) { api.action(targetId, 'chat', { msg }); els.chatInput.value = '' }
})
els.chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') els.btnChat.click() })

els.btnWalk.addEventListener('click', () => {
  if (targetId) api.action(targetId, 'walk', { x: Number(els.walkX.value), y: Number(els.walkY.value), z: Number(els.walkZ.value) })
})
els.btnFollow.addEventListener('click', () => {
  const name = els.followName.value.trim()
  if (name && targetId) api.action(targetId, 'follow', { name })
})
els.btnStopmove.addEventListener('click', () => { if (targetId) api.action(targetId, 'stopmove', {}) })
els.btnCollect.addEventListener('click', () => {
  const name = els.collectName.value.trim()
  if (name && targetId) api.action(targetId, 'collect', { name, count: Number(els.collectCount.value) || 1 })
})
els.btnDig.addEventListener('click', () => {
  if (targetId) api.action(targetId, 'dig', { x: Number(els.digX.value), y: Number(els.digY.value), z: Number(els.digZ.value) })
})
els.btnAttack.addEventListener('click', () => { if (targetId) api.action(targetId, 'attack', {}) })
els.tgEat.addEventListener('change', () => { if (!suppressToggle && targetId) api.action(targetId, 'autoeat', { on: els.tgEat.checked }) })
els.tgArmor.addEventListener('change', () => { if (!suppressToggle && targetId) api.action(targetId, 'autoarmor', { on: els.tgArmor.checked }) })
els.tgWander.addEventListener('change', () => { if (!suppressToggle && targetId) api.action(targetId, 'wander', { on: els.tgWander.checked }) })

// 事件订阅
api.onLog(({ botName, line }) => appendLog(line, botName))
api.onBots((list) => renderBots(list))
api.onAi((s) => renderAi(s))
api.onMsaCode(({ botName, code }) => {
  appendLog(`[warn] 正版登录：打开 ${code.verification_uri || 'https://microsoft.com/link'} 输入代码 ${code.user_code}`, botName)
})

// 初始化
api.getState().then((s) => {
  if (s && s.ai) renderAi(s.ai)
  if (s && s.bots) renderBots(s.bots)
  appendLog('[系统] 界面已就绪：先填服务器信息批量添加假人，再在列表里点「上线」或直接「一键全部上线」')
})
