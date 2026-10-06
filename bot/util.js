// bot/util.js - 共用小工具
'use strict'

// 允许把端口直接写在地址里，兼容这几种写法：
//   "1.2.3.4"            -> { host: '1.2.3.4', port: 传入的端口或 25565 }
//   "1.2.3.4:43042"      -> { host: '1.2.3.4', port: 43042 }   ← 地址里写的端口优先
//   "[2001:db8::1]:43042"-> { host: '2001:db8::1', port: 43042 }
//   "2001:db8::1"        -> { host: '2001:db8::1', port: 传入的端口或 25565 }（多冒号按 IPv6 处理）
//
// 注意：地址里的端口优先于独立的端口参数。因为界面的端口框通常带着默认值 25565，
// 而用户既然在地址里写了 :43042，那就是他的真实意图。
function splitHostPort (host, port) {
  let h = String(host == null ? '' : host).trim()
  let p = Number(port) || 0

  const bracket = /^\[([^\]]+)\]:(\d{1,5})$/.exec(h)
  if (bracket) {
    h = bracket[1]
    p = Number(bracket[2])
  } else {
    const parts = h.split(':')
    if (parts.length === 2 && /^\d{1,5}$/.test(parts[1])) {
      h = parts[0]
      p = Number(parts[1])
    }
  }
  return { host: h || '127.0.0.1', port: p || 25565 }
}

// 把网络错误翻译成人话，并给出针对性提示。rawHost 传用户原始输入，便于识别格式问题
function explainError (err, rawHost) {
  const msg = (err && err.message) || String(err)
  const code = (err && err.code) || ''
  const raw = String(rawHost == null ? '' : rawHost).trim()

  if (code === 'ENOTFOUND' || /ENOTFOUND/.test(msg)) {
    // 多冒号且不是 IPv6 的写法，通常是把端口/路径写串了
    const multiColon = raw.split(':').length > 2 && !raw.startsWith('[')
    const hint = multiColon
      ? '地址格式看起来不对（冒号过多）：正确写法是 --host 主机 --port 端口，例如 --host 1.2.3.4 --port 43042'
      : '域名/IP 解析失败：检查地址是否写错、能否 ping 通'
    return `连接失败：${msg}（${hint}）`
  }
  if (code === 'ECONNREFUSED' || /ECONNREFUSED/.test(msg)) {
    return `连接失败：${msg}（该端口没有服务在监听：确认端口、确认服务器已启动）`
  }
  if (code === 'ETIMEDOUT' || /ETIMEDOUT/.test(msg)) {
    return `连接失败：${msg}（连接超时：检查防火墙/云服务器安全组是否放行了这个端口）`
  }
  if (/not supported|unsupported/i.test(msg) && /version|protocol/i.test(msg)) {
    return `连接失败：${msg}（版本超出支持范围：请在界面/参数里手动指定一个更接近的版本，或升级本程序）`
  }
  return `连接失败：${msg}`
}

module.exports = { splitHostPort, explainError }
