// bot/auto-player.js
// 机器人核心：封装 Mineflayer，管理连接、寻路与自动行为。
// 通过 EventEmitter 向 Electron 主进程上报日志(log)、状态(status)、微软登录码(msa-code)、聊天(chat)。
'use strict'

const { EventEmitter } = require('events')
const mineflayer = require('mineflayer')
const { pathfinder, Movements } = require('mineflayer-pathfinder')
const { GoalNear, GoalFollow, GoalXZ } = require('mineflayer-pathfinder').goals
const toolPlugin = require('mineflayer-tool').plugin
const collectPlugin = require('mineflayer-collectblock').plugin
const { Vec3 } = require('vec3')
const mcDataByVersion = require('minecraft-data')
const { splitHostPort, explainError } = require('./util')
const { resolveVersion, checkSupport, NEWEST_TESTED } = require('./versions')

// 护甲材料等级（内置自动穿甲用）
const ARMOR_TIERS = { leather: 1, golden: 2, chainmail: 3, iron: 4, diamond: 5, netherite: 6 }
// 护甲槽：装备目标 -> 背包窗口槽位编号
const ARMOR_SLOTS = [['head', 5], ['torso', 6], ['legs', 7], ['feet', 8]]

class AutoPlayer extends EventEmitter {
  constructor () {
    super()
    this.bot = null
    this.mcData = null
    this.running = false
    this.autoEatOn = false
    this.autoArmorOn = false
    this.wanderOn = false
    this.eating = false
    this.collecting = false
    this.followName = null
    this._armorTimer = null
    this._wanderTimer = null
    this._statusTimer = null
  }

  log (level, msg) {
    this.emit('log', `[${new Date().toLocaleTimeString()}] [${level}] ${msg}`)
  }

  _ready () {
    if (this.bot && this.mcData && this.running) return true
    this.log('warn', '机器人尚未连接')
    return false
  }

  // ---------- 连接管理 ----------
  start (cfg = {}) {
    if (this.bot) { this.log('warn', '机器人已在运行，请先停止'); return }

    const auth = cfg.auth === 'microsoft' ? 'microsoft' : 'offline'
    // 容错：允许把端口直接写在地址里（"1.2.3.4:43042"），避免被当成域名去做 DNS 解析
    const { host, port } = splitHostPort(cfg.host, cfg.port)
    // 版本：'auto'（默认）时传 false，mineflayer 会自己 ping 服务器识别版本
    const wantVersion = resolveVersion(cfg.version)
    const opts = {
      host,
      port,
      // 多假人场景下管理器传的是 cfg.name；两个都接受，避免多个假人同名互相顶下线
      username: cfg.username || cfg.name || 'AutoPlayer',
      version: wantVersion,
      auth,
      viewDistance: 'short',
      checkTimeoutInterval: 30 * 1000,
      hideErrors: true, // 自己记录更清晰的错误信息，避免库里再打印一遍堆栈
      plugins: { pathfinder, tool: toolPlugin, collectBlock: collectPlugin },
      onMsaCode: (code) => {
        this.emit('msa-code', code)
        this.log('info', `微软登录码已生成，请打开 https://microsoft.com/link 输入: ${code.user_code}`)
      }
    }
    if (auth === 'microsoft') opts.authCache = cfg.authCache || 'msa-cache.json'

    this.versionMode = wantVersion === false ? '自动探测' : wantVersion
    // 记住本次参数，便于"版本超范围时自动回退重试"
    if (!cfg._fromRetry) this._retried = false
    this._lastCfg = { ...cfg }
    this._lastError = null
    this.log('info', `正在连接 ${opts.host}:${opts.port}（版本 ${this.versionMode}，认证 ${auth}）...`)
    this.bot = mineflayer.createBot(opts)
    this._connectHost = opts.host
    this._rawHost = String(cfg.host == null ? '' : cfg.host) // 保留用户原始输入，便于给出准确提示
    this._wireEvents()
  }

  stop () {
    if (this.bot) {
      try { this.bot.end('玩家手动断开') } catch (e) { /* 忽略 */ }
    }
    this._cleanup()
  }

  _wireEvents () {
    const bot = this.bot

    bot.on('login', () => {
      this.running = true
      this.detectedVersion = bot.version
      this.protocolVersion = bot.protocolVersion
      this.log('info', `登录成功，游戏名: ${bot.username}`)
      const sup = checkSupport(bot.version)
      this.log(sup.ok ? (sup.level === 'tested' ? 'info' : 'warn') : 'error',
        `服务器版本: ${sup.message}（协议 ${bot.protocolVersion}${this.versionMode === '自动探测' ? '，自动探测' : ''}）`)
      this.emit('status', this.getStatus())
    })

    bot.once('spawn', () => {
      this.mcData = mcDataByVersion(bot.version)
      bot.pathfinder.setMovements(new Movements(bot, this.mcData))
      this.log('info', '已生成到世界中，可以开始行动')
      // pathfinder 的事件由 bot 发出（pathfinder 2.x），不是 bot.pathfinder
      bot.on('goal_reached', () => this.log('info', '已到达目标点'))
      this._startStatusTimer()
    })

    bot.on('kicked', (reason) => {
      const text = typeof reason === 'string' ? reason : JSON.stringify(reason)
      this.log('error', `被服务器踢出: ${text}`)
    })
    bot.on('end', (reason) => {
      this.log('info', `连接结束: ${reason}`)
      // 自动探测到超范围版本时，退一步用最新支持版本再试一次（配合服务端 ViaVersion 可进新版服务器）
      const err = this._lastError
      const unsupported = !!(err && /no data available for version|is not supported/i.test(String(err.message || '')))
      const canRetry = unsupported && this.versionMode === '自动探测' && !this._retried && this._lastCfg
      this._cleanup()
      if (canRetry) {
        this._retried = true
        this.log('warn', `服务器版本超出了上游支持范围（当前最新支持 ${NEWEST_TESTED}），自动改用 ${NEWEST_TESTED} 再试一次...`)
        this.log('info', '若服务器装了 ViaVersion + ViaBackwards，这样就可以正常进入；否则请把服务端版本调整到支持范围内')
        this.start({ ...this._lastCfg, version: NEWEST_TESTED, _fromRetry: true })
      }
    })
    bot.on('error', (err) => {
      this._lastError = err
      if (!this.running) this.log('error', explainError(err, this._rawHost))
    })

    bot.on('death', () => {
      this.log('warn', '机器人死亡，尝试重生...')
      setTimeout(() => {
        try { if (this.bot) this.bot.respawn() } catch (e) { /* 忽略 */ }
      }, 1500)
    })

    bot.on('health', () => {
      if (bot.health < 8) this.log('warn', `血量过低: ${bot.health.toFixed(1)}`)
    })

    bot.on('physicsTick', () => this._autoEatTick())

    bot.on('chat', (username, message) => {
      this.emit('chat', { username, message })
      this.log('chat', `<${username}> ${message}`)
      this._handleChatCommand(username, message)
    })

    bot.on('messagestr', (msg) => this.log('server', msg))

    // 捡到物品后自动检查护甲（若开启）
    bot.on('playerCollect', () => { if (this.autoArmorOn) this._equipBestArmor().catch(() => {}) })
  }

  _cleanup () {
    clearInterval(this._armorTimer); clearInterval(this._wanderTimer); clearInterval(this._statusTimer)
    this._armorTimer = this._wanderTimer = this._statusTimer = null
    this.autoEatOn = this.autoArmorOn = this.wanderOn = false
    this.eating = false
    this.collecting = false
    this.followName = null
    this.bot = null
    this.mcData = null
    this.running = false
    this.emit('status', { connected: false })
  }

  _startStatusTimer () {
    if (this._statusTimer) return
    this._statusTimer = setInterval(() => this.emit('status', this.getStatus()), 1000)
  }

  getStatus () {
    if (!this.bot) {
      return {
        connected: false,
        version: this.detectedVersion || null,
        protocolVersion: this.protocolVersion || null,
        versionMode: this.versionMode || null
      }
    }
    const b = this.bot
    // 注意：机器人刚创建时 players/food/health 等字段还没有下发，这里必须全部做保护，
    // 否则 Object.keys(undefined) 之类的异常会让整个进程崩溃（Electron 主进程同样受影响）
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
    return {
      connected: true,
      username: b.username || '',
      health: num(b.health),
      food: num(b.food),
      pos: b.entity ? {
        x: Math.round(b.entity.position.x),
        y: Math.round(b.entity.position.y),
        z: Math.round(b.entity.position.z)
      } : null,
      dimension: b.game ? b.game.dimension : null,
      players: b.players ? Object.keys(b.players).length : 0,
      version: this.detectedVersion || null,
      protocolVersion: this.protocolVersion || null,
      versionMode: this.versionMode || null,
      autoEat: this.autoEatOn,
      autoArmor: this.autoArmorOn,
      wander: this.wanderOn
    }
  }

  // ---------- 基础动作 ----------
  sendChat (msg) {
    if (!this._ready()) return
    this.bot.chat(String(msg).slice(0, 256))
  }

  walkTo (x, y, z, range = 2) {
    if (!this._ready()) return
    this.bot.pathfinder.setGoal(new GoalNear(x, y, z, range))
    this.log('info', `开始前往 (${x}, ${y}, ${z})`)
  }

  follow (name) {
    if (!this._ready()) return
    const target = this.bot.players ? this.bot.players[name] : null
    if (!target || !target.entity) { this.log('warn', `找不到玩家 ${name}`); return }
    this.followName = name
    this.bot.pathfinder.setGoal(new GoalFollow(target.entity, 2))
    this.log('info', `开始跟随 ${name}（发送"停下"可停止）`)
  }

  stopMoving () {
    if (!this._ready()) return
    this.followName = null
    this.bot.pathfinder.setGoal(null)
    this.log('info', '已停止移动')
  }

  // ---------- 采集 / 挖掘 ----------
  async collect (name, count = 1, range = 64) {
    if (!this._ready()) return
    const id = this.mcData.blocksByName[name] ? this.mcData.blocksByName[name].id : null
    if (!id) { this.log('error', `未知方块: ${name}（请使用英文 ID，如 iron_ore）`); return }
    if (this.collecting) { this.log('warn', '已有收集任务进行中'); return }

    this.collecting = true
    const total = Math.min(Math.max(Number(count) || 1, 1), 100)
    this.log('info', `开始收集 ${name} × ${total}（范围 ${range} 格）`)
    let got = 0
    try {
      for (let i = 0; i < total; i++) {
        const block = this.bot.findBlock({ matching: id, maxDistance: range })
        if (!block) { this.log('warn', `范围内只找到 ${i} 个 ${name}`); break }
        await this.bot.collectBlock.collect(block, { append: false })
        got++
      }
      this.log('info', `收集完成，共获得 ${got} 个 ${name}`)
    } catch (e) {
      this.log('error', `收集中断: ${e.message}`)
    } finally {
      this.collecting = false
    }
  }

  async dig (x, y, z) {
    if (!this._ready()) return
    const block = this.bot.blockAt(new Vec3(x, y, z))
    if (!block || block.name === 'air') { this.log('warn', `(${x}, ${y}, ${z}) 处没有可挖的方块`); return }
    try {
      await this.bot.dig(block)
      this.log('info', `已挖掉 ${block.displayName}`)
    } catch (e) {
      this.log('error', `挖掘失败: ${e.message}`)
    }
  }

  async give (name, count = 1) {
    if (!this._ready()) return
    const item = this.bot.inventory.items().find(i => i.name === name)
    if (!item) { this.log('warn', `背包里没有 ${name}`); return }
    try {
      await this.bot.toss(item.type, null, Math.min(Number(count) || 1, item.count))
      this.log('info', `已丢出 ${Math.min(Number(count) || 1, item.count)} 个 ${item.displayName}`)
    } catch (e) {
      this.log('error', `丢弃失败: ${e.message}`)
    }
  }

  // 攻击附近的怪物（AI 自主游玩/自卫用）
  async attackNearest (range = 4) {
    if (!this._ready() || !this.bot.entity) return
    const pos = this.bot.entity.position
    const target = this.bot.nearestEntity((e) => {
      if (!e || !e.position || e === this.bot.entity) return false
      if (e.type !== 'mob' && e.kind !== 'Hostile mobs') return false
      return e.position.distanceTo(pos) <= range
    })
    if (!target) { this.log('warn', `附近 ${range} 格内没有可攻击的怪物`); return }
    const label = target.name || target.displayName || '怪物'
    try {
      await this.bot.lookAt(target.position.offset(0, (target.height || 1.6) * 0.8, 0), true)
      this.bot.attack(target)
      if (this.bot.heldItem) this.bot.swingArm()
      this.log('info', `攻击 ${label}`)
    } catch (e) {
      this.log('warn', `攻击 ${label} 失败: ${e.message}`)
    }
  }

  // ---------- 自动行为开关 ----------
  setAutoEat (on) {
    this.autoEatOn = !!on
    this.log('info', on ? '自动吃东西已开启' : '自动吃东西已关闭')
    if (on && this._ready() && this.bot.food > 14) this.log('info', `当前饥饿值 ${Math.round(this.bot.food)}，暂不需要进食`)
  }

  setAutoArmor (on) {
    this.autoArmorOn = !!on
    this.log('info', on ? '自动穿甲已开启' : '自动穿甲已关闭')
    clearInterval(this._armorTimer)
    this._armorTimer = null
    if (on) {
      this._armorTimer = setInterval(() => this._equipBestArmor().catch(() => {}), 2000)
      if (this._ready()) this._equipBestArmor().catch(() => {})
    }
  }

  setWander (on) {
    this.wanderOn = !!on
    this.log('info', on ? '自动巡逻已开启' : '自动巡逻已关闭')
    clearInterval(this._wanderTimer)
    this._wanderTimer = null
    if (on) {
      this._wanderTimer = setInterval(() => this._wanderTick(), 8000)
      this._wanderTick()
    }
  }

  _wanderTick () {
    if (!this._ready() || !this.wanderOn) return
    const b = this.bot
    if (!b.entity) return // 还没真正生成
    if (b.pathfinder.isMoving()) return // 正在移动则等下一轮
    const { x, z } = b.entity.position
    const tx = Math.round(x + (Math.random() - 0.5) * 50)
    const tz = Math.round(z + (Math.random() - 0.5) * 50)
    b.pathfinder.setGoal(new GoalXZ(tx, tz))
    this.log('info', `巡逻: 前往 (${tx}, ${tz})`)
  }

  // ---------- 内置自动吃 ----------
  _autoEatTick () {
    if (!this.autoEatOn || this.eating || !this._ready()) return
    const bot = this.bot
    if (typeof bot.food !== 'number' || typeof bot.health !== 'number') return // 状态未下发
    // 饥饿或血量过低时才吃
    if (bot.food > 14 && bot.health > 15) return

    const foods = this.mcData.foodsArray
      .filter(f => bot.inventory.items().some(i => i.name === f.name))
      .sort((a, b) => b.foodPoints - a.foodPoints)
    if (!foods.length) {
      this.log('warn', '饥饿但背包里没有食物，自动吃已暂停')
      this.autoEatOn = false
      this.emit('status', this.getStatus())
      return
    }

    this.eating = true
    const food = foods[0]
    const item = bot.inventory.items().find(i => i.name === food.name)
    const oldItem = bot.heldItem
    ;(async () => {
      try {
        await bot.equip(item, 'hand')
        await bot.consume()
        this.log('info', `吃了一个 ${food.name}（饥饿 ${Math.round(bot.food)}）`)
        if (oldItem) await bot.equip(oldItem, 'hand')
      } catch (e) {
        this.log('warn', `进食失败: ${e.message}`)
      } finally {
        this.eating = false
      }
    })()
  }

  // ---------- 内置自动穿甲 ----------
  _tierOf (name) {
    const m = /^(leather|golden|chainmail|iron|diamond|netherite)_/.exec(name)
    return m ? ARMOR_TIERS[m[1]] : 0
  }

  _slotMatches (name, dest) {
    if (dest === 'head') return name.endsWith('helmet')
    if (dest === 'torso') return name.endsWith('chestplate')
    if (dest === 'legs') return name.endsWith('leggings')
    if (dest === 'feet') return name.endsWith('boots')
    return false
  }

  async _equipBestArmor () {
    if (!this._ready()) return
    const bot = this.bot
    const items = bot.inventory.items()
    for (const [dest, slotId] of ARMOR_SLOTS) {
      const current = bot.inventory.slots[slotId]
      const currentTier = current ? this._tierOf(current.name) : 0
      const best = items
        .filter(i => this._slotMatches(i.name, dest) && this._tierOf(i.name) > currentTier)
        .sort((a, b) => this._tierOf(b.name) - this._tierOf(a.name))[0]
      if (best) {
        try {
          await bot.equip(best, dest)
          this.log('info', `自动穿上 ${best.displayName}`)
        } catch (e) { /* 忽略装备失败 */ }
      }
    }
  }

  // ---------- 游戏内聊天指令（任何人都可指挥机器人） ----------
  _handleChatCommand (username, message) {
    if (!this._ready() || username === this.bot.username) return
    const m = String(message).trim()

    // 忽略"状态报告"这类回显，避免多个机器人互相触发形成刷屏循环
    if (/血量\s*[\d.]+\s*饥饿/.test(m)) return

    // 单词类指令要求整句匹配：这样机器人自己的回复不会再被当成指令
    let action = null
    if (/^(?:stop|停|停下|站住)$/i.test(m)) {
      action = () => this.stopMoving()
    } else if (/^(?:come|来|过来|跟我|跟随)$/i.test(m)) {
      action = () => this.follow(username)
    } else {
      let r = m.match(/^(?:goto|go|去|走到)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/i)
      if (r) {
        action = () => this.walkTo(Number(r[1]), Number(r[2]), Number(r[3]))
      } else {
        r = m.match(/^(?:collect|挖|采集|收集)\s+([a-z0-9_]+)(?:\s+(\d{1,3}))?/i)
        if (r) {
          action = () => this.collect(r[1], r[2] ? Number(r[2]) : 1)
        } else {
          r = m.match(/^(?:give|给|给我)\s+([a-z0-9_]+)(?:\s+(\d{1,3}))?/i)
          if (r) action = () => this.give(r[1], r[2] ? Number(r[2]) : 1)
          else if (/^(?:status|状态|报告)$/i.test(m)) action = () => this._report(username)
        }
      }
    }
    if (!action) return

    // 防刷屏：10 秒内最多响应 6 条指令
    const now = Date.now()
    this._cmdTimes = (this._cmdTimes || []).filter(t => now - t < 10000)
    if (this._cmdTimes.length >= 6) return
    this._cmdTimes.push(now)
    action()
  }

  _report (to) {
    const b = this.bot
    const p = b.entity ? b.entity.position : null
    const pos = p ? `(${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)})` : '未知'
    // 措辞刻意不以指令关键字开头，防止其他机器人把它当成新指令
    this.sendChat(`我的状态：血量 ${Math.round(b.health)}，饥饿 ${Math.round(b.food)}，位置 ${pos}`)
  }
}

module.exports = AutoPlayer
