# MC 自动玩家（mc-auto-player）

模拟玩家自动在你的 Minecraft Java 版服务器里游玩，支持**多假人**与**AI 对话/操控**。
基于 **Mineflayer**（机器人核心），提供三种运行形态：命令行、浏览器 WebUI、Electron 桌面版。

**Minecraft 版本：1.12 ~ 26.1 全支持，且不用你手填** —— 连接时自动 ping 服务器识别版本（实测 1.21.11 耗时 1.4 秒）。
实测通过：1.12.2 / 1.16.5 / 1.20.4 / 1.21.11 / 26.1；26.2、26.3 因上游库尚无协议数据暂不支持（见 [使用方案.md](使用方案.md#13-262--263-为什么不行)）。

> 📖 **各平台怎么用（Windows / Linux / macOS / 安卓 / iPhone-iPad），看 [使用方案.md](使用方案.md)**
> 📦 每个分发包里有什么，看 [版本介绍.md](版本介绍.md)　🧾 每个版本改了什么，看 [CHANGELOG.md](CHANGELOG.md)

## 功能

**机器人能力**
- 连接 / 断开服务器（离线模式或正版微软账号），支持同时开多个假人
- 实时状态：血量、饥饿、坐标、维度、在线玩家
- 寻路走动、跟随玩家、停止移动
- 自动收集方块（自动寻路 + 选工具 + 挖掘 + 捡掉落物）
- 挖掘指定坐标方块、丢弃物品、攻击附近怪物
- 自动吃东西、自动穿护甲、自动巡逻（防 AFK 踢）
- 游戏内聊天指令（任何人可指挥，见下文指令表）

**AI 能力（可选）**
- 支持 **OpenAI 兼容接口**（DeepSeek / OpenAI / 通义 / Kimi / 硅基流动…）与**本地 Ollama**，界面下拉切换
- **被动响应**：玩家叫它名字跟它说话，AI 理解意图并回应、执行
- **自主游玩**：每隔 N 秒自己决策下一步做什么（收集资源、巡逻、跟随、打怪）
- AI 能看到假人的实时状态（坐标/血量/背包/附近玩家与怪物），并且**只能通过白名单动作**操作假人

**多假人**
- 批量生成：名字前缀 + 起始编号 + 数量 → 一次上线 N 个（最多 20）
- 一键全部上线 / 全部下线 / 清空；也可对单个假人上线下线
- 每个假人可单独设置 AI 模式（关闭 / 被动 / 自主）
- 假人列表与 AI 设置会持久化保存

## 目录结构

```
mc-auto-player/
├── main.js               Electron 主进程（IPC 桥接）
├── preload.js            安全桥（contextBridge）
├── cli.js                命令行入口（多假人 + AI）
├── bot/
│   ├── auto-player.js    单个假人核心（连接/寻路/行为/聊天指令）
│   ├── manager.js        多假人管理器（批量创建/一键启停/配置持久化）
│   ├── ai-client.js      AI 客户端（OpenAI 兼容 + Ollama 双后端）
│   └── ai-agent.js       每个假人的 AI 智能体（决策解析 + 动作执行）
├── web/
│   └── server.js         WebUI 服务端（浏览器控制面板）
├── renderer/             界面（Electron 与 WebUI 共用同一套）
├── build/
│   └── package.js        一键打包脚本（6 种包）
├── test/                 各种校验脚本（见下文）
└── package.json
```

## 快速开始

要求：Node.js 20+（本项目在 Node v24 上验证通过）。从项目目录执行：

```bash
npm install        # 或 pnpm install
npm start          # 启动 Electron 桌面版
npm run webui      # 启动浏览器版（打开 http://localhost:8686）
```

> 国内网络：仓库已附带 `.npmrc`（npmmirror 镜像 + Electron 二进制镜像），直接安装即可。
> 若用 pnpm，Electron 的安装脚本需要在 `pnpm-workspace.yaml` 的 `allowBuilds` 中放行（仓库已配置好）。

## AI 对话与操控机器人

### 1. 配置

界面里点「AI 设置」，选接入方式：

| 接入方式 | 接口地址 | 模型名示例 |
|---|---|---|
| OpenAI 兼容（云端） | `https://api.deepseek.com/v1`（DeepSeek）/ `https://api.openai.com/v1` / 其它厂商的兼容地址 | `deepseek-chat` / `gpt-4o-mini` |
| 本地 Ollama | `http://127.0.0.1:11434` | `qwen2.5:7b`、`llama3.1:8b` 等 |

填好 API Key 后点「测试连接」，显示 ✅ 即配置成功。

### 2. 两种工作方式

- **被动响应**：触发条件可选「只有叫它名字才回应」或「所有聊天都回应」。玩家说「Bot1 去挖点木头」，AI 会理解并安排 `collect oak_log`。
- **自主游玩**：每隔 N 秒（默认 20 秒，限频不低于 5 秒）让 AI 结合当前状态决定下一步，例如继续收集资源、跟随玩家、巡逻探索、攻击靠近的怪物。

### 3. AI 能做什么（白名单动作）

| 动作 | 说明 |
|---|---|
| `walk_to {x,y,z}` | 走到指定坐标 |
| `follow {player}` | 跟随某个玩家 |
| `stop {}` | 停止移动 |
| `collect {block,count}` | 收集方块（自动寻路+挖掘+捡拾） |
| `dig {x,y,z}` | 挖掉指定坐标方块 |
| `attack_nearest {}` | 攻击附近怪物 |
| `wander {on}` / `eat {on}` | 开关自动巡逻 / 自动吃东西 |
| `chat {text}` | 在游戏里说话 |
| `get_status {}` | 读取自身状态（无副作用） |

AI 的回复被限制为一个 JSON 对象（`{"reply":"...","actions":[...]}`），由 `bot/ai-agent.js` 校验后才执行：动作最多 3 个、方块名必须是合法英文 ID、坐标必须是数字——**模型无法执行白名单之外的操作**。

### 4. 成本与保护

- 每个假人每次调用至少间隔 1.2 秒，每分钟最多 12 次，避免刷接口。
- 连续 3 次调用失败会自动关闭该假人的 AI，避免无脑重试烧钱。
- 提示词里带上了实时状态，模型不用瞎猜坐标。

## 命令行模式（推荐先用它验证连接）

```bash
# 单个假人
node cli.js --host 你的服务器IP --port 25565 --user Bot --version 1.21.11

# 一次开 5 个假人（Bot1..Bot5）
node cli.js --host 你的服务器IP --user Bot --count 5

# 接大模型：3 个假人 + 被动响应
node cli.js --host 你的服务器IP --user Bot --count 3 --ai-mode passive \
  --ai-key sk-xxxxxx --ai-model deepseek-chat
```

进入后可用的指令：

```
/walk x y z          走到坐标
/follow 玩家名        跟随玩家
/stop                停止移动
/collect iron_ore 5  收集 5 个铁矿石
/dig x y z           挖掉指定方块
/eat on|off          自动吃东西
/armor on|off        自动穿护甲
/wander on|off       自动巡逻闲逛
/status              打印当前状态
/quit                退出
直接输入其它文字 = 以机器人身份在游戏里发言
```

## 端到端测试（可选，自证功能正常）

项目自带 17 项端到端测试，覆盖连接、寻路、跟随、聊天指令、采集、开关等。
需要一个本地 1.21.11 服务端（`server.properties` 里 `online-mode=false`、`enforce-secure-profile=false`、`spawn-protection=0`）：

```bash
java -Xmx2G -jar server.jar nogui      # 在测试服目录
node test/e2e.js                       # 在项目目录，默认连 127.0.0.1:25566
```

> 超平坦世界务必显式写 `generator-settings`，否则会生成"空世界"，机器人会掉进虚空：
> `generator-settings={"layers":[{"block":"minecraft:bedrock","height":1},{"block":"minecraft:dirt","height":3},{"block":"minecraft:grass_block","height":1}],"biome":"minecraft:plains"}`

## 使用说明

1. 填服务器地址 / 端口 / 登录方式。**游戏版本保持「自动探测」即可** —— 程序会自己识别服务器版本（1.12 ~ 26.1 都能自动适配），不需要你手填。
2. 填「名字前缀 + 数量」，点「**⚡ 一键上线**」一次上线多个假人（例如 Bot1、Bot2、Bot3）。
   - 名字会自动去重，不用怕重名互踢。
   - 常用的服务器可以点「💾 保存为预设」存下来，下次下拉选一下就自动填好。
   - 登录方式：**离线模式**（服务器 `online-mode=false`，国内服务器大多是这种）直接填名字即可；**正版微软账号**会显示设备代码，打开 https://microsoft.com/link 输入登录，之后自动缓存登录态。
3. 在假人列表里可以看到每个假人的血量、饥饿、坐标、**实际探测到的服务器版本**、在线玩家数与 AI 调用次数，并按需上线/下线/移除。
4. 想用 AI：先在「AI 设置」里填好接口与 API Key，点「测试连接」，再在每个假人的下拉框里选 **AI 被动** 或 **AI 自主**。
5. 「手动操作」区可以对选中的假人发言、寻路、跟随、收集、挖掘、攻击、开关自动行为。

## 游戏内聊天指令（任何人都可对机器人发）

| 指令 | 作用 |
|---|---|
| `来` / `come` | 走到说话玩家身边并跟随 |
| `停` / `stop` | 停止移动 |
| `去 X Y Z` / `goto X Y Z` | 走到指定坐标 |
| `挖 iron_ore 10` / `collect iron_ore 10` | 收集 10 个铁矿石（方块名用英文 ID，可在 Minecraft Wiki 查） |
| `给 diamond 3` / `give diamond 3` | 丢出 3 个钻石 |
| `状态` / `status` | 机器人报告血量、饥饿、位置 |

## 打包分发（6 种包）

一条命令产出全部 6 个 zip（命令行版 / 浏览器 WebUI 版 / Electron 桌面版，各 Windows + Linux）：

```bash
node build/package.js              # 全部
node build/package.js --only=cli   # 只打命令行版（win+linux）
node build/package.js --only=webui
node build/package.js --only=electron
node build/package.js --skip-deps  # 复用已装好的生产依赖，快很多
```

打包前需要准备 Linux 版 Node 运行时（脚本会自动解压，缺失时会提示下载地址）：

```bash
curl -L -o build-cache/node-linux-x64.tar.xz \
  https://npmmirror.com/mirrors/node/v24.21.0/node-v24.21.0-linux-x64.tar.xz
```

### 产物与实测状态

| 压缩包 | 大小 | 内容 | 实测状态 |
|---|---|---|---|
| `mc-auto-player-cli-win-x64.zip` | ~47 MB | `mc-auto-player.exe`（双击可用）+ `app/` + `node_modules/` | ✅ 已实测：解压后连真实 1.21.11 服成功 |
| `mc-auto-player-cli-linux-x64.zip` | ~55 MB | `mc-auto-player`（ELF）+ `start.sh` | ⚠️ 结构校验 10/10 通过，未能在真机运行（本机无 Linux 环境） |
| `mc-auto-player-webui-win-x64.zip` | ~47 MB | `mc-auto-player.exe`（双击自动开浏览器）| ✅ 已实测：网页控制连接/断开/寻路全通 |
| `mc-auto-player-webui-linux-x64.zip` | ~55 MB | `mc-auto-player` + `start.sh` | ⚠️ 结构校验 10/10 通过，未能在真机运行 |
| `mc-auto-player-electron-win-x64.zip` | ~198 MB | 免安装 exe + NSIS 安装包 | ⚠️ 已在受限终端里无法启动 Chromium（环境所致），app.asar 内容已核对 |
| `mc-auto-player-electron-linux-x64.zip` | ~122 MB | **tar.gz**（绿色版，解压即用）| ⚠️ 未能在真机运行 |

关于 Electron Linux 包：**AppImage 只能在 Linux/macOS 主机上构建**（Windows 上 electron-builder 会调用 macOS 版 mksquashfs 而失败），所以 Windows 主机打出来的是 tar.gz；需要 AppImage 请在 Linux 上执行 `npm run pack`。

### 打包脚本做了什么（踩过的坑）

1. **依赖必须是真实文件，不能是符号链接**：pnpm 默认的 `.pnpm` 结构全是软链，直接拷进分发包会出现"在别人机器上指向你的构建目录"。脚本强制 `node-linker=hoisted` 并在复制时 `dereference`，最后还会断言包内符号链接数为 0。
2. **裁剪体积**：`minecraft-data` 里有 332 MB 基岩版数据（本项目是 Java 版，用不到），但 **`data/bedrock/common/` 必须保留**——`minecraft-data/lib/supportsFeature.js` 会 require 它的 `features.json`，整个删掉会导致启动即崩。裁剪后单包依赖从 447 MB 降到 115 MB。
3. **Windows exe 用 Node SEA 生成**：`node --experimental-sea-config` 生成 blob，再用 `postject` 注入到 node 二进制里，得到一个真正可双击的 exe（内部已含 Node 运行时，无需另装）。启动脚本见 `build/sea-cli.js`、`build/sea-web.js`；注意 SEA 下 `process.argv` 是 `[exe, exe, ...用户参数]`。
4. **Electron 打包必须用 npm 装依赖**：目录里存在 pnpm-lock 时 electron-builder 会走 pnpm 收集器，pnpm 不在 PATH 时会静默失败（报 `No JSON content found in output`）。

### 校验脚本

需要本地 1.21.11 测试服（`online-mode=false`、`enforce-secure-profile=false`、`spawn-protection=0`，端口 25566）。

```bash
# 机器人功能（17 项）：连接/寻路/跟随/聊天指令/采集/开关
node test/e2e.js

# AI 操控 + 多假人（21 项）：用本地模拟大模型服务端，不需要真实 API Key
node test/ai-multi-check.js

# WebUI（8 项）：页面、状态接口、SSE 实时推送、异常请求不崩
node test/webui-check.js

# 命令行版（5 项）
node test/cli-check.js

# 分发包总校验（9 项）：核对 6 个 zip 结构 + 从 zip 解压后实际运行 Windows 命令行版
node test/dist-verify.js

# 打包后的可执行文件能否真跑
node test/pkg-check.js <可执行文件> cli|webui

# Linux 二进制 ELF 结构 + SEA 注入校验（本机无法运行 Linux 二进制时用）
ORIG_NODE=<原始linux node> node test/linux-check.js <linux可执行文件>
```

> `ai-multi-check.js` 内置了一个模拟大模型服务端：它会从系统提示里解析出假人坐标，再返回"走过去"的动作，
> 因此能在没有 API Key 的情况下验证「提示词带上真实状态 → 模型返回动作 → 假人真的移动」这条完整链路。

## 常见问题

- **GUI 启动后立刻退出/崩溃，控制台没有任何输出**：确认不是在受限/沙箱化的终端里启动的（某些 IDE 沙箱、容器、无 GPU 的远程会话会阻断 Chromium 的 IPC 与合成器）。请在普通 Windows 终端或直接双击运行。若在远程桌面/虚拟机里仍失败，可用：
  `npx electron . --no-sandbox --disable-gpu`
- **报 `Cannot read properties of undefined (reading 'handle')`（ipcMain 未定义）**：说明环境变量 `ELECTRON_RUN_AS_NODE=1` 被设置了，Electron 会退化成纯 Node 运行。清除该变量后再启动：
  `Remove-Item Env:ELECTRON_RUN_AS_NODE`（PowerShell）
- **连接不上 / 版本错误**：确认服务器版本与参数里选择的版本完全一致；确认端口（Java 版默认 25565）。
- **端口怎么写**：两种都支持，程序会自动识别——
  `--host 1.2.3.4 --port 43042`（推荐）或 `--host 1.2.3.4:43042`（端口写在地址里，会自动拆开）。
  如果地址里带了端口又写了 `--port`，**以地址里的为准**。界面里的「服务器地址」同样支持 `1.2.3.4:43042` 写法。
- **`getaddrinfo ENOTFOUND xxx`**：主机名解析失败。若地址里有多个冒号或写成了 `host:port:port` 之类，
  程序会直接提示正确写法；否则检查地址拼写、DNS 与网络连通性。
- **被反作弊插件踢出**：这是你自己的服务器，建议在反作弊插件（如 Grim）配置里把机器人名字加入白名单，或对机器人关闭反作弊检测。
- **被服务器踢出且提示刷屏**：本项目已内置两道防护（指令整句匹配 + 10 秒 6 条限流），避免多个机器人互相触发指令形成刷屏循环。若你自行改写指令词，注意保持同样的防护。
- **机器人视野有限**：核心里 `viewDistance: 'short'`，若机器人找不到远处的方块，可改成 `'far'`（配置项 `viewDistance`，可选 `far/normal/short/tiny`）。想更省内存可调成 `tiny`（实测在超平坦世界里 CPU 差异很小，瓶颈不在区块加载）。

## 性能

几个关键数字都是**实测**出来的（测量脚本见 `test/perf-*.js`），不是估计：

| 项目 | 数值 | 说明 |
|---|---|---|
| 10 个假人空闲时的 CPU | 约 3% 单核 | 空闲省电生效后（优化前约 9%） |
| 客户端物理模拟占总开销 | **约 66%** | 每个假人约 6.2 ms/秒，空闲时已暂停 |
| 单假人内存 | 约 11 MB | 10 个假人 RSS 约 190 MB（含 Node 基线约 70 MB） |
| 10 个假人全部上线耗时 | 约 2 秒 | 自动探测版本 + 并行连接 |
| 界面重复推送创建的元素 | **0 个** | 增量更新；优化前每秒重建整表（20 假人约 260 节点/秒） |

**空闲省电**：假人站着不动时暂停本地物理模拟（这是最大的一块开销），
任何动作（寻路/跟随/采集/挖掘/攻击/巡逻）前自动恢复。触发条件保守：站在地面、水平速度≈0、无寻路目标、
不在采集/进食/巡逻/载具中，并有 1.2 秒回滞。实测暂停期间位置漂移 **0.000 格**（服务端位置包照常应用，不失同步）。
如需关闭：配置项 `idleThrottle: false`。

> 注意：**Windows 上"事件循环延迟"这类指标不可信** —— 本机实测进程完全空闲时也有 15.5 ms（Windows 定时器粒度 15.6 ms），
> mineflayer 源码里也标注了这一点。判断性能请看 CPU 占用与位置/行为是否正常，不要看这个数字。
- **离线服提示用户名已占用**：换一个没在线的机器人名字。
- **收集失败**：确认方块英文 ID 正确（如 `iron_ore`、`diamond_ore`、`oak_log`）。

## 技术说明与合规

- **版本支持**：连接时 `version` 传 `false`，mineflayer 会自己 ping 服务器识别版本并校验支持范围（官方测试清单 1.8.8 ~ 26.1）。实测使用 **mineflayer 4.39.0 / minecraft-data 3.117.0 / mineflayer-pathfinder 2.4.5 / Electron 44.5.1**（均为当前最新版）。
- **26.2 / 26.3**：上游 minecraft-data 与 mineflayer（均为最新版）尚无这两个版本的协议数据，报 `No data available for version`。程序会自动回退到最新支持版本重试；实测配合服务端 ViaVersion + ViaBackwards 可以登录进服，但移动会被判定非法而踢出。详见 [使用方案.md](使用方案.md)。
- 注意：`mineflayer-pathfinder` 的路径事件（`goal_reached` 等）是 **emit 在 bot 上**，不是 `bot.pathfinder` 上——写成 `bot.pathfinder.on(...)` 会抛 `TypeError`。
- 注意：新版 `mineflayer-auto-eat` 是 ESM-only 包，为保证 CommonJS 工程整洁，本项目内置实现了自动吃与自动穿甲。
- **实测情况**：机器人功能 17/17、AI+多假人 21/21、WebUI（含 PWA）13/13、命令行一键化 15/15、WebUI 一键化 12/12、多版本服务端 5/6（26.3 已说明原因）。
- 请仅在**你有权限的服务器**上使用；不要用它攻击他人服务器、绕过封禁或刷数据，这违反服务器规则和 Mojang EULA。
