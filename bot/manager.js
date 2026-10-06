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
    this.bots = new Map()
    this.seq = 0
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
      // 只恢复配置，不自动连接（是否自动上线由 autoStart 决定）
      for (const cfg of raw.bots || []) this.addBot(cfg, { silent: true })
      if (this.autoStart) {
        setTimeout(() => {
          for (const id of this.bots.keys()) this.startBot(id)
        }, 1500)
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
        bots: [...this.bots.values()].map((b) => b.config)
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
      version: cfg.version || '1.21.11',
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

  // 批量生成同配置假人：名字前缀 + 起始序号 + 数量
  batchAdd (cfg = {}) {
    const count = Math.min(Math.max(Number(cfg.count) || 1, 1), 20)
    const prefix = String(cfg.namePrefix || 'Bot').trim() || 'Bot'
    const start = Number(cfg.startIndex) || 1
    const ids = []
    for (let i = 0; i < count; i++) {
      ids.push(this.addBot({
        name: `${prefix}${start + i}`,
        host: cfg.host,
        port: cfg.port,
        version: cfg.version,
        auth: cfg.auth,
        aiMode: cfg.aiMode
      }))
    }
    return ids
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
    b.player.start({ ...b.config, username: b.config.name })
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
