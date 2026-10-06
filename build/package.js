// build/package.js - 一键打包脚本
// 产出 6 份可分发包（每份一个 zip）：
//   命令行版  Windows / Linux      浏览器 WebUI 版  Windows / Linux      Electron 桌面版  Windows / Linux
//
// 用法：
//   node build/package.js                  # 全部打包
//   node build/package.js --only=cli       # 只打命令行版（win+linux）
//   node build/package.js --only=webui
//   node build/package.js --only=electron
//   node build/package.js --skip-deps      # 跳过依赖安装（复用缓存的生产依赖）
'use strict'

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const PROJ = path.resolve(__dirname, '..')
const CACHE = path.join(PROJ, 'build-cache')
const PROD = path.join(CACHE, 'prod')
const DIST = path.join(PROJ, 'dist')
const NODE_BIN = process.execPath
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'
const LINUX_TARBALL = path.join(CACHE, 'node-linux-x64.tar.xz')
const MIRROR_REGISTRY = 'https://registry.npmmirror.com'
const MIRROR_ELECTRON = 'https://npmmirror.com/mirrors/electron/'
const MIRROR_EB_BIN = 'https://npmmirror.com/mirrors/electron-builder-binaries/'

const argv = process.argv.slice(2)
const only = ((argv.find((a) => a.startsWith('--only=')) || '').split('=')[1]) || ''
const skipDeps = argv.includes('--skip-deps')

const summary = []

function log (msg) { console.log('\n=== ' + msg + ' ===') }
function info (msg) { console.log('  ' + msg) }

function run (cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit', ...opts })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`命令失败(${r.status}): ${cmd} ${cmdArgs.join(' ')}`)
}

function resolveBin (pkgName) {
  const pkgPath = path.join(PROJ, 'node_modules', pkgName, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  const bin = pkg.bin
  const rel = typeof bin === 'string' ? bin : (bin[pkgName] || Object.values(bin)[0])
  return path.join(PROJ, 'node_modules', pkgName, rel)
}

function dirSizeMB (dir) {
  if (!fs.existsSync(dir)) return 0
  let total = 0
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) { try { total += fs.statSync(p).size } catch (_) {} }
    }
  }
  walk(dir)
  return total / 1048576
}

function rmrf (p) { fs.rmSync(p, { recursive: true, force: true }) }

// ---------- 1. 准备生产依赖（真实目录、非符号链接，便于分发） ----------
function ensureProdDeps () {
  log('准备生产依赖')
  const pkg = JSON.parse(fs.readFileSync(path.join(PROJ, 'package.json'), 'utf8'))
  const prodPkg = {
    name: 'mc-auto-player-runtime',
    version: pkg.version,
    private: true,
    dependencies: pkg.dependencies
  }
  fs.mkdirSync(PROD, { recursive: true })
  fs.writeFileSync(path.join(PROD, 'package.json'), JSON.stringify(prodPkg, null, 2))
  fs.writeFileSync(path.join(PROD, '.npmrc'),
    `registry=${MIRROR_REGISTRY}\nnode-linker=hoisted\n`)

  if (skipDeps && fs.existsSync(path.join(PROD, 'node_modules'))) {
    info('已跳过安装（--skip-deps）')
    return
  }
  // node-linker=hoisted：生成真实目录而非 pnpm 的符号链接结构，否则分发包在别人机器上会指向不存在的路径
  // 用 pnpm 装（复用本地 store，快）；找不到 pnpm 时退回 npm
  const pnpmCmd = process.env.MC_PNPM
  const pnpmArgs = ['install', '--prod', '--ignore-workspace', '--config.node-linker=hoisted']
  try {
    if (pnpmCmd && fs.existsSync(pnpmCmd)) {
      run(NODE_BIN, [pnpmCmd].concat(pnpmArgs), { cwd: PROD })
    } else {
      run('pnpm', pnpmArgs, { cwd: PROD })
    }
  } catch (e) {
    info('pnpm 失败，改用 npm：' + e.message)
    rmrf(path.join(PROD, 'node_modules'))
    run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: PROD, shell: true })
  }
  info('生产依赖: ' + dirSizeMB(path.join(PROD, 'node_modules')).toFixed(0) + ' MB')
}

// 检查目录里是否残留符号链接（分发包不允许有，否则会指向构建机器的路径）
function countLinks (dir) {
  let n = 0
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isSymbolicLink()) { n++; continue }
      if (e.isDirectory()) walk(p)
    }
  }
  if (fs.existsSync(dir)) walk(dir)
  return n
}

// ---------- 2. 裁剪体积（基岩版数据 330MB 本项目完全用不到） ----------
function pruneModules () {
  log('裁剪依赖体积')
  const md = path.join(PROD, 'node_modules', 'minecraft-data', 'minecraft-data')

  // 基岩版各版本数据本项目用不到（300+MB），但 common 目录必须保留：
  // minecraft-data/lib/supportsFeature.js 会 require data/bedrock/common/features.json
  const bedrock = path.join(md, 'data', 'bedrock')
  let freed = 0
  if (fs.existsSync(bedrock)) {
    for (const e of fs.readdirSync(bedrock, { withFileTypes: true })) {
      if (e.isDirectory() && e.name !== 'common') {
        freed += dirSizeMB(path.join(bedrock, e.name))
        rmrf(path.join(bedrock, e.name))
      }
    }
    info(`已删除基岩版版本数据 (${freed.toFixed(0)} MB)，保留 bedrock/common`)
  }

  const targets = [
    path.join(md, 'doc'),
    path.join(md, 'tools'),
    path.join(md, '.github'),
    path.join(PROD, 'node_modules', 'minecraft-data', 'doc'),
    path.join(PROD, 'node_modules', 'minecraft-data', 'test'),
    path.join(PROD, 'node_modules', 'minecraft-data', '.github'),
    path.join(PROD, 'node_modules', '.bin'),
    path.join(PROD, 'node_modules', '.modules.yaml')
  ]
  for (const t of targets) {
    if (fs.existsSync(t)) { rmrf(t) }
  }
  info('裁剪后: ' + dirSizeMB(path.join(PROD, 'node_modules')).toFixed(0) + ' MB')
}

// ---------- 3. 取出 Linux 版 Node 运行时 ----------
function ensureLinuxNode () {
  log('准备 Linux Node 运行时')
  const found = fs.existsSync(CACHE)
    ? fs.readdirSync(CACHE).find((n) => n.startsWith('node-v') && n.endsWith('-linux-x64'))
    : null
  const dir = found ? path.join(CACHE, found) : null
  if (dir && fs.existsSync(path.join(dir, 'bin', 'node'))) {
    info('已存在: ' + path.relative(PROJ, dir))
    return path.join(dir, 'bin', 'node')
  }
  if (!fs.existsSync(LINUX_TARBALL)) {
    throw new Error(`缺少 Linux Node 压缩包：${LINUX_TARBALL}\n请先下载，例如：\n  curl -L -o "${LINUX_TARBALL}" https://npmmirror.com/mirrors/node/v24.21.0/node-v24.21.0-linux-x64.tar.xz`)
  }
  run('tar', ['-xJf', LINUX_TARBALL, '-C', CACHE])
  const d2 = fs.readdirSync(CACHE).find((n) => n.startsWith('node-v') && n.endsWith('-linux-x64'))
  const node = path.join(CACHE, d2, 'bin', 'node')
  if (!fs.existsSync(node)) throw new Error('解压后找不到 bin/node')
  info('解压完成: ' + path.relative(PROJ, node))
  return node
}

// ---------- 4. 生成 SEA 单文件可执行程序 ----------
function buildSea (entryName, outFile, baseBinary, label) {
  const cfgPath = path.join(CACHE, `sea-${label}.json`)
  const blobPath = path.join(CACHE, `sea-${label}.blob`)
  fs.writeFileSync(cfgPath, JSON.stringify({
    main: path.join('build', entryName),
    output: path.relative(PROJ, blobPath).replace(/\\/g, '/'),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false
  }, null, 2))
  run(NODE_BIN, ['--experimental-sea-config', cfgPath], { cwd: PROJ })
  fs.copyFileSync(baseBinary, outFile)
  run(NODE_BIN, [resolveBin('postject'), outFile, 'NODE_SEA_BLOB', blobPath,
    '--sentinel-fuse', FUSE], { cwd: PROJ })
  return outFile
}

// ---------- 5. 组装一个包 ----------
const APP_FILES = {
  cli: ['cli.js', 'bot', 'package.json'],
  webui: ['cli.js', 'bot', 'web', 'renderer', 'package.json']
}
// 各平台的一键脚本也一起带上（macOS / Termux）
const APP_EXTRA_DIRS = ['scripts']

// 随包分发的文档
const PACK_DOCS = ['CHANGELOG.md', '版本介绍.md', '使用方案.md']

function copyPackDocs (dest) {
  for (const doc of PACK_DOCS) {
    const src = path.join(PROJ, doc)
    if (fs.existsSync(src)) fs.cpSync(src, path.join(dest, doc))
  }
}

function readmeText (variant, platform) {
  const isWin = platform === 'win-x64'
  const exeName = isWin ? 'mc-auto-player.exe' : './mc-auto-player'
  const lines = []
  lines.push('MC 自动玩家 - ' + (variant === 'cli' ? '命令行版' : '浏览器 WebUI 版'))
  lines.push('平台: ' + (isWin ? 'Windows x64' : 'Linux x64'))
  lines.push('适配 Minecraft Java 版 1.21.11（协议 774）')
  lines.push('')
  lines.push('【目录说明】')
  lines.push('  ' + (isWin ? 'mc-auto-player.exe' : 'mc-auto-player') + '   可执行程序（已内置 Node 运行时）')
  lines.push('  app/                程序本体')
  lines.push('  node_modules/       运行依赖（已裁剪，勿删）')
  lines.push('  使用说明.txt         本文件')
  lines.push('  CHANGELOG.md        更新日志：每个版本改了什么、修了什么问题')
  lines.push('  版本介绍.md          6 个分发包的对比、适用场景与选择建议')
  lines.push('')
  if (variant === 'cli') {
    lines.push('【使用方法】')
    if (isWin) {
      lines.push('  在本文件夹打开命令行（地址栏输入 cmd 回车），然后执行：')
      lines.push('    mc-auto-player.exe --host 服务器IP --port 25565 --user Bot --version 1.21.11')
      lines.push('  一次开多个假人（Bot1..Bot5）：')
      lines.push('    mc-auto-player.exe --host 服务器IP --user Bot --count 5')
      lines.push('  接入大模型，让 AI 能对话并操控假人：')
      lines.push('    mc-auto-player.exe --host 服务器IP --user Bot --count 3 --ai-mode passive --ai-key sk-xxxx')
    } else {
      lines.push('  先赋予执行权限（zip 解压可能丢失权限位）：')
      lines.push('    chmod +x mc-auto-player')
      lines.push('  然后运行：')
      lines.push('    ./mc-auto-player --host 服务器IP --port 25565 --user Bot --version 1.21.11')
      lines.push('  一次开多个假人：./mc-auto-player --host 服务器IP --user Bot --count 5')
      lines.push('  接大模型：./mc-auto-player --host 服务器IP --user Bot --ai-mode passive --ai-key sk-xxxx')
    }
    lines.push('')
    lines.push('【端口写法】')
    lines.push('  以下两种写法都可以，程序会自动识别：')
    lines.push('    --host 1.2.3.4 --port 43042       （推荐，分开写最清晰）')
    lines.push('    --host 1.2.3.4:43042              （端口直接写在地址里，也会自动拆开）')
    lines.push('  注意：地址里带了端口时，以地址里的端口为准（--port 会被忽略）。')
    lines.push('')
    lines.push('【假人管理指令】')
    lines.push('  /bots                    查看所有假人与状态')
    lines.push('  /use 名字                切换当前操作的假人')
    lines.push('  /start [名字] /stop [名字]   单个上线/下线')
    lines.push('  /startall /stopall       一键全部上线/下线')
    lines.push('  /ai off|passive|autonomous [名字]   设置该假人的 AI 模式')
    lines.push('')
    lines.push('【机器人操作指令】')
    lines.push('  /walk x y z         走到坐标        /follow 玩家名   跟随玩家')
    lines.push('  /stopmove           停止移动        /collect 方块 数量  收集方块')
    lines.push('  /dig x y z          挖掉方块        /attack          攻击附近怪物')
    lines.push('  /give 物品 数量      丢出物品        /status          查看状态')
    lines.push('  /eat on|off         自动吃东西      /armor on|off    自动穿护甲')
    lines.push('  /wander on|off      自动巡逻        /quit            退出')
    lines.push('  直接输入其它文字 = 以当前假人身份在游戏里发言')
  } else {
    lines.push('【使用方法】')
    if (isWin) {
      lines.push('  直接双击 mc-auto-player.exe —— 会自动启动服务并打开浏览器控制面板。')
      lines.push('  也可以带参数自定义端口：mc-auto-player.exe --port 9000')
    } else {
      lines.push('  先赋予执行权限（zip 解压可能丢失权限位）：')
      lines.push('    chmod +x mc-auto-player')
      lines.push('  然后运行（--open 会尝试用浏览器打开，无桌面环境可省略）：')
      lines.push('    ./mc-auto-player --port 8686 --open')
    }
    lines.push('')
    lines.push('  然后在浏览器访问 http://本机IP:8686 即可看到控制面板。')
    lines.push('  服务器场景可加 --bind 0.0.0.0 让同网段其它电脑访问（注意别暴露到公网）。')
    lines.push('  面板里的「服务器地址」可以直接写 1.2.3.4:43042，程序会自动拆分出端口。')
    lines.push('')
    lines.push('【控制面板能做什么】')
    lines.push('  1. 批量添加假人：填「名字前缀 / 起始编号 / 数量」，点「批量添加并上线」一次上线多个')
    lines.push('  2. AI 设置：接入方式选 OpenAI 兼容（DeepSeek 填 API Key 即可）或本地 Ollama，')
    lines.push('     点「测试连接」确认可用；每个假人可在列表里单独选 AI 关闭 / 被动响应 / 自主游玩')
    lines.push('  3. 假人列表：实时血量、饥饿、坐标、在线玩家、AI 调用次数，可单独上线下线移除')
    lines.push('  4. 手动操作：对选中的假人发言、寻路、跟随、收集、挖掘、攻击、开关自动行为')
    lines.push('  5. 假人列表与 AI 设置会保存到程序同目录的 mc-auto-player-settings.json')
  }
  lines.push('')
  lines.push('【重要】')
  lines.push('  游戏版本必须与界面/参数里选择的版本一致，否则无法连接。')
  lines.push('  离线服务器（online-mode=false）直接填名字即可；正版服务器需用 --auth microsoft。')
  lines.push('  请只在你拥有权限的服务器上使用。')
  return lines.join('\r\n') + '\r\n'
}

function assemble (variant, platform, linuxNodePath) {
  const name = `${variant}-${platform}`
  log(`组装 ${name}`)
  const stage = path.join(DIST, `mc-auto-player-${name}`)
  rmrf(stage)
  fs.mkdirSync(path.join(stage, 'app'), { recursive: true })

  for (const f of APP_FILES[variant].concat(APP_EXTRA_DIRS)) {
    const src = path.join(PROJ, f)
    if (!fs.existsSync(src)) continue
    const dst = path.join(stage, 'app', f)
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.cpSync(src, dst, { recursive: true })
  }

  info('复制运行依赖...')
  // dereference: true —— 把符号链接展开成真实文件，保证分发包自包含
  fs.cpSync(path.join(PROD, 'node_modules'), path.join(stage, 'node_modules'), { recursive: true, dereference: true })
  const links = countLinks(path.join(stage, 'node_modules'))
  if (links > 0) throw new Error(`打包目录里残留 ${links} 个符号链接，会导致分发后无法运行`)
  info('依赖已展开为真实文件，体积 ' + dirSizeMB(path.join(stage, 'node_modules')).toFixed(0) + ' MB')

  const isWin = platform === 'win-x64'
  const outExe = path.join(stage, isWin ? 'mc-auto-player.exe' : 'mc-auto-player')
  const base = isWin ? NODE_BIN : linuxNodePath
  buildSea(variant === 'cli' ? 'sea-cli.js' : 'sea-web.js', outExe, base, `${variant}-${platform}`)
  info('可执行程序: ' + path.basename(outExe) + ' (' + (fs.statSync(outExe).size / 1048576).toFixed(0) + ' MB)')

  fs.writeFileSync(path.join(stage, '使用说明.txt'), readmeText(variant, platform), 'utf8')
  copyPackDocs(stage)

  if (!isWin) {
    fs.writeFileSync(path.join(stage, 'start.sh'),
      '#!/bin/sh\ncd "$(dirname "$0")"\nchmod +x ./mc-auto-player 2>/dev/null\n' +
      (variant === 'cli'
        ? './mc-auto-player "$@"\n'
        : './mc-auto-player --port 8686 --bind 0.0.0.0 "$@"\n'), 'utf8')
  }

  const zip = path.join(DIST, `mc-auto-player-${name}.zip`)
  rmrf(zip)
  info('压缩 zip...')
  run('tar', ['-a', '-c', '-f', zip, '-C', DIST, path.basename(stage)])
  const zipMB = fs.statSync(zip).size / 1048576
  info(`完成: dist/${path.basename(zip)} (${zipMB.toFixed(0)} MB)`)
  summary.push({ name: `mc-auto-player-${name}.zip`, mb: zipMB })
}

// ---------- 6. Electron 桌面版 ----------
function buildElectron () {
  log('打包 Electron 桌面版')
  const pkg = JSON.parse(fs.readFileSync(path.join(PROJ, 'package.json'), 'utf8'))
  const stage = path.join(CACHE, 'electron-app')
  // --skip-deps 且依赖已就绪时复用，避免每次重新下载几百 MB
  const reuseDeps = skipDeps && fs.existsSync(path.join(stage, 'node_modules', 'electron'))
  if (reuseDeps) {
    info('复用已有依赖（--skip-deps）')
    for (const f of ['main.js', 'preload.js', 'bot', 'renderer']) rmrf(path.join(stage, f))
  } else {
    rmrf(stage)
  }
  fs.mkdirSync(stage, { recursive: true })

  for (const f of ['main.js', 'preload.js', 'bot', 'renderer']) {
    fs.cpSync(path.join(PROJ, f), path.join(stage, f), { recursive: true })
  }

  const stagePkg = {
    name: 'mc-auto-player',
    productName: 'MC自动玩家',
    version: pkg.version,
    description: pkg.description,
    author: 'mc-auto-player',
    main: 'main.js',
    license: 'MIT',
    dependencies: pkg.dependencies,
    devDependencies: { electron: pkg.devDependencies.electron },
    build: {
      appId: 'com.mcautoplayer.app',
      productName: 'MC自动玩家',
      directories: { output: 'output' },
      npmRebuild: false,
      files: ['main.js', 'preload.js', 'bot/**/*', 'renderer/**/*', 'package.json'],
      win: { target: ['portable', 'nsis'] },
      nsis: { oneClick: false, allowToChangeInstallationDirectory: true, createDesktopShortcut: true },
      // AppImage 只能在 Linux/macOS 主机上构建（Windows 上 electron-builder 会去调用 macOS 版 mksquashfs 而失败），
      // 所以在 Windows 上打 Linux 包时只出 tar.gz（内容一致，解压即用）
      linux: {
        target: process.platform === 'win32' ? ['tar.gz'] : ['AppImage', 'tar.gz'],
        category: 'Game'
      }
    }
  }
  fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(stagePkg, null, 2))
  fs.writeFileSync(path.join(stage, '.npmrc'), `registry=${MIRROR_REGISTRY}\n`)

  // 关键：这里必须用 npm 安装。
  // electron-builder 会按"检测到的包管理器"来收集生产依赖：目录里有 pnpm-lock 就会走 pnpm 收集器，
  // 而 pnpm 不在 PATH 时收集器会静默失败（No JSON content found）。npm 的扁平 node_modules 最稳。
  if (!reuseDeps) {
    info('用 npm 安装依赖（含 electron）...')
    run('npm', ['install', '--no-audit', '--no-fund'], { cwd: stage, shell: true, env: { ...process.env, npm_config_registry: MIRROR_REGISTRY } })
    for (const stray of ['pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
      rmrf(path.join(stage, stray))
    }
    const badLinks = countLinks(path.join(stage, 'node_modules'))
    info(`依赖安装完成，符号链接数=${badLinks}`)

    // npm 会把完整的 minecraft-data（含 330MB 基岩版数据）装回来，这里再裁一次
    const mdSub = path.join(stage, 'node_modules', 'minecraft-data', 'minecraft-data')
    const bedrock = path.join(mdSub, 'data', 'bedrock')
    if (fs.existsSync(bedrock)) {
      for (const e of fs.readdirSync(bedrock, { withFileTypes: true })) {
        if (e.isDirectory() && e.name !== 'common') rmrf(path.join(bedrock, e.name))
      }
      info('已再次裁剪基岩版数据，node_modules=' + dirSizeMB(path.join(stage, 'node_modules')).toFixed(0) + ' MB')
    }
  }

  const env = {
    ...process.env,
    ELECTRON_MIRROR: MIRROR_ELECTRON,
    ELECTRON_BUILDER_BINARIES_MIRROR: MIRROR_EB_BIN,
    npm_config_registry: MIRROR_REGISTRY
  }
  // 关键：先清掉上一次的产物，否则旧版本（如 0.1.0）会和本次一起被打进 zip，体积翻倍
  rmrf(path.join(stage, 'output'))
  info('调用 electron-builder（Windows + Linux）...')
  const ebBin = resolveBin('electron-builder')
  for (const plat of ['--win', '--linux']) {
    try {
      run(NODE_BIN, [ebBin, plat, '--publish', 'never'], { cwd: stage, env })
    } catch (e) {
      info(`electron-builder ${plat} 失败: ${e.message}`)
    }
  }

  // 收集产物并按平台打 zip
  const outDir = path.join(stage, 'output')
  if (!fs.existsSync(outDir)) { info('未生成任何 Electron 产物'); return }
  const files = fs.readdirSync(outDir).filter((f) => !f.endsWith('.zip') && !f.endsWith('.blockmap') && !f.endsWith('.yml'))
  info('产物: ' + files.join(', '))

  const groups = {
    'electron-win-x64': files.filter((f) => f.endsWith('.exe')),
    'electron-linux-x64': files.filter((f) => f.endsWith('.AppImage') || f.endsWith('.tar.gz'))
  }
  const unpackedFor = {
    'electron-win-x64': 'win-unpacked',
    'electron-linux-x64': 'linux-unpacked'
  }
  for (const [name, list] of Object.entries(groups)) {
    const pack = path.join(DIST, `mc-auto-player-${name}`)
    rmrf(pack)
    fs.mkdirSync(pack, { recursive: true })
    for (const f of list) fs.cpSync(path.join(outDir, f), path.join(pack, f))

    // 安装包目标失败时退回"绿色版"：把 electron-builder 生成的解压目录整包带上，里面同样有可执行文件
    if (!list.length) {
      const un = path.join(outDir, unpackedFor[name])
      if (!fs.existsSync(un)) { info(`${name}: 无任何产物，跳过`); rmrf(pack); continue }
      info(`${name}: 未生成安装包，改为打包绿色版目录`)
      fs.cpSync(un, path.join(pack, 'green-version'), { recursive: true })
    }

    fs.writeFileSync(path.join(pack, '使用说明.txt'),
      (name.includes('win')
        ? 'Windows 桌面版（Electron 图形界面）\r\n\r\n' +
          '- 「MC自动玩家 *.exe」（portable）：免安装版，双击即用。\r\n' +
          '- 「MC自动玩家 Setup *.exe」（nsis）：安装程序，可选安装目录、创建桌面快捷方式。\r\n' +
          '- green-version/ 目录：绿色版，进目录双击「MC自动玩家.exe」。\r\n'
        : 'Linux 桌面版（Electron 图形界面）\r\n\r\n' +
          '- AppImage：chmod +x 后运行（./MC自动玩家-*.AppImage）。\r\n' +
          '- tar.gz：解压后运行其中的可执行文件。\r\n' +
          '- green-version/ 目录：绿色版，运行其中的 mc-auto-player 可执行文件。\r\n' +
          '- 需要图形桌面环境（X11/Wayland），纯命令行服务器请用 WebUI 版。\r\n') +
      '\r\n适配 Minecraft Java 版 1.21.11（协议 774）。请只在你拥有权限的服务器上使用。\r\n', 'utf8')
    copyPackDocs(pack)
    const zip = path.join(DIST, `mc-auto-player-${name}.zip`)
    rmrf(zip)
    run('tar', ['-a', '-c', '-f', zip, '-C', DIST, path.basename(pack)])
    const zipMB = fs.statSync(zip).size / 1048576
    info(`完成: dist/${path.basename(zip)} (${zipMB.toFixed(0)} MB)`)
    summary.push({ name: `mc-auto-player-${name}.zip`, mb: zipMB })
  }
}

// ---------- 主流程 ----------
function main () {
  fs.mkdirSync(CACHE, { recursive: true })
  fs.mkdirSync(DIST, { recursive: true })

  ensureProdDeps()
  pruneModules()

  const want = (v) => !only || only === v
  let linuxNode = null
  if (want('cli') || want('webui')) linuxNode = ensureLinuxNode()

  if (want('cli')) {
    assemble('cli', 'win-x64', linuxNode)
    assemble('cli', 'linux-x64', linuxNode)
  }
  if (want('webui')) {
    assemble('webui', 'win-x64', linuxNode)
    assemble('webui', 'linux-x64', linuxNode)
  }
  if (want('electron')) buildElectron()

  log('打包完成')
  for (const s of summary) info(`${s.name}  ${s.mb.toFixed(0)} MB`)
  console.log('\n产物目录: ' + DIST)
}

main()
