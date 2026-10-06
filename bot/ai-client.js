// bot/ai-client.js - 统一 AI 客户端
// 支持两种后端：
//   1. openai —— 任何 OpenAI 兼容接口（DeepSeek / OpenAI / 通义 / Kimi / 硅基流动 / Ollama 的 /v1 等）
//   2. ollama —— 本地 Ollama 原生接口（http://127.0.0.1:11434/api/chat）
'use strict'

const http = require('http')
const https = require('https')

function request (url, { method = 'POST', headers = {}, body, timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    let u
    try { u = new URL(url) } catch (e) { return reject(new Error('接口地址不合法: ' + url)) }
    const lib = u.protocol === 'https:' ? https : http
    const data = body ? Buffer.from(JSON.stringify(body)) : null
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        data ? { 'Content-Length': data.length } : {},
        headers
      )
    }, (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { raw += c })
      res.on('end', () => resolve({ status: res.statusCode, body: raw }))
    })
    req.on('error', (e) => reject(new Error(`连接失败(${e.code || e.message})`)))
    req.setTimeout(timeout, () => { req.destroy(new Error('请求超时（' + timeout + 'ms）')) })
    if (data) req.write(data)
    req.end()
  })
}

const PRESETS = {
  openai: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  ollama: { baseUrl: 'http://127.0.0.1:11434', model: 'qwen2.5:7b' }
}

class AiClient {
  constructor (settings = {}) {
    this.setSettings(settings)
  }

  setSettings (s = {}) {
    const provider = s.provider === 'ollama' ? 'ollama' : 'openai'
    const preset = PRESETS[provider]
    this.provider = provider
    // 允许用户直接粘贴完整的 chat/completions 地址，这里统一裁掉
    let base = (s.baseUrl || preset.baseUrl).trim().replace(/\/+$/, '')
    base = base.replace(/\/chat\/completions$/, '')
    this.baseUrl = base
    this.apiKey = (s.apiKey || '').trim()
    this.model = (s.model || preset.model).trim()
    this.temperature = typeof s.temperature === 'number' ? s.temperature : 0.7
    this.maxTokens = s.maxTokens || 400
    this.timeout = s.timeout || 60000
  }

  get configured () {
    if (this.provider === 'ollama') return !!this.baseUrl && !!this.model
    return !!this.baseUrl && !!this.model && !!this.apiKey
  }

  describe () {
    return `${this.provider} | ${this.baseUrl} | ${this.model}`
  }

  // 返回模型回复的纯文本
  async chat (messages) {
    if (this.provider === 'ollama') {
      const { status, body } = await request(this.baseUrl + '/api/chat', {
        body: {
          model: this.model,
          messages,
          stream: false,
          options: { temperature: this.temperature }
        },
        timeout: this.timeout
      })
      if (status !== 200) throw new Error(`Ollama 返回 ${status}: ${String(body).slice(0, 200)}`)
      const j = JSON.parse(body)
      return (j.message && j.message.content) || ''
    }

    const { status, body } = await request(this.baseUrl + '/chat/completions', {
      headers: { Authorization: 'Bearer ' + this.apiKey },
      body: {
        model: this.model,
        messages,
        temperature: this.temperature,
        max_tokens: this.maxTokens,
        stream: false
      },
      timeout: this.timeout
    })
    if (status !== 200) throw new Error(`接口返回 ${status}: ${String(body).slice(0, 300)}`)
    const j = JSON.parse(body)
    const choice = (j.choices && j.choices[0]) || {}
    return (choice.message && choice.message.content) || ''
  }

  // 连通性自检，返回可读结果
  async test () {
    const reply = await this.chat([
      { role: 'system', content: '你是连通性测试助手。' },
      { role: 'user', content: '请只回复两个字：可用' }
    ])
    return String(reply).trim().slice(0, 50)
  }
}

module.exports = { AiClient, request, PRESETS }
