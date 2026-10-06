// test/linux-check.js - Linux 可执行文件结构校验
// 说明：本机是 Windows，无法真正运行 Linux 二进制，此脚本做能做的结构级校验：
//   ELF 头/程序头/节头表是否完好（注入是否破坏了文件结构）、SEA 脚本是否真的注入进去了
// 用法: node test/linux-check.js <linux 可执行文件路径>
'use strict'

const fs = require('fs')

const file = process.argv[2]
if (!file) { console.error('用法: node test/linux-check.js <文件>'); process.exit(2) }
const b = fs.readFileSync(file)
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + detail : ''}`)
}

// ELF 头
check('ELF 魔数正确', b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46,
  'bytes=' + [...b.slice(0, 4)].map(x => x.toString(16)).join(' '))
check('64 位 ELF', b[4] === 2, 'class=' + b[4])
check('小端序', b[5] === 1)
const machine = b.readUInt16LE(18)
check('x86-64 架构', machine === 0x3e, 'e_machine=0x' + machine.toString(16))

// 程序头表 / 节头表边界校验（注入若破坏结构，这里会越界）
const phoff = Number(b.readBigUInt64LE(32))
const shoff = Number(b.readBigUInt64LE(40))
const phentsize = b.readUInt16LE(54)
const phnum = b.readUInt16LE(56)
const shentsize = b.readUInt16LE(58)
const shnum = b.readUInt16LE(60)
check('程序头表在文件范围内', phoff > 0 && phoff + phnum * phentsize <= b.length,
  `phoff=${phoff} phnum=${phnum} filesize=${b.length}`)
check('节头表在文件范围内', shoff === 0 || shoff + shnum * shentsize <= b.length,
  `shoff=${shoff} shnum=${shnum} shentsize=${shentsize}`)

// 节头表逐项校验：每节的偏移+大小都不能越界
let badSection = 0
if (shoff > 0 && shnum > 0 && shoff + shnum * shentsize <= b.length) {
  for (let i = 0; i < shnum; i++) {
    const off = shoff + i * shentsize
    const type = b.readUInt32LE(off + 4)
    if (type === 8) continue // SHT_NOBITS 不占文件空间
    const secOff = Number(b.readBigUInt64LE(off + 24))
    const secSize = Number(b.readBigUInt64LE(off + 32))
    if (secOff + secSize > b.length) badSection++
  }
}
check('所有节区偏移都在文件内', badSection === 0, '越界节数=' + badSection)

// SEA 注入校验
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'
const marker = Buffer.from('请确认本可执行文件与 app', 'utf8')
check('SEA 启动脚本已嵌入二进制', b.includes(marker))

// 与未注入的原始 node 对比：体积、fuse 标记数量都应与原始一致
// （注意：原始 node 本身就有 1 处 fuse 字符串，已验证可用的 Windows exe 同样是 1 处，不能用"必须为 0"判断）
const orig = process.env.ORIG_NODE
if (orig && fs.existsSync(orig)) {
  const ob = fs.readFileSync(orig)
  const origFuse = ob.toString('latin1').split(FUSE).length - 1
  const nowFuse = b.toString('latin1').split(FUSE).length - 1
  check('fuse 标记数量与原始 node 一致', nowFuse === origFuse, `原=${origFuse} 现=${nowFuse}`)
  check('体积与原始 node 基本一致', Math.abs(b.length - ob.length) < 5 * 1024 * 1024,
    `原=${(ob.length / 1048576).toFixed(1)}MB 现=${(b.length / 1048576).toFixed(1)}MB`)
}

const failed = results.filter(r => !r.ok).length
console.log(`\n通过 ${results.length - failed} / ${results.length}`)
process.exit(failed ? 1 : 0)
