// bot/ai-agent.js - 每个假人一个的 AI 智能体
// 两种工作方式：
//   passive     —— 有人跟机器人说话时，交给大模型理解并执行
//   autonomous  —— 每隔一段时间自己决策下一步做什么（自主游玩）
// 大模型通过一个严格的 JSON 协议返回"要说的话 + 要执行的动作"，由这里校验后调用 AutoPlayer 执行。
'use strict'

const { EventEmitter } = require('events')

const ACTIONS_HELP = [
  'walk_to {"x":数字,"y":数字,"z":数字}     走到指定坐标',
  'follow {"player":"玩家名"}              跟随某个玩家',
  'stop {}                                停止当前移动',
  'collect {"block":"方块英文ID","count":数量} 收集方块（自动寻路+挖掘+捡拾）',
  'dig {"x":数字,"y":数字,"z":数字}         挖掉指定坐标的方块',
  'attack_nearest {}                      攻击附近的怪物',
  'wander {"on":true|false}               开/关自动巡逻闲逛',
  'eat {"on":true|false}                  开/关自动吃东西',
  'chat {"text":"要说的话"}                在游戏里说一句话',
  'get_status {}                          读取自身状态（无副作用）'
].join('\n')

const OUTPUT_RULES = [
  '只输出一个 JSON 对象，不要输出解释文字，也不要用 Markdown 代码块包裹。',
  '格式：{"reply":"要在游戏里说的话，没有就空字符串","actions":[{"name":"动作名","args":{}}]}',
  'reply 会以机器人身份发到游戏聊天栏，请简短自然、用中文、不超过 40 字。',
  'actions 最多 3 个；没有要做的事就返回空数组。',
  '方块名必须是英文 ID（如 oak_log、iron_ore、grass_block、diamond_ore）。',
  '坐标要用绝对坐标；不确定坐标时不要瞎编，可以先用 get_status 或在附近 collect。'
].join('\n')

// 从模型回复里尽量稳妥地抠出 JSON
function extractJson (text) {
  if (!text) return null
  let t = String(text).trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) t = fence[1].trim()
  try { return JSON.parse(t) } catch (_) { /* 继续尝试 */ }
  const s = t.indexOf('{')
  const e = t.lastIndexOf('}')
  if (s >= 0 && e > s) {
    try { return JSON.parse(t.slice(s, e + 1)) } catch (_) { /* 放弃 */ }
  }
  return null
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)

class AiAgent extends EventEmitter {
  constructor (player, client, options = {}) {
    super()
    this.player = player
    this.client = client
    this.name = options.name || 'bot'
    this.mode = 'off' // off | passive | autonomous
    this.intervalSec = options.intervalSec || 20
    this.trigger = options.trigger || 'name' // name | all
    this.history = []
    this.busy = false
    this.lastCallAt = 0
    this.callTimes = []
    this.consecutiveErrors = 0
    this._timer = null
    this.stats = { calls: 0, actions: 0, errors: 0 }
  }

  log (level, msg) {
    this.emit('log', level, `[AI:${this.name}] ${msg}`)
  }

  setMode (mode) {
    if (!['off', 'passive', 'autonomous'].includes(mode)) mode = 'off'
    this.mode = mode
    clearInterval(this._timer)
    this._timer = null
    if (mode === 'autonomous') {
      this._timer = setInterval(() => this.tickAutonomous(), this.intervalSec * 1000)
      this.log('info', `已开启 AI 自主游玩（每 ${this.intervalSec} 秒决策一次）`)
    } else if (mode === 'passive') {
      this.log('info', '已开启 AI 被动响应（有人跟它说话时才回应）')
    } else {
      this.log('info', 'AI 已关闭')
    }
  }

  stop () {
    clearInterval(this._timer)
    this._timer = null
  }

  // ---------- 上下文 ----------
  buildState () {
    const b = this.player.bot
    if (!b || !b.entity) return null
    const pos = b.entity.position
    const r = (n) => Math.round(n)

    const inv = {}
    try {
      for (const it of b.inventory.items()) inv[it.name] = (inv[it.name] || 0) + it.count
    } catch (_) { /* 背包还没加载 */ }
    const invTop = Object.entries(inv).sort((a, c) => c[1] - a[1]).slice(0, 12).map(([n, c]) => `${n}x${c}`)

    const players = []
    if (b.players) {
      for (const [nm, p] of Object.entries(b.players)) {
        if (nm === b.username) continue
        players.push(p.entity ? `${nm}(距离${r(p.entity.position.distanceTo(pos))}格)` : nm)
      }
    }

    const hostiles = []
    for (const e of Object.values(b.entities || {})) {
      if (!e || !e.position) continue
      const hostile = e.kind === 'Hostile mobs' || e.type === 'mob'
      if (!hostile) continue
      const d = e.position.distanceTo(pos)
      if (d <= 20) hostiles.push(`${e.name || e.displayName || '怪物'}(距离${r(d)}格)`)
    }

    return {
      position: { x: r(pos.x), y: r(pos.y), z: r(pos.z) },
      dimension: (b.game && b.game.dimension) || '未知',
      timeOfDay: b.time && b.time.timeOfDay < 13000 ? '白天' : '夜晚',
      health: typeof b.health === 'number' ? Math.round(b.health) : '未知',
      food: typeof b.food === 'number' ? Math.round(b.food) : '未知',
      held: b.heldItem ? b.heldItem.name : '空手',
      inventory: invTop.length ? invTop.join(', ') : '空',
      players: players.length ? players.join(', ') : '附近没有其他玩家',
      hostiles: hostiles.length ? hostiles.join(', ') : '附近没有怪物'
    }
  }

  buildSystemPrompt (mode, extra) {
    const s = this.buildState()
    const stateText = s
      ? [
          `位置: (${s.position.x}, ${s.position.y}, ${s.position.z})  维度: ${s.dimension}  时间: ${s.timeOfDay}`,
          `血量: ${s.health}/20  饥饿: ${s.food}/20  手持: ${s.held}`,
          `背包: ${s.inventory}`,
          `附近玩家: ${s.players}`,
          `附近怪物: ${s.hostiles}`
        ].join('\n')
      : '（机器人尚未进入世界）'

    return [
      `你是 Minecraft 机器人「${this.name}」的大脑，通过 Mineflayer 控制这个角色在服务器里活动。`,
      '',
      '【当前状态】',
      stateText,
      '',
      '【可用动作】',
      ACTIONS_HELP,
      '',
      '【输出要求】',
      OUTPUT_RULES,
      '',
      mode === 'autonomous'
        ? '【本轮任务】现在没有人指挥你，请自主决定接下来做什么（例如继续收集资源、跟随某个玩家、巡逻探索、躲避或攻击怪物）。如果确实无事可做，就返回空 actions。'
        : '【本轮任务】有玩家跟你说话，请理解意图并回应；如果他让你做事，就安排对应动作。'
    ].concat(extra ? ['', extra] : []).join('\n')
  }

  // ---------- 调用与执行 ----------
  async ask (userContent) {
    if (this.busy) return
    if (!this.client.configured) { this.log('warn', 'AI 未配置（缺 API Key 或模型名），已跳过'); return }
    if (!this.player.running || !this.player.bot || !this.player.bot.entity) return

    // 限频：每次调用至少间隔 1.2 秒，且每分钟不超过 12 次
    const now = Date.now()
    if (now - this.lastCallAt < 1200) return
    this.callTimes = this.callTimes.filter((t) => now - t < 60000)
    if (this.callTimes.length >= 12) { this.log('warn', 'AI 调用过于频繁，本轮跳过'); return }
    this.lastCallAt = now
    this.callTimes.push(now)

    this.busy = true
    try {
      const messages = [
        { role: 'system', content: this.buildSystemPrompt(this.mode) },
        ...this.history.slice(-8),
        { role: 'user', content: userContent }
      ]
      const raw = await this.client.chat(messages)
      this.stats.calls++

      const parsed = extractJson(raw)
      if (!parsed) {
        this.log('warn', '模型没有按 JSON 格式回复，原文：' + String(raw).slice(0, 160))
        this.history.push({ role: 'user', content: userContent })
        this.history.push({ role: 'assistant', content: String(raw).slice(0, 400) })
        return
      }

      // 记住对话，便于连续决策
      this.history.push({ role: 'user', content: userContent })
      this.history.push({ role: 'assistant', content: JSON.stringify({ reply: parsed.reply || '', actions: parsed.actions || [] }).slice(0, 400) })

      const reply = typeof parsed.reply === 'string' ? parsed.reply.trim() : ''
      if (reply) {
        this.player.sendChat(reply.slice(0, 200))
        this.log('chat', `说：${reply}`)
      }
      await this.executeActions(parsed.actions)
      this.consecutiveErrors = 0
    } catch (e) {
      this.stats.errors++
      this.consecutiveErrors++
      this.log('error', '调用失败: ' + e.message)
      if (this.consecutiveErrors >= 3) {
        this.log('error', '连续 3 次调用失败，已自动关闭该假人的 AI')
        this.setMode('off')
        this.emit('auto-off')
      }
    } finally {
      this.busy = false
    }
  }

  async executeActions (actions) {
    if (!Array.isArray(actions) || !actions.length) return
    for (const act of actions.slice(0, 3)) {
      if (!act || typeof act.name !== 'string') continue
      const args = act.args || {}
      try {
        const ok = await this.runAction(act.name, args)
        if (ok) this.stats.actions++
      } catch (e) {
        this.log('warn', `动作 ${act.name} 执行失败: ${e.message}`)
      }
    }
  }

  async runAction (name, a) {
    const p = this.player
    switch (name) {
      case 'walk_to': {
        if (!isNum(a.x) || !isNum(a.y) || !isNum(a.z)) { this.log('warn', 'walk_to 坐标不合法'); return false }
        p.walkTo(Math.round(a.x), Math.round(a.y), Math.round(a.z), 2)
        this.log('info', `执行 walk_to (${Math.round(a.x)}, ${Math.round(a.y)}, ${Math.round(a.z)})`)
        return true
      }
      case 'follow': {
        if (!a.player) { this.log('warn', 'follow 缺少 player'); return false }
        p.follow(String(a.player))
        this.log('info', `执行 follow ${a.player}`)
        return true
      }
      case 'stop':
        p.stopMoving(); this.log('info', '执行 stop'); return true
      case 'collect': {
        const blk = String(a.block || '').trim()
        if (!/^[a-z0-9_]+$/.test(blk)) { this.log('warn', 'collect 方块名不合法: ' + blk); return false }
        const count = Math.min(Math.max(Number(a.count) || 1, 1), 20)
        p.collect(blk, count, 64)
        this.log('info', `执行 collect ${blk} x${count}`)
        return true
      }
      case 'dig': {
        if (!isNum(a.x) || !isNum(a.y) || !isNum(a.z)) { this.log('warn', 'dig 坐标不合法'); return false }
        await p.dig(Math.round(a.x), Math.round(a.y), Math.round(a.z))
        this.log('info', '执行 dig')
        return true
      }
      case 'attack_nearest':
        await p.attackNearest(4)
        this.log('info', '执行 attack_nearest')
        return true
      case 'wander':
        p.setWander(a.on !== false); this.log('info', `执行 wander=${a.on !== false}`); return true
      case 'eat':
        p.setAutoEat(a.on !== false); this.log('info', `执行 eat=${a.on !== false}`); return true
      case 'chat': {
        const text = String(a.text || '').trim().slice(0, 200)
        if (!text) return false
        p.sendChat(text)
        this.log('chat', `说：${text}`)
        return true
      }
      case 'get_status': {
        const s = this.buildState()
        this.log('info', '状态: ' + (s ? `(${s.position.x}, ${s.position.y}, ${s.position.z}) 血${s.health} 饿${s.food} 背包[${s.inventory}]` : '未知'))
        return true
      }
      default:
        this.log('warn', '未知动作: ' + name)
        return false
    }
  }

  // ---------- 触发入口 ----------
  onChat (username, message) {
    if (this.mode !== 'passive' && this.mode !== 'autonomous') return
    if (this.mode === 'autonomous') return // 自主模式下不跟着聊天走，避免抢话
    const text = String(message || '')
    if (this.trigger === 'name') {
      if (!text.includes(this.name)) return
    }
    this.ask(`玩家「${username}」对你说：「${text}」\n请理解他的意图并回应；若他让你做事，安排对应动作。`)
  }

  tickAutonomous () {
    if (this.mode !== 'autonomous') return
    if (!this.player.running || !this.player.bot || !this.player.bot.entity) return
    if (this.player.collecting) return // 正在采集就等下一轮，避免打断
    this.ask('（自动决策轮次）请根据当前状态决定下一步做什么。')
  }
}

module.exports = { AiAgent, extractJson }
