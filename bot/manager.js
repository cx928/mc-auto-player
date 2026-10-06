// bot/manager.js - 多假人管理器
// 负责：批量创建假人、一键启停、按假人分发动作、AI 配置与记忆持久化、向上层（Electron/WebUI）广播状态
'use strict'

const fs = require('fs')
const path = require('path')
const { EventEmitter } = require('events')
const AutoPlayer = require('./auto-player')
const { AiClient } = require('./ai-client')
const { AiAgent } = require('./ai-agent')
const { splitHostPort } = require('./util')
const { versionOptions, rangeText } = require('./versions')

const DEFAULT_AI = {
  provider: 'openai',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  temperature: 0.7,
  passiveTrigger: 'name', // name = 只有叫它名字才回应；all = 所有聊天都回应
  autonomousInterval: 20
}

class BotManager extends EventEmitter {
  constructor (options = {}) {
    super()
    this.settingsFile = options.settingsFile || path.join(process.cwd(), 'mc-auto-player-settings.json')
    this.persist = options.persist !== false // CLI 场景可关掉读写配置文件
    this.restoreBots = options.restoreBots !== false // false = 只恢复预设/设置，不自动把上次的假人建回来
    this.bots = new Map()
    this.seq = 0
    this.presets = []   // 服务器预设（一键化用）
    this.lastUsed = {}  // 上次使用的连接参数，供界面预填
    // 正版登录凭证缓存放在配置文件同目录，避免依赖当前工作目录
    this.msaCacheFile = options.msaCacheFile || path.join(path.dirname(this.settingsFile), 'msa-cache.json')
    this.aiClient = new AiClient(DEFAULT_AI)
    this.ai = { ...DEFAULT_AI }
    this.autoStart = false
    this._statusTimer = null
    this.load()
    this._statusTimer = setInterval(() => this.emit('bots', this.getBots()), 1000)
  }

  // ---------- 持久化 ----------
  load () {
    if (!this.persist) return
    try {
      if (!fs.existsSync(this.settingsFile)) return
      const raw = JSON.parse(fs.readFileSync(this.settingsFile, 'utf8'))
      if (raw.ai) {
        this.ai = { ...DEFAULT_AI, ...raw.ai }
        this.aiClient.setSettings(this.ai)
        this.aiClient.provider = this.ai.provider
      }
      this.autoStart = !!raw.autoStart
      this.presets = Array.isArray(raw.presets) ? raw.presets : []
      this.lastUsed = raw.lastUsed || {}
      // 只恢复配置，不自动连接（是否自动上线由 autoStart 决定）
      if (this.restoreBots) {
        for (const cfg of raw.bots || []) this.addBot(cfg, { silent: true })
        if (this.autoStart) {
          setTimeout(() => {
            for (const id of this.bots.keys()) this.startBot(id)
          }, 1500)
        }
      }
    } catch (e) {
      this.emit('log', { botId: null, botName: '系统', line: `[warn] 读取配置失败: ${e.message}` })
    }
  }

  save () {
    if (!this.persist) return
    try {
      const data = {
        ai: this.ai,
        autoStart: this.autoStart,
        presets: this.presets,
        lastUsed: this.lastUsed,
        // restoreBots=false（命令行版）时不写入假人列表，避免配置文件里留下用不上的陈旧数据
        bots: this.restoreBots ? [...this.bots.values()].map((b) => b.config) : []
      }
      fs.mkdirSync(path.dirname(this.settingsFile), { recursive: true })
      fs.writeFileSync(this.settingsFile, JSON.stringify(data, null, 2))
    } catch (e) {
      this.emit('log', { botId: null, botName: '系统', line: `[warn] 保存配置失败: ${e.message}` })
    }
  }

  updateAiSettings (patch = {}) {
    this.ai = { ...this.ai, ...patch }
    this.aiClient.setSettings(this.ai)
    // 同步到所有已存在的智能体
    for (const b of this.bots.values()) {
      if (b.agent) {
        b.agent.trigger = this.ai.passiveTrigger === 'all' ? 'all' : 'name'
        b.agent.intervalSec = Number(this.ai.autonomousInterval) || 20
      }
    }
    this.save()
    this.emit('ai', this.ai)
    return this.ai
  }

  async testAi () {
    const desc = this.aiClient.describe()
    const reply = await this.aiClient.test()
    return { ok: true, detail: `${desc} → 模型回复：${reply}` }
  }

  // ---------- 假人增删 ----------
  addBot (cfg = {}, opts = {}) {
    const id = 'bot' + (++this.seq)
    // 容错：地址里可以直接带端口（"1.2.3.4:43042"），统一在这里拆开并保存成干净的值
    const hp = splitHostPort(cfg.host, cfg.port)
    const config = {
      name: cfg.name || ('Bot' + this.seq),
      host: hp.host,
      port: hp.port,
      version: cfg.version && cfg.version !== '' ? cfg.version : 'auto', // auto = 让 mineflayer 自己探测服务器版本
      auth: cfg.auth === 'microsoft' ? 'microsoft' : 'offline',
      aiMode: ['passive', 'autonomous'].includes(cfg.aiMode) ? cfg.aiMode : 'off'
    }
    const player = new AutoPlayer()
    const agent = new AiAgent(player, this.aiClient, {
      name: config.name,
      intervalSec: Number(this.ai.autonomousInterval) || 20,
      trigger: this.ai.passiveTrigger === 'all' ? 'all' : 'name'
    })

    const entry = { id, config, player, agent, aiMode: config.aiMode }
    this.bots.set(id, entry)

    player.on('log', (line) => this.emit('log', { botId: id, botName: config.name, line }))
    player.on('msa-code', (code) => this.emit('msa-code', { botId: id, botName: config.name, code }))
    player.on('chat', ({ username, message }) => {
      this.emit('chat', { botId: id, botName: config.name, username, message })
      agent.onChat(username, message)
    })
    agent.on('log', (level, line) => this.emit('log', { botId: id, botName: config.name, line: `[${level}] ${line}` }))
    agent.on('auto-off', () => { entry.aiMode = 'off'; this.save(); this.emit('bots', this.getBots()) })

    if (!opts.silent) {
      this.save()
      this.emit('log', { botId: id, botName: config.name, line: `[info] 已添加假人 ${config.name}（${config.host}:${config.port}）` })
    }
    this.emit('bots', this.getBots())
    return id
  }

  // 自动生成不重名的假人名字（跳过列表中已占用的名字）
  _nextNames (prefix, startIndex, count) {
    const used = new Set()
    for (const b of this.bots.values()) used.add(b.config.name)
    // 只开一个且名字没被占用时，直接用前缀本身（--user c 就是 c，而不是 c1）
    if (count === 1 && !used.has(prefix)) return [prefix]
    const names = []
    let i = Math.max(1, Number(startIndex) || 1)
    const limit = i + count + 500
    while (names.length < count && i <= limit) {
      const n = `${prefix}${i++}`
      if (!used.has(n)) { names.push(n); used.add(n) }
    }
    return names
  }

  // 批量生成同配置假人：名字前缀 + 起始序号 + 数量（自动跳过重名）
  batchAdd (cfg = {}) {
    const count = Math.min(Math.max(Number(cfg.count) || 1, 1), 20)
    const prefix = String(cfg.namePrefix || 'Bot').trim() || 'Bot'
    const start = Number(cfg.startIndex) || 1
    const ids = []
    for (const name of this._nextNames(prefix, start, count)) {
      ids.push(this.addBot({
        name,
        host: cfg.host,
        port: cfg.port,
        version: cfg.version,
        auth: cfg.auth,
        aiMode: cfg.aiMode
      }))
    }
    return ids
  }

  // ---------- 服务器预设（一键化） ----------
  savePreset (p = {}) {
    const hp = splitHostPort(p.host, p.port)
    const preset = {
      name: String(p.name || `${hp.host}:${hp.port}`).trim(),
      host: hp.host,
      port: hp.port,
      version: p.version || 'auto',
      auth: p.auth === 'microsoft' ? 'microsoft' : 'offline'
    }
    const i = this.presets.findIndex((x) => x.name === preset.name)
    if (i >= 0) this.presets[i] = preset
    else this.presets.push(preset)
    this.save()
    this.emit('presets', this.presets)
    return preset
  }

  removePreset (name) {
    const before = this.presets.length
    this.presets = this.presets.filter((p) => p.name !== name)
    this.save()
    this.emit('presets', this.presets)
    return this.presets.length !== before
  }

  // 一键挂机：用预设 / 直接给的参数 / 上次用过的参数，批量创建并立即上线
  quickStart (cfg = {}) {
    const preset = cfg.presetName ? this.presets.find((p) => p.name === cfg.presetName) : null
    if (cfg.presetName && !preset) throw new Error(`没有找到预设「${cfg.presetName}」`)
    const lu = this.lastUsed || {}
    const host = cfg.host || (preset && preset.host) || lu.host
    const port = cfg.port || (preset && preset.port) || lu.port
    if (!host) throw new Error('没有可用的服务器地址：请填服务器地址，或先 /preset save 存一个预设')
    const merged = {
      host,
      port,
      version: cfg.version || (preset && preset.version) || lu.version || 'auto',
      auth: cfg.auth || (preset && preset.auth) || lu.auth || 'offline',
      aiMode: cfg.aiMode,
      count: cfg.count || lu.count || 1,
      namePrefix: cfg.namePrefix || lu.namePrefix || 'Bot',
      startIndex: cfg.startIndex || 1,
      presetName: cfg.presetName || null
    }
    this.lastUsed = {
      host: merged.host,
      port: merged.port,
      version: merged.version,
      auth: merged.auth,
      namePrefix: merged.namePrefix,
      count: Number(merged.count) || 1,
      presetName: merged.presetName
    }
    const ids = this.batchAdd(merged)
    for (const id of ids) this.startBot(id)
    this.save()
    this.emit('bots', this.getBots())
    this.emit('log', {
      botId: null,
      botName: '系统',
      line: `[info] 一键挂机：已创建并上线 ${ids.length} 个假人 → ${merged.host}:${merged.port}（版本 ${merged.version === 'auto' ? '自动探测' : merged.version}）`
    })
    return ids
  }

  // 正版登录状态（凭证缓存）
  microsoftStatus () {
    const out = { cached: false, file: this.msaCacheFile, accounts: [] }
    try {
      if (fs.existsSync(this.msaCacheFile)) {
        const j = JSON.parse(fs.readFileSync(this.msaCacheFile, 'utf8'))
        out.accounts = Object.keys(j || {})
        out.cached = out.accounts.length > 0
      }
    } catch (e) { out.error = e.message }
    return out
  }

  // 供界面渲染版本下拉框
  versionsInfo () {
    return { ...versionOptions(), rangeText: rangeText() }
  }

  removeBot (id) {
    const b = this.bots.get(id)
    if (!b) return false
    try { b.player.stop() } catch (_) {}
    try { b.agent.stop() } catch (_) {}
    b.player.removeAllListeners()
    this.bots.delete(id)
    this.save()
    this.emit('bots', this.getBots())
    return true
  }

  clear () {
    for (const id of [...this.bots.keys()]) this.removeBot(id)
  }

  // ---------- 启停 ----------
  startBot (id) {
    const b = this.bots.get(id)
    if (!b) return false
    if (b.player.bot) { this.emit('log', { botId: id, botName: b.config.name, line: '[warn] 该假人已在运行' }); return false }
    // 显式把假人名字作为游戏内用户名，保证每个假人名字不同
    b.player.start({ ...b.config, username: b.config.name, authCache: this.msaCacheFile })
    if (b.aiMode !== 'off') {
      // 等进入世界后再启用 AI，避免开局乱调用
      const t = setInterval(() => {
        if (b.player.running && b.player.bot && b.player.bot.entity) {
          clearInterval(t)
          b.agent.setMode(b.aiMode)
        }
      }, 1000)
      setTimeout(() => clearInterval(t), 60000)
    }
    return true
  }

  stopBot (id) {
    const b = this.bots.get(id)
    if (!b) return false
    b.agent.stop()
    b.player.stop()
    return true
  }

  startAll () {
    let n = 0
    for (const id of this.bots.keys()) if (this.startBot(id)) n++
    return n
  }

  stopAll () {
    for (const id of this.bots.keys()) this.stopBot(id)
  }

  setAiMode (id, mode) {
    const b = this.bots.get(id)
    if (!b) return false
    b.aiMode = ['passive', 'autonomous'].includes(mode) ? mode : 'off'
    b.config.aiMode = b.aiMode
    b.agent.setMode(b.aiMode)
    this.save()
    this.emit('bots', this.getBots())
    return true
  }

  // ---------- 动作分发 ----------
  action (id, name, args = {}) {
    const b = this.bots.get(id)
    if (!b) return false
    const p = b.player
    const n = (v) => Number(v)
    switch (name) {
      case 'chat': p.sendChat(String(args.msg || '')); break
      case 'walk': p.walkTo(n(args.x), n(args.y), n(args.z), 2); break
      case 'follow': p.follow(String(args.name || '').trim()); break
      case 'stopmove': p.stopMoving(); break
      case 'collect': p.collect(String(args.name || ''), args.count, args.range); break
      case 'dig': p.dig(n(args.x), n(args.y), n(args.z)); break
      case 'give': p.give(String(args.name || ''), args.count); break
      case 'autoeat': p.setAutoEat(!!args.on); break
      case 'autoarmor': p.setAutoArmor(!!args.on); break
      case 'wander': p.setWander(!!args.on); break
      case 'attack': p.attackNearest(4); break
      default: return false
    }
    return true
  }

  getBots () {
    return [...this.bots.values()].map((b) => {
      const st = b.player.getStatus()
      return {
        id: b.id,
        name: b.config.name,
        host: b.config.host,
        port: b.config.port,
        version: b.config.version,
        versionMode: st.versionMode || null,
        detectedVersion: st.version || null,      // 实际探测/连接到的服务器版本
        protocolVersion: st.protocolVersion || null,
        auth: b.config.auth,
        aiMode: b.aiMode,
        aiCalls: b.agent.stats.calls,
        aiActions: b.agent.stats.actions,
        connected: st.connected,
        health: st.health,
        food: st.food,
        pos: st.pos,
        dimension: st.dimension,
        players: st.players,
        autoEat: st.autoEat,
        autoArmor: st.autoArmor,
        wander: st.wander
      }
    })
  }

  shutdown () {
    clearInterval(this._statusTimer)
    for (const b of this.bots.values()) {
      try { b.agent.stop() } catch (_) {}
      try { b.player.stop() } catch (_) {}
    }
  }
}

module.exports = { BotManager, DEFAULT_AI }
