# dsh-context-alert

> **上下文压力提醒**：盯着 DSH 官方的 `contextPressure` 投影，在会话"该换"的时候**于回合结束主动提醒你开新会话**，并在输入框上方显示一条压力横幅。

[English](README.en.md) | **中文**

![license](https://img.shields.io/badge/license-MIT-blue.svg)
![platform](https://img.shields.io/badge/platform-Windows-0078d4.svg)
![dsh](https://img.shields.io/badge/dsh-0.2.0--rc.2-4b6bfb.svg)
![tests](https://img.shields.io/badge/tests-37%20passing-brightgreen.svg)

---

## 适用范围

| 项目 | 要求 |
| --- | --- |
| 操作系统 | **仅 Windows**（通知后端是 PowerShell，用 `NotifyIcon` 气泡 + SAPI 语音） |
| DSH | `0.2.0-rc.2`（`dsh.compatibility.dshReleases` 声明） |
| Node | `>= 22.5` |
| 依赖插件 | **需要 `dsh-token-meter`** 提供 `contextPressure` 投影。未安装时插件本体照常加载，只是明确告知"提醒已停用"，不会崩 |

---

## 1. 为什么需要它

| 事实 | 出处 |
| --- | --- |
| **DSH 本身不报上下文压力**，只在到达阈值时**静默自动压缩**。 | `@deepseek-ai/dsh-compaction-basic` 默认 `thresholdRatio: 0.8`、`retainRatio: 0.16`、`headroomTokens: 65536` |
| 压缩是**有损**的：旧内容被折成摘要，细节找不回来。 | 同上 |
| **`dsh-context` 不做主动提醒**。它的定位是可视化（上下文洞察页、上下文 tab、`/context` 命令、右侧 Context 面板）；源码里唯一的 `REMINDER` 是一个 `REMINDER_PREFIX` 正则常量，与"提醒用户"无关，偏好设置项全是展示用。 | `node_modules/dsh-context/lib/index.js` |

也就是说：**默认情况下，你会在毫无预警的情况下被压缩掉上下文**。这个插件补的就是这一环。

---

## 2. 判据：官方投影，不自己猜

占用率来自 `dsh-token-meter` 注册的 `contextPressure` 投影，**不重算、不估算、不编数字**。

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

字段全部可选：拿不到窗口或用量时返回 `null` ——**宁可什么都不说，也不编一个百分比**。

---

## 3. 提醒时机与"不烦人"的设计

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

## 4. 两个界面

| 界面 | 位置 | 说明 |
| --- | --- | --- |
| **压力横幅** | 输入框上方（`conversation.input.dock`） | 仅在超过 `warnPct` 时出现，带百分比与 token 用量；紧急时转红 |
| **设置分区** | 设置 → 插件 → 上下文提醒（`settings.section`） | 改阈值/冷却/上限/通知方式，可点"试一次提醒" |

两个界面都只用 `--dsw-alias-*` 主题令牌（`state-warn-primary`、`state-error-primary`、`bg-layer-2`、`label-*`），明暗主题自动跟随，不写死颜色（图标除外——美术资源）。

---

## 5. 命令

```
/ctxalert                       # 看当前所有会话的占用、阈值、待发状态
/ctxalert on | off              # 开关
/ctxalert test [warn|critical]  # 立刻发一次测试提醒
/ctxalert warn=65 critical=82 rearm=45 cooldown=10 max=3
```

---

## 6. 安装

### 6.1 取到插件目录

```powershell
git clone https://github.com/yierzhao23-debug/for-dsh.git
# 插件目录：for-dsh\plugins\dsh-context-alert
```

或者在仓库页点 **Code → Download ZIP** 整体解压，只取 `plugins\dsh-context-alert` 这一个目录。

### 6.2 推荐：用内置 Plugin Manager

若 profile 里启用了 `@deepseek-ai/dsh-plugin-manager`，用 `plugin_manager` 的 `install_bundle`，target 传插件目录的**绝对路径**。这是 DSH 官方推荐路径，它会自动完成依赖登记与 bundle 选择。

### 6.3 手动安装（等价，需自行批准）

1. 把插件目录放到 `%USERPROFILE%\.dsh\plugins\dsh-context-alert`
2. 建 junction（不需要管理员权限）：

   ```cmd
   mklink /J "%USERPROFILE%\.dsh\profiles\<profile>\node_modules\dsh-context-alert" "%USERPROFILE%\.dsh\plugins\dsh-context-alert"
   ```

3. 编辑 `%USERPROFILE%\.dsh\profiles\<profile>\package.json`：
   - `dependencies` 加 `"dsh-context-alert": "link:../../plugins/dsh-context-alert"`
   - `dsh.profile.bundles` 加 `"dsh-context-alert"`
4. **重启 DSH**（bundle 列表在启动时读取，运行中不会生效）

> 手动安装是官方指南明确不推荐的做法（它认为这类写入应交给 `install_bundle`）。这里写出来是因为有些 profile 没启用 Plugin Manager，属于退路。

### 6.4 安装后核验

```
node verify-install.mjs
```

只读检查 13 项：profile 清单是否登记、`node_modules` 挂载点是否存在、能否按名解析、宿主入口与 `./client` 导出是否就位、patch 是否插入了正确的行、客户端 `inject` 是否覆盖所注册的 slot 宿主、client bundle 注册的模块 id 是否等于包名、`alert.ps1` 是否纯 ASCII。**重启 DSH 之前先跑一遍**，能把"插件压根没被加载"挡在前面；升级 DSH 或挪动插件后也值得再跑。

> 该脚本刻意以 profile 目录为 require 基准，而不是自身位置。因为脚本住在插件包内，而包内 `package.json` 声明了 `"./package.json"` 导出，Node 的 self-reference 会抢先命中"脚本旁边的源码副本"，导致整套检查悄悄跑在工作区副本上——这个坑真实踩过。

---

## 7. 配置

运行时配置在 `%USERPROFILE%\.dsh\context-alert\config.json`（由设置面板与 `/ctxalert` 写入，是唯一事实来源）。

| 环境变量 | 作用 |
| --- | --- |
| `DSH_CTX_ALERT_HOME` | 改配置目录（默认 `~/.dsh/context-alert`） |
| `DSH_CTX_ALERT_DRYRUN=1` | 演练模式：只记录不弹窗，用于自检与测试 |
| `DSH_CTX_ALERT_SOUND` | 提示音名（`sound`/`both` 模式用） |

---

## 8. 通知后端（`alert.ps1`）

无第三方依赖的 PowerShell 脚本，payload 走 base64(UTF-8 JSON) 环境变量 `DSH_CTX_ALERT_PAYLOAD`，避免中文在命令行引号/代码页里被打碎。

| 模式 | 行为 |
| --- | --- |
| `toast` | `NotifyIcon` 气泡（10 秒） |
| `speak` | SAPI 离线合成，优先 `zh*` 音色；`System.Speech` 失败则退回 COM `SAPI.SpVoice` |
| `sound` | 若存在 `~/.dsh/notify/sounds/<名字>.wav` 就用它，否则系统提示音 |
| `both` | 语音 + 桌面 |
| `probe` | 只报音频输出设备数量，用于启动自检 |

脚本先调 `waveOutGetNumDevs()` 探音频设备：**没有输出设备时不会去试 SAPI**（否则 SAPI 会抛一句极具误导性的"系统上未安装语音，或没有当前安全设置可用的语音"），而是明确说明"无音频设备、提醒以桌面气泡呈现"。

脚本本身**纯 ASCII**：Windows PowerShell 5.1 会用系统 ANSI 代码页解码无 BOM 的 `.ps1`，源码里写中文会乱码。所有面向用户的文字都从 base64 payload 进来。

---

## 9. 与已有插件的关系

本插件的**通知投递**部分参考了 [`dsh-plugin-notify`](https://github.com/huguangyu666/dsh-plugin-notify)（作者 huguangyu666，MIT）的成熟做法——尤其是"Node spawn PowerShell + base64 payload 传中文"这一条链路。感谢原作者。

两者的分工不同：`dsh-plugin-notify` 解决的是"**怎么把消息送到你眼前**"（桌面通知 / 语音 / 提示音，覆盖回合结束、审批、提问），本插件解决的是"**上下文快满了这件事，什么时候该说、说几次、怎么才不烦人**"（读取 `contextPressure` 投影 + 阈值磁滞状态机 + 回合结束触发）。

> 如果你知道有别的同类插件（做上下文压力主动提醒的），欢迎开 issue 补充，我会更新这一段。

---

## 10. 验证状态（如实说明）

**已验证**

- `watch.js` 纯逻辑：占用率口径、磁滞、冷却、升级绕冷却、每会话上限、压缩后重新上膛、缺失字段不编数字。
- `index.js` 宿主半边：用假 ctx 跑真实 `apply()`，覆盖钩子注册、压力喂入、`userDriven` 过滤、回合结束触发、`session/disposed` 清理、命令各分支、三个 HTTP 路由、缺 `sessionProjections` 时优雅降级。
- 全部测试：**37 项通过，0 失败**（Node 24.21.0，`node run-tests.mjs`）。
- `alert.ps1`：在作者机器上跑通 `toast`（气泡确实弹出）、`probe`、缺 payload 时报错退出。
- 全部 JS `node --check` 通过；三个 JSON 校验通过；`alert.ps1` 纯 ASCII 校验通过。

**未能验证**

- **客户端半边的视觉效果**。开发会话没有可用的浏览器控制，且官方验证指南明确禁止用模拟 React/DOM 的方式代替真机验证。所以横幅与设置面板只做到"语法 + 清单 + slot 注册"这一级，**渲染效果需在实机重启后自行确认**。
- **Node 子进程 → PowerShell 的真实链路**：开发会话的沙箱不允许 Node 用管道 stdio 起子进程（EPERM），所以 `runScript()` 走的是演练模式。该 spawn 写法与已在用的 `dsh-plugin-notify` 完全同形，但这一环严格来说只有实机才算了结。
- **作者机器上的音频输出**：`waveOutGetNumDevs() = 0`，注册表里 13 个输出端点全部 `DeviceState=4`（NOTPRESENT）。**语音播报与提示音在那台机器上不会出声**，提醒会以桌面气泡呈现。插上耳机/音箱后重启 DSH 即可恢复（启动日志里有一行自检结果）。

**已知偏离官方指南**

- 未走 Client locale 服务，界面文字直接写中文。理由：这是单人中文环境；接 locale 服务需要额外验证一套没把握的 API，而 slot 组件一旦抛异常会导致整个 slot 条目被清空。
- 未用 `export const Config`（schemastery）承载可调项，而是用 `config.json` + `settings.section`。理由同上：`dsh-plugin-notify` 的源码注释记录了 dsh 0.2.0-rc.2 已移除 `ctx.settings.register`，配置由 `config.json` + 客户端设置分区负责——与本实现一致。

---

## 11. 目录

```
index.js              宿主半边：钩子、通知、路由、/ctxalert
watch.js              纯逻辑：占用率口径 + 阈值磁滞状态机（可脱离 DSH 单测）
client.js             客户端半边：压力横幅 + 设置面板（手写 ModuleLoader bundle）
alert.ps1             通知后端（纯 ASCII，无依赖）
cordis.patch.yml      bundle patch
package.json          清单（dsh.bundle.patch + dsh.client）
locale/{zh,en}.json   Plugin Manager 卡片文案
icon.svg              图标
test/                 单测与集成测试
run-tests.mjs         同进程测试入口
verify-install.mjs    安装核验（只读，13 项）
```

```bash
node run-tests.mjs      # 跑测试
node verify-install.mjs # 核验安装
```

> `node --test` 会为每个文件 spawn 子进程并用管道收输出，在受限沙箱里会撞 EPERM；同进程 import 等价且不受影响。

---

## 12. 设计取舍备忘

- **提醒放在宿主而非客户端**：`useProjection` 只在某个会话标签页挂载时存在，基于标签页的插件没法可靠提醒——你切走就收不到了。宿主侧 `stateOf()` 不依赖任何界面。
- **订阅 `session/event` 而非 `sessionProjections.onChanged()`**：`onChanged` 的 listener 参数形状没有在 API 目录里定死，而 `session/event` 的签名是明确的。当前做法是 O(1) 读投影，**不重扫 `session.events`**，符合官方"不要把日志派生状态放在投影之外"的要求。若日后确认了 `onChanged` 的形状，换过去能进一步减少唤醒次数。
- **注册在 `conversation.input.dock` 而非 `conversation.composer.dock`**：前者已由内置的 `QueueDock`/`TodoDock` 证明会向组件注入 `useProjection`（两处独立证据），而后者未经验证。选已验证的 slot 比选"看起来更合适"的 slot 更重要。
- **不做提示音音量提升**：那需要 `pycaw` 之类的额外依赖，收益不抵复杂度。

---

## License

[MIT](LICENSE) © 2026 yierzhao23-debug
