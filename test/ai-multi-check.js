// test/ai-multi-check.js - 验证「AI 操控假人」+「多假人」两条新增能力
// 用本地模拟大模型服务端（OpenAI 兼容 + Ollama 两种协议都测），不需要真实 API Key。
// 用法: node test/ai-multi-check.js   （需本地 1.21.11 测试服在 127.0.0.1:25566）
'use strict'

const http = require('http')
const os = require('os')
const fs = require('fs')
const path = require('path')
const { BotManager } = require('../bot/manager')
const { AiClient } = require('../bot/ai-client')
const { extractJson } = require('../bot/ai-agent')

const MC_HOST = process.env.TEST_HOST || '127.0.0.1'
const MC_PORT = Number(process.env.TEST_PORT || 25566)
const MOCK_PORT = 8791

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + detail : ''}`)
}
async function waitFor (fn, timeoutMs, step = 500) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    try { if (fn()) return true } catch (_) {}
    await sleep(step)
  }
  return false
}

// ---------- 模拟大模型服务端 ----------
const seenPrompts = []
let mockMode = 'move' // move | chat | empty

function makeMockServer () {
  return http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      let body = {}
      try { body = JSON.parse(raw) } catch (_) {}
      const messages = body.messages || []
      const sys = messages.filter(m => m.role === 'system').map(m => m.content).join('\n')
      const last = (messages.filter(m => m.role === 'user').pop() || {}).content || ''
      seenPrompts.push({ url: req.url, sys, last })

      // 从系统提示里抓出机器人坐标，证明"状态确实传给了模型"
      const m = /位置:\s*\((-?\d+),\s*(-?\d+),\s*(-?\d+)\)/.exec(sys)
      let content
      if (mockMode === 'move' && m) {
        const x = Number(m[1]) + 12
        const y = Number(m[2])
        const z = Number(m[3]) + 12
        content = '```json\n' + JSON.stringify({
          reply: '我去那边看看',
          actions: [{ name: 'walk_to', args: { x, y, z } }]
        }) + '\n```' // 故意用 Markdown 包裹，测试解析容错
      } else if (mockMode === 'chat') {
        content = JSON.stringify({ reply: '收到，我这就去办', actions: [{ name: 'chat', args: { text: '收到，我这就去办' } }] })
      } else {
        content = JSON.stringify({ reply: '', actions: [] })
      }

      if (req.url.startsWith('/api/chat')) {
        // Ollama 原生协议
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ message: { role: 'assistant', content }, done: true }))
      } else {
        // OpenAI 兼容协议
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }))
      }
    })
  })
}

function testExtractJson () {
  check('JSON 解析：纯 JSON', !!extractJson('{"reply":"a","actions":[]}'))
  check('JSON 解析：Markdown 包裹', !!extractJson('```json\n{"reply":"a","actions":[]}\n```'))
  check('JSON 解析：前后有废话', !!extractJson('好的，这是结果：{"reply":"a","actions":[]} 请查收'))
  check('JSON 解析：非法内容返回 null', extractJson('抱歉我不会') === null)
}

async function main () {
  testExtractJson()

  const server = makeMockServer()
  await new Promise(r => server.listen(MOCK_PORT, '127.0.0.1', r))
  console.log(`模拟大模型服务端已启动: http://127.0.0.1:${MOCK_PORT}`)

  // ---------- 1. AI 客户端两种后端 ----------
  const openaiClient = new AiClient({ provider: 'openai', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, apiKey: 'test-key', model: 'mock-model' })
  try {
    const r = await openaiClient.test()
    check('OpenAI 兼容后端可调用', typeof r === 'string', '回复=' + r.slice(0, 20))
  } catch (e) { check('OpenAI 兼容后端可调用', false, e.message) }

  const ollamaClient = new AiClient({ provider: 'ollama', baseUrl: `http://127.0.0.1:${MOCK_PORT}`, model: 'mock-ollama' })
  try {
    const r = await ollamaClient.test()
    check('Ollama 后端可调用', typeof r === 'string', '回复=' + r.slice(0, 20))
  } catch (e) { check('Ollama 后端可调用', false, e.message) }

  // ---------- 2. 多假人管理器 ----------
  const settingsFile = path.join(os.tmpdir(), 'mc-ai-test-settings.json')
  fs.rmSync(settingsFile, { force: true })
  const mgr = new BotManager({ settingsFile })
  const logs = []
  mgr.on('log', (e) => logs.push(e))
  // 安全取位置（假人可能掉线，bot/entity 会变成 null）
  const posOf = (id) => {
    const b = mgr.bots.get(id)
    return (b && b.player.bot && b.player.bot.entity) ? b.player.bot.entity.position.clone() : null
  }

  mgr.updateAiSettings({
    provider: 'openai',
    baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
    apiKey: 'test-key',
    model: 'mock-model',
    passiveTrigger: 'name'
  })

  const ids = mgr.batchAdd({ count: 3, namePrefix: 'AiBot', startIndex: 1, host: MC_HOST, port: MC_PORT, version: '1.21.11', auth: 'offline' })
  check('批量创建 3 个假人', ids.length === 3 && mgr.getBots().length === 3,
    '名字=' + mgr.getBots().map(b => b.name).join(','))

  const n = mgr.startAll()
  check('一键启动全部假人', n === 3, '已启动 ' + n)

  const allUp = await waitFor(() => mgr.getBots().every(b => b.connected), 60000)
  check('3 个假人全部连接成功', allUp,
    mgr.getBots().map(b => `${b.name}:${b.connected ? '在线' : '离线'}`).join(' '))

  const allSpawned = await waitFor(() => ids.every(id => {
    const b = mgr.bots.get(id)
    return b.player.bot && b.player.bot.entity
  }), 30000)
  check('3 个假人都生成了实体', allSpawned)

  // 互相可见（服务器里应有 3 个玩家）
  await sleep(3000)
  const visible = mgr.bots.get(ids[0]).player.getStatus().players
  check('假人之间互相可见', visible >= 3, 'Bot1 看到的玩家数=' + visible)

  // ---------- 3. AI 被动响应：让 AI 指挥假人移动 ----------
  mockMode = 'move'
  const bot1 = mgr.bots.get(ids[0])
  const before = posOf(ids[0])
  const promptsBefore = seenPrompts.length
  bot1.agent.setMode('passive')
  bot1.agent.onChat('Steve', `AiBot1 往东南走 12 格`)
  const called = await waitFor(() => seenPrompts.length > promptsBefore, 15000)
  check('被动模式：聊天触发了大模型调用', called, '调用次数=' + (seenPrompts.length - promptsBefore))

  const lastPrompt = seenPrompts[seenPrompts.length - 1] || {}
  check('提示词里带上了实时状态（坐标）', /位置:\s*\(-?\d+/.test(lastPrompt.sys || ''), '')
  check('提示词里带上了可用动作说明', (lastPrompt.sys || '').includes('walk_to'))

  const moved = await waitFor(() => { const p = posOf(ids[0]); return !!(p && before && p.distanceTo(before) > 8) }, 45000)
  const d1 = (posOf(ids[0]) && before) ? posOf(ids[0]).distanceTo(before).toFixed(1) : '未知'
  check('AI 的动作被真正执行（假人移动了）', moved, '移动距离=' + d1 + ' 格')

  // ---------- 4. AI 自主游玩 ----------
  mockMode = 'move'
  const bot2 = mgr.bots.get(ids[1])
  const before2 = posOf(ids[1])
  const callsBefore2 = bot2.agent.stats.calls
  mgr.updateAiSettings({ autonomousInterval: 3 }) // 加快节奏便于测试
  mgr.setAiMode(ids[1], 'autonomous')
  const autoCalled = await waitFor(() => bot2.agent.stats.calls > callsBefore2, 20000)
  check('自主模式：定时自动决策', autoCalled, '调用次数=' + (bot2.agent.stats.calls - callsBefore2))
  const moved2 = await waitFor(() => { const p = posOf(ids[1]); return !!(p && before2 && p.distanceTo(before2) > 8) }, 45000)
  const d2 = (posOf(ids[1]) && before2) ? posOf(ids[1]).distanceTo(before2).toFixed(1) : '未知'
  check('自主模式：动作被真正执行', moved2, '移动距离=' + d2 + ' 格')

  // ---------- 5. AI 说话会发到游戏聊天 ----------
  mockMode = 'chat'
  const bot3 = mgr.bots.get(ids[2])
  bot3.player.bot.once('chat', () => {})
  bot3.agent.setMode('passive')
  bot3.agent.onChat('Steve', 'AiBot3 你好')
  await sleep(6000)
  const said = logs.some(l => l.botName === 'AiBot3' && /说：收到，我这就去办/.test(l.line))
  check('AI 的回复真的发到了游戏聊天', said)

  // ---------- 6. 配置持久化 ----------
  mgr.save()
  const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
  check('配置已持久化（含 AI 设置与假人列表）',
    saved.bots && saved.bots.length === 3 && saved.ai && saved.ai.model === 'mock-model',
    `假人=${saved.bots.length} 模型=${saved.ai.model}`)

  // ---------- 7. 单个停止 / 移除 ----------
  mgr.stopBot(ids[2])
  await sleep(2000)
  check('可单独停止某个假人', mgr.getBots().find(b => b.id === ids[2]).connected === false)
  mgr.removeBot(ids[2])
  check('可移除假人', mgr.getBots().length === 2)

  mgr.stopAll()
  mgr.shutdown()
  server.close()
  fs.rmSync(settingsFile, { force: true })

  const failed = results.filter(r => !r.ok)
  console.log(`\n========== AI + 多假人测试汇总 ==========`)
  console.log(`通过 ${results.length - failed.length} / ${results.length}`)
  if (failed.length) {
    failed.forEach(f => console.log('  失败: ' + f.name))
    console.log('\n--- 假人日志（最后 25 条，便于定位）---')
    logs.slice(-25).forEach(l => console.log(`  [${l.botName}] ${l.line}`))
  }
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
