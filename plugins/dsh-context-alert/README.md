# dsh-context-alert

上下文压力提醒：盯着 DSH 官方的 `contextPressure` 投影，在会话"该换"的时候**于回合结束主动提醒你开新会话**，并在输入框上方显示一条压力横幅。

---

## 1. 为什么需要它

| 事实 | 出处 |
| --- | --- |
| **官方 `ContextMeter` 已经在显示占用率**：输入框下方的环 + 百分比，点开是 `contextBreakdown` 组成（system / tools / conversation）。它就渲染在输入栏的 dock 里，**紧挨在本横幅下方**。 | `@deepseek-ai/dsh-client-ui-conversation` 的 `ContextMeter`（源码注释：`Composer context-occupancy meter: a ring and percentage below the card fed by the contextPressure projection`） |
| **但它只回答"现在多少"**：源码里没有 `compact` / `shadow` / `loss` / `notify` / 阈值 相关逻辑——不报压缩次数、不报丢失率、不做任何提醒。 | 同上（逐项核对其源码区域） |
| **`dsh-context` 不会提醒你**。它只做可视化（上下文洞察页、上下文 tab、`/context` 命令、右侧 Context 面板）。源码里唯一的 "REMINDER" 是一个 `REMINDER_PREFIX` 正则常量，与提醒无关；偏好设置全是展示项。 | `~/.dsh/profiles/desktop/node_modules/dsh-context/lib/index.js` |
| **DSH 本身不报上下文压力**，只在到达阈值时**静默自动压缩**。 | `@deepseek-ai/dsh-compaction-basic` 默认 `thresholdRatio: 0.8`、`retainRatio: 0.16`、`headroomTokens: 65536` |
| 压缩是**有损**的：旧内容被折成摘要，细节找不回来。 | 同上 |
| 现有第三方插件也没有这个功能（`dsh-context-doctor` 的阈值只用于注入审计；`@shermanono/dsh-notify` 只覆盖回合结束/审批/提问）。 | — |
| 压缩**没有预告**，而且"这是第几次压缩"在界面上完全看不到。 | 会话日志里的 `compaction/start` 事件（本机 30 个会话中 5 个压过，最多的压过 3 次） |

也就是说：**默认情况下，你会在毫无预警的情况下被压缩掉上下文，而且不知道已经被压过几次**。这个插件补的就是这一环。

### 1.1 与官方 `ContextMeter` 的分工（为什么横幅里看不到百分比）

| 读数 | 谁负责 | 位置 |
| --- | --- | --- |
| 占用率（百分比）、token 用量、context 组成 | **官方 `ContextMeter`** | 输入栏 dock 内的环，点击展开面板 |
| 压过几次、累计遮蔽多少、信息丢失率 | **本插件横幅** | 输入框**上方**（`conversation.input.dock`） |
| 越阈值的主动提醒（桌面 / 语音） | **本插件** | 回合结束，与界面无关 |

两者上下相邻——`InputBar` 的 dock 里是官方环，而 `conversation.input.dock` 就渲染在输入栏正上方——所以**横幅平时那一行不再重复百分比与 token 用量**：同一区域并排显示同一个数字，只会让人怀疑哪个才是准的。只有越过 `warnPct`、百分比已经成为"该换会话了"这个判断的一部分时，横幅才把它拿出来放在标题旁边。

---

## 2. 判据：官方投影，不自己猜

占用率来自 `dsh-token-meter` 注册的 `contextPressure` 投影，不重算、不估算。

宿主侧 `ctx.sessionProjections.stateOf(session, 'contextPressure')` 返回内部 state：

```
{ contextWindow?, pressureTokens?, surfaceTokens, sampledSurfaceTokens?, claim? }
```

占用率的官方口径（`dsh-token-meter/lib/types/usage-projection.js` 的 `wire.view`）：

```
projectedTokens = max(0, pressureTokens + surfaceTokens - sampledSurfaceTokens)
occupancy       = projectedTokens / contextWindow
```

**为什么是"差值"而不是直接用 `pressureTokens`**：`pressureTokens` 是提供方报告的最新提示词规模，`sampledSurfaceTokens` 是那次采样时的 surface 规模。两者的差就是"采样之后又长出来的部分"。直接用 `pressureTokens` 会在压缩后明显低估。

客户端侧 `useProjection('contextPressure')` 拿到的已经是算好的 wire view（含 `projectedTokens`），所以客户端**直接读数**，不重复实现这套公式。

字段全部可选：拿不到窗口或用量时**返回"不知道"，不编一个百分比**。

---

## 3. 说清"第几次压缩"（数据来源与边界）

提醒的标题就是这句话：

```
即将开始本对话的第三次自动压缩
```

这个次数**不是估计**，是数出来的：DSH 每次压缩都会往会话日志写一组事件，
数 `compaction/start` 的个数就是已经压过的次数，+1 就是"即将发生的这次是第几次"。

事件形状（实测自本机 `~/.dsh/sessions/**/session.v4.jsonl.zstd`）：

| 事件 | 关键字段 | 用途 |
| --- | --- | --- |
| `compaction/start` | `compactionId`, `turn` | **计数的唯一依据** |
| `compaction/summary` | `shadowedTokenCount`, `shadowedRange`, `usage`, `provider`, `model` | 文案里的"上次遮蔽了 N tokens"；`shadowedTokenCount` **累加**得到信息丢失率的分子 |
| `compaction/end` | `compactionId`, `turn` | 回合号与结束时间 |
| `compaction/prune` | `shadowedTokenCount` | **不是压缩**，只是工具结果修剪，必须排除（单独累计，见 §8 丢失率口径） |

> `compaction/prune` 的数量与压缩次数完全不成比例（实测：4 个 prune 对 2 次压缩，
> 12 个 prune 对 1 次压缩）。把它算进去就会把次数数多。

读取方式：宿主在**第一次真要提醒时**才读一次完整日志（`session.snapshotEvents()`），
之后靠 `session/event` 增量累加。平时不付这个成本。
横幅要显示"第几次压缩"，所以宿主在算压力读数时也会补一次扫描
（顶层会话才扫；子代理会话不提醒也不给你看，跳过）。

> ⚠️ 注意 API：`Session` 上**没有** `events` 属性（官方 practices 文档里
> "rescanning `session.events`" 是宽泛说法）。真实方法是 `snapshotEvents()`。
> 按 `session.events` 写会拿到 `undefined`，然后永远报告"0 次压缩"——
> 一个不报错、只是长期说错的静默 bug。

### 3.1 为什么文案里没有"距离压缩线还有 N tokens"

因为算不准。真实触发点是：

```
floor(min(W × thresholdRatio, W − O − headroomTokens))
```

`W` 是窗口（能读到，本机 262,144）、`headroomTokens` 默认 65,536，
但 **`O`（生效请求输出上限）在插件侧读不到** —— 它既不在会话日志里，
也不在 `requestContext()` 里。

由于取的是 `min`，`W × 0.8` 只是触发点的**上界**。所以文案说的是
"压缩线**不晚于**窗口 80%（≈209,715 tokens）——实际可能更早"，
而不是给你一个看着精确、实则偏乐观的"还剩 N tokens"。

顺带一个反直觉的推论：因为 `min` 里还有 `W − O − 65536` 这一项，
**窗口越小、这个比例越不起作用**。256k 窗口下 80% 有意义，小窗口下真实触发点会明显更早。

### 3.2 事件名变了怎么办

如果 DSH 以后改了事件名，`compaction/start` 会认不出来，次数就会是 0 ——
那时插件会**错误地宣称"第一次"**。所以有一道自检：`compaction/summary` 与
`compaction/end` 永远和 `start` 成对出现，一旦看到它们却没有 `start`，
就判定事件名变了，**降级为不带次数的说法**并打一条告警：

```
上下文变重了，建议换会话        ← 不谎称"第一次"
```

可以用 `tools/scan-compactions.mjs` 自己核对（见 §11）。

---

## 4. 提醒时机与"不烦人"的设计

提醒挂在 **回合结束**（`agent/turn-stopping`）——你正要决定下一条消息怎么发的时候，此刻的提醒才有可操作性。进行中的工作不会被中途打断。

| 机制 | 默认 | 作用 |
| --- | --- | --- |
| `warnPct` | 65% | 超过就开始提醒 |
| `criticalPct` | 82% | 贴到自动压缩线（0.8），措辞升级为"现在就该换" |
| `rearmPct` | 45% | 占用跌回这里以下才重新"上膛"，避免在阈值附近反复唠叨 |
| `cooldownMs` | 10 分钟 | 同一会话同级提醒的最小间隔 |
| `maxAlertsPerSession` | 3 次 | 每会话硬上限 |
| 紧急升级 | 绕过冷却 | 你忽略了 warn、两分钟后真贴到压缩线，不该再让你等 8 分钟 |
| 只看用户会话 | 内置 | 只有**你自己发过消息**的会话才提醒；子代理、后台会话一律不打扰 |
| 压缩后重新上膛 | 内置 | 压缩会把占用打回低位，于是自动重新获得提醒额度 |

---

## 5. 两个界面

| 界面 | 位置 | 说明 |
| --- | --- | --- |
| **压力横幅** | 输入框上方（`conversation.input.dock`） | 平时一行小字：`已压缩 2 次　·　信息丢失率 52.2%`（占用率与用量交给紧下方的官方环，**不重复**）；越过 `warnPct` 才展开成多行，标题就是"即将开始本对话的第 N 次自动压缩"，下面带百分比、token 用量与上次遮蔽量；紧急时转红 |
| **设置分区** | 设置 → 插件 → 上下文提醒（`settings.section`） | 改阈值/冷却/上限/通知方式，可点"试一次提醒" |

横幅的"第 N 次"由宿主提供（压缩次数只有宿主读得到会话日志），客户端只负责显示——
序号措辞由 `watch.js` 的 `ordinalPhrase()` 统一生成，标题与横幅不会各说各话。

> ⚠️ **dock 组件的 props 里没有 `session`**。内置 `TodoDock` 的签名就是 `({ useProjection, t })`。
> 按会话的 props 必须通过注册项的 `inject(sessionId)` 注入（`QueueDock` 与 `ui-goal` 的
> goal dock 都这么做，且都注册在同一个 slot 上）：
>
> ```js
> ctx.slots.register({
>   name: 'conversation.input.dock', id: 'context-alert', order: 10,
>   inject: (sessionId) => ({ sessionId }),      // ← 缺了这行，横幅认不出自己属于哪个会话
> }, ContextAlertBanner)
> ```
>
> 少了这行，横幅永远拿不到压缩次数，只会显示"这个会话开始变重了"这类兜底文案——而且不报错。

两个界面都只用 `--dsw-alias-*` 主题令牌（`state-warn-primary`、`state-error-primary`、`bg-layer-2`、`label-*`），明暗主题自动跟随，不写死颜色（图标除外——美术资源）。

---

## 6. 命令

```
/ctxalert                       # 看当前所有会话的占用、阈值、待发状态
/ctxalert on | off              # 开关
/ctxalert test [warn|critical]  # 立刻发一次测试提醒
/ctxalert warn=65 critical=82 rearm=45 cooldown=10 max=3
```

---

## 7. 安装

### 推荐：用内置 Plugin Manager

本 profile 未启用 `@deepseek-ai/dsh-plugin-manager`，所以需要先启用它，再用 `plugin_manager` 的 `install_bundle`（target 传本目录的绝对路径）。这是 DSH 官方推荐路径，它会自动完成依赖登记与 bundle 选择。

### 手动安装（等价，需自行批准）

1. 把本目录复制到 `C:\Users\user\.dsh\plugins\dsh-context-alert`
2. 建 junction（不需要管理员权限）：
   ```
   cmd /c mklink /J "C:\Users\user\.dsh\profiles\desktop\node_modules\dsh-context-alert" "C:\Users\user\.dsh\plugins\dsh-context-alert"
   ```
3. 在 `C:\Users\user\.dsh\profiles\desktop\package.json` 里：
   - `dependencies` 加 `"dsh-context-alert": "link:../../plugins/dsh-context-alert"`
   - `dsh.profile.bundles` 加 `"dsh-context-alert"`
4. **重启 DSH**（bundle 列表在启动时读取，运行中不会生效）

> 手动安装是官方指南明确不推荐的做法（它说这类写入应交给 `install_bundle`，每次手写都需要单独批准）。这里写出来是因为本 profile 没启用 Plugin Manager，属于退路。

### 安装后核验

```
node verify-install.mjs
```

只读检查 13 项：profile 清单是否登记、`node_modules` 挂载点是否存在、能否按名解析、宿主入口与 `./client` 导出是否就位、patch 是否插入了正确的行、客户端 `inject` 是否覆盖所注册的 slot 宿主、client bundle 注册的模块 id 是否等于包名、`alert.ps1` 是否纯 ASCII。**重启 DSH 之前先跑一遍**，能把"插件压根没被加载"挡在前面；升级 DSH 或挪动插件后也值得再跑。

> 该脚本刻意以 profile 目录为 require 基准，而不是自身位置。因为脚本住在插件包内，而包内 `package.json` 声明了 `"./package.json"` 导出，Node 的 self-reference 会抢先命中"脚本旁边的源码副本"，导致整套检查悄悄跑在工作区副本上——这个坑真实踩过。

---

## 8. 配置

运行时配置在 `~/.dsh/context-alert/config.json`（由设置面板与 `/ctxalert` 写入，也是唯一事实来源）。环境变量：

| 变量 | 作用 |
| --- | --- |
| `DSH_CTX_ALERT_HOME` | 改配置目录（默认 `~/.dsh/context-alert`） |
| `DSH_CTX_ALERT_DRYRUN=1` | 演练模式：只记录不弹窗，用于自检与测试 |
| `DSH_CTX_ALERT_SOUND` | 提示音名，默认 `explode`（`sound`/`both` 模式用；文件放 `~/.dsh/context-alert/sounds/`） |

可调项（`config.json` / 设置面板 / `/ctxalert`）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `warnPct` / `criticalPct` / `rearmPct` | 65 / 82 / 45 | 提醒、升级、重新上膛的阈值 |
| `cooldownMs` / `maxAlertsPerSession` | 10 分钟 / 3 次 | 不烦人的两道闸 |
| `mode` / `criticalMode` | `toast` / `both` | 普通与紧急提醒的通知方式 |
| `minWindow` | 8000 | 窗口小于此值不提醒 |
| `bannerAlways` | `true` | 横幅常驻：平时也用一行小字显示压缩次数与信息丢失率，越过 `warnPct` 才展开成醒目多行。设 `false` 退回"只在越过阈值时出现" |
| `compactPct` | 80 | **仅用于文案**：说"压缩线不晚于窗口 80%"。请与 `dsh-compaction-basic` 的 `thresholdRatio` 保持一致 |
| `headroomTokens` | 65536 | **仅用于文案**：同上，对应 `headroomTokens` |

> 后两项只影响措辞，不影响判定——判定用的是 `warnPct`/`criticalPct`。

### 横幅的两种形态

| 占用 | 形态 | 内容 |
| --- | --- | --- |
| 低于 `warnPct` | **一行小字**，灰点、灰边框 | `已压缩 2 次　·　信息丢失率 52.2%`；从未压缩时是 `尚未发生上下文压缩　·　信息丢失率 0%`；拿不到宿主状态时是 `压缩次数未知`。**刻意不含百分比与 token 用量**——那两项归官方 `ContextMeter`（见 §1.1），重复显示只会让人怀疑哪个准 |
| 高于 `warnPct` | **多行**，黄/红边框 | 标题是"即将开始本对话的第 N 次自动压缩"，下面是累计遮蔽量、丢失率、最近一次压缩的回合与 token 数 |

### 「信息丢失率」的口径（务必看清再引用）

```
丢失率 = 累计被遮蔽的 token ÷ (累计被遮蔽的 token + 当前上下文 token)
```

- **被遮蔽 ≠ 完全消失**。摘要是压缩过的有损表示：原始细节拿不回来，但要点还在。
  这个比例衡量的是"历史里已经不再逐字保留的那部分"。
- **分母含摘要本身**，所以分母偏大、算出的比例偏小 —— 这是个**保守**估计，真实丢失只会更多。
- 一次都没压过时是**确定的 0%**（不是"不知道"）；压过但遮蔽数据缺失时不显示，
  否则会出现"最近一次遮蔽了 78,463 tokens"与"丢失率 0%"并列的鬼话。
- 工具输出修剪（`compaction/prune`）**不计入**丢失率：它只动工具结果，重跑一次通常拿得回来，
  性质不同，所以在 `/ctxalert status` 里单独列出。

---

## 9. 通知后端（`alert.ps1`）

无第三方依赖的 PowerShell 脚本，payload 走 base64(UTF-8 JSON) 环境变量 `DSH_CTX_ALERT_PAYLOAD`，避免中文在命令行引号/代码页里被打碎。

| 模式 | 行为 |
| --- | --- |
| `toast` | `NotifyIcon` 气泡（10 秒） |
| `speak` | SAPI 离线合成，优先 `zh*` 音色；`System.Speech` 失败则退回 COM `SAPI.SpVoice` |
| `sound` | 若存在 `~/.dsh/context-alert/sounds/<名字>.wav` 就用它（根目录可被 `DSH_CTX_ALERT_HOME` 改），否则系统提示音 |
| `both` | 语音 + 桌面 |
| `probe` | 只报音频输出设备数量，用于启动自检 |

脚本先调 `waveOutGetNumDevs()` 探音频设备：**没有输出设备时不会去试 SAPI**（否则 SAPI 会抛一句极具误导性的"系统上未安装语音，或没有当前安全设置可用的语音"），而是明确说明"无音频设备、提醒以桌面气泡呈现"。

脚本只读**自己的**目录：把 `<名字>.wav` 放进 `~/.dsh/context-alert/sounds/` 就能自定义提示音，默认名字是 `explode`（`DSH_CTX_ALERT_SOUND` 可改）。它**不读任何其他插件的文件**——所以既不需要先装别的插件，别的插件被挪走或卸载也不会影响它。

脚本本身**纯 ASCII**：Windows PowerShell 5.1 会用系统 ANSI 代码页解码无 BOM 的 `.ps1`，源码里写中文会乱码。所有面向用户的文字都从 base64 payload 进来。

---

## 10. 验证状态（如实说明）

**已验证**

- `watch.js` 纯逻辑：单测覆盖占用率口径、磁滞、冷却、升级绕冷却、每会话上限、压缩后重新上膛、缺失字段不编数字，以及压缩历史（数 `start` 而非 `prune`、事件名漂移时降级、序号措辞、文案不出现"距压缩线还有 N"）。
- `index.js` 宿主半边：集成测试用假 ctx 跑真实 `apply()`，覆盖钩子注册、压力喂入、`userDriven` 过滤、回合结束触发、`session/disposed` 清理、命令各分支、三个 HTTP 路由、缺 `sessionProjections` 时优雅降级，以及压缩历史的整条接线（`snapshotEvents` → 序号 → 标题；读不到日志时降级并告警）。
- `client.js` 客户端半边：**真的把 bundle 加载起来**（假 `ModuleLoader`），断言模块 id、两个 slot 的注册、dock 注册带 `inject(sessionId)`，并**冒烟调用**两个组件。
- **压缩计数对着真实日志验证过**：拿本机 8 个真实会话日志跑 `compactionHistory()`，压缩次数与独立计数的 `compaction/start` 个数 **8/8 一致**（其中 5 个会话压缩过，最多的压过 3 次）。同一套数据也用于渲染真实文案预览。
- `tools/scan-compactions.mjs`：真机跑通，且实测 `compaction/start`、`/summary`、`/end` 三者数量恒等——这正是 §3.2 那道自检成立的前提。
- `alert.ps1`：真机跑通 `toast`（气泡确实弹出）、`probe`、缺 payload 时报错退出。
- 全部 JS `node --check` 通过；三个 JSON 校验通过；`alert.ps1` 纯 ASCII 校验通过。

> 测试总数：75 项（`node run-tests.mjs`）。测试通过 `run-tests.mjs` 在进程内导入，因为本会话沙箱下 `node --test` 会因管道 stdio 报 EPERM。
>
> 客户端那组"冒烟调用"**不是视觉验证**，它的价值在于抓一类特定的 bug：组件里引用了不存在的标识符。这类 bug 在真机上表现为**整个 slot 条目被清空**（控制台 `slot entry crashed`），而 `node --check` 抓不到（它是语法检查，不是作用域检查）。这个守卫本身做过变异测试：注入一个未定义变量后，2 项用例如期失败，还原后全过。

**未能验证**

- **客户端半边的视觉效果**。本会话无浏览器控制（Web UI 需要 token 鉴权），且官方验证指南明确禁止用模拟 React/DOM 的方式代替真机验证。所以横幅与设置面板只做到"bundle 加载 + slot 注册 + 冒烟不抛 + 文本断言"这一级，**真实渲染效果需你在重启后自行确认**。
- **Node 子进程 → PowerShell 的真实链路**：本会话沙箱不允许 Node 用管道 stdio 起子进程（EPERM），所以 `runScript()` 走的是演练模式。该 spawn 写法与已在用 `dsh-plugin-notify` 的 `runProcess()` 完全同形，但这一环严格来说只有实机才算了结。
- **本机音频输出**：`waveOutGetNumDevs() = 0`，注册表里 13 个输出端点全部 `DeviceState=4`（NOTPRESENT）。**语音播报与提示音在这台机器上不会出声**，提醒会以桌面气泡呈现。插上耳机/音箱后重启 DSH 即可恢复（`/ctxalert status` 之外可看启动日志里的自检行）。

**已知偏离官方指南**

- 未走 Client locale 服务，界面文字直接写中文。理由：这是单人中文环境，且本 profile 里已装好的 `dsh-plugin-notify` 同样直接写中文；接 locale 服务需要额外验证一套我没把握的 API，而 slot 组件一旦抛异常会导致整个 slot 条目被清空。
- 未用 `export const Config`（schemastery）承载可调项，而是沿用 `config.json` + `settings.section`。理由同上：`dsh-plugin-notify` 的源码注释记录了 dsh 0.2.0-rc.2 已移除 `ctx.settings.register`，配置由 `config.json` + 客户端设置分区负责——与本实现一致。

---

## 11. 目录

```
index.js              宿主半边：钩子、通知、路由、/ctxalert
watch.js              纯逻辑：占用率口径 + 阈值磁滞状态机 + 压缩历史（可脱离 DSH 单测）
client.js             客户端半边：压力横幅 + 设置面板（手写 ModuleLoader bundle）
alert.ps1             通知后端（纯 ASCII，无依赖）
cordis.patch.yml      bundle patch
package.json          清单（dsh.bundle.patch + dsh.client）
locale/{zh,en}.json   Plugin Manager 卡片文案
icon.svg              图标
tools/                诊断脚本（scan-compactions.mjs：自己数一遍压缩次数）
test/                 单测与集成测试
run-tests.mjs         同进程测试入口
verify-install.mjs    安装核验（只读，13 项）
```

跑测试：

```
node run-tests.mjs
```

（`node --test` 会为每个文件 spawn 子进程并用管道收输出，在受限沙箱里会撞 EPERM；同进程 import 等价且不受影响。）

自己核对压缩次数：

```
node tools/scan-compactions.mjs 8
```

它会直接读 `~/.dsh/sessions` 并打印每个会话压缩了几次、上次遮蔽了多少 token，
以及 `start`/`summary`/`end` 是否成对（不成对就是事件名变了，见 §3.2）。

---

## 12. 设计取舍备忘

- **提醒放在宿主而非客户端**：`useProjection` 只在某个会话标签页挂载时存在，基于标签页的插件没法可靠提醒——你切走就收不到了。宿主侧 `stateOf()` 不依赖任何界面。
- **订阅 `session/event` 而非 `sessionProjections.onChanged()`**：`onChanged` 的 listener 参数形状没有在 API 目录里定死，而 `session/event` 的签名是明确的。压力判定是 O(1) 读投影，**不重扫日志**；唯一的一次全量 `snapshotEvents()` 只用于数压缩次数，且每会话只做一次（详见上一节的最后一条）。若日后确认了 `onChanged` 的形状，换过去能进一步减少唤醒次数。
- **注册在 `conversation.input.dock` 而非 `conversation.composer.dock`**：前者已由内置的 `QueueDock`/`TodoDock` 证明会向组件注入 `useProjection`（两处独立证据），而后者未经验证。选已验证的 slot 比选"看起来更合适"的 slot 更重要。
- **不做提示音音量提升**：那需要 `pycaw` 之类的额外依赖，收益不抵复杂度；且本机没有音频设备，先不引入。
- **提示音只读自己的目录**：原实现会去读 `dsh-plugin-notify` 的 `~/.dsh/notify/sounds/`，虽然那只是"存在就读、不存在就回落"的可选路径，但它让"本插件依赖别的插件"这个说法始终站得住脚。现在读 `~/.dsh/context-alert/sounds/`（跟随 `DSH_CTX_ALERT_HOME`），卸载/挪走任何别的插件都不影响这里。
- **横幅不重复官方环的读数**：官方 `ContextMeter` 的环就渲染在输入栏 dock 内、本横幅**正下方**。所以平时那一行只报"压过几次 + 丢失率"，百分比与 token 用量留给官方环；只有越阈值时才把百分比拿到标题旁边——那时它已经是"该换会话了"这个判断的一部分，而不是顺便报个数。宁可横幅信息少一点，也不要两个相邻读数打架。
- **不写"距离压缩线还有 N tokens"**：触发点里的 `O`（生效请求输出上限）在插件侧读不到，算出来的数会系统性偏乐观（因为取的是 `min`）。宁可只说上界，也不给一个看着精确的错数。详见 §3.1。
- **压缩次数从日志数，不靠推断**：`compaction/start` 是唯一可靠依据；`compaction/prune` 看着像但不是压缩。并且加了一道"看到 summary/end 却没有 start 就降级"的自检，防止 DSH 改事件名后静默说错次数。
- **一次全量读日志，之后增量**：`snapshotEvents()` 是 O(n)，但每个会话只在**第一次真要提醒时**读一次（`collect()` 里也读一次以便横幅显示），之后靠 `session/event` 累加。既不违反"别反复重扫日志"，也不为永不提醒的会话付成本。子代理会话（没有 `userDriven` 标记）连这一次都不扫。
- **客户端不改文本口径，只显示宿主给的序号**：序号措辞在 `watch.js` 里定义一次，宿主算好塞进 state 接口，客户端直接显示。避免"通知里说第三次、横幅说第二次"这类漂移。
- **改客户端后必须重启 DSH 才看得到全部效果吗？不是**——但**宿主**改动必须重启。客户端 bundle 随页面刷新就会重新加载，宿主 `index.js` 只在启动时加载一次。这个区别真实造成过一次误判：当时看到的界面是"新版客户端 + 旧版宿主"，横幅因为接口里没有 `ordinalText` 而退回兜底文案。

## License

MIT
