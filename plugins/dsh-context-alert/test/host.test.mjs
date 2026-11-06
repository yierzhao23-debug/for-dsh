/**
 * 宿主半边的集成测试：用假的 ctx 跑真实 apply()。
 *
 * 这里能覆盖：钩子注册、压力喂入、userDriven 过滤、回合结束触发提醒、
 * 命令分支、HTTP 路由。覆盖不到的：DSH 真的把事件送到这些钩子上
 * （那需要重启 DSH，只能人工验收）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 环境变量必须在 import 之前设好：index.js 在模块加载时读它们。
const CONFIG_HOME = mkdtempSync(join(tmpdir(), 'ctx-alert-test-'))
process.env.DSH_CTX_ALERT_HOME = CONFIG_HOME
process.env.DSH_CTX_ALERT_DRYRUN = '1'

const { apply, name, inject } = await import('../index.js')

const WIN = 200000
const stateAt = (pct) => ({ contextWindow: WIN, pressureTokens: Math.round((WIN * pct) / 100) })

/** 最小可用的假 ctx：记录注册物，暴露触发钩子的入口。 */
function makeCtx ({ sessions = [], pressure = {} } = {}) {
  const handlers = new Map()
  const logs = []
  const registered = { commands: [], routes: [], effects: [] }
  const services = {
    sessionProjections: {
      stateOf: (session, key) => (key === 'contextPressure' ? pressure[session?.id] ?? null : null),
    },
    sessions: { list: () => sessions },
  }
  const ctx = {
    logger: {
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
    },
    on (event, fn) {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(fn)
      return () => {
        const arr = handlers.get(event) ?? []
        const i = arr.indexOf(fn)
        if (i >= 0) arr.splice(i, 1)
      }
    },
    inject (names, cb) {
      const child = { get: (n) => services[n] }
      const dispose = cb(child)
      return { dispose: typeof dispose === 'function' ? dispose : () => {} }
    },
    /**
     * cordis 的 ctx.effect(setup, label)：立刻执行 setup()，把它返回的 disposer
     * 收进本插件的清理列表，卸载时统一调用。测试里实现同样语义，
     * 才能验证"路由真的登记成可回收的 effect"。
     */
    effect (setup, label) {
      const dispose = setup()
      const off = typeof dispose === 'function' ? dispose : () => {}
      registered.effects.push({ label, dispose: off })
      return off
    },
    commands: { register: (d) => registered.commands.push(d) },
    webServer: {
      /**
       * 与 dsh-host-webserver 的 register 同语义：重复 (kind, path) 直接抛
       * `webserver: duplicate …`，成功时返回移除该路由的 disposer。
       * 这条重复检查正是"关掉再打开"失败的原因，所以假实现必须照抄。
       */
      register (route) {
        if (registered.routes.some((r) => r.kind === route.kind && r.path === route.path)) {
          throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
        }
        registered.routes.push(route)
        return () => {
          const i = registered.routes.indexOf(route)
          if (i >= 0) registered.routes.splice(i, 1)
        }
      },
    },
  }
  const emit = (event, ...args) => {
    for (const fn of handlers.get(event) ?? []) fn(...args)
  }
  return { ctx, emit, logs, registered, services, pressure }
}

const fakeRes = () => {
  const out = { code: null, body: null }
  return {
    out,
    writeHead: (code) => { out.code = code },
    end: (buf) => { out.body = JSON.parse(buf.toString('utf8')) },
  }
}

// 提醒是刻意不阻塞的（不能为了弹气泡把回合结束的串行分发卡住），
// 所以 fire() 的日志落在微任务里 —— 断言前要放行一轮宏任务。
const flush = () => new Promise((resolve) => setImmediate(resolve))

test('插件导出 name / inject 的形状正确', () => {
  assert.equal(name, 'dsh-context-alert')
  assert.ok(Array.isArray(inject))
  assert.ok(inject.includes('commands'))
  assert.ok(inject.includes('webServer'))
})

test('注册了 /ctxalert 命令与三个 HTTP 路由', () => {
  const h = makeCtx()
  apply(h.ctx)
  assert.deepEqual(h.registered.commands.map((c) => c.name), ['ctxalert'])
  assert.deepEqual(
    h.registered.routes.map((r) => r.path).sort(),
    ['/api/context-alert/settings', '/api/context-alert/state', '/api/context-alert/test'],
  )
})

test('关掉再打开（HMR 热重载）不会因重复路由失败', () => {
  // 回归测试：webServer.register() 只是返回 disposer、**不会**随插件卸载自动回收，
  // 且重复 (kind, path) 会直接抛 `webserver: duplicate exact route "…"`。
  // 裸调用的话冷启动没事，但插件管理页里"关掉再打开"走的是热重载，
  // 新 entry 的 apply() 会在旧路由还在表里时执行 → 抛错 → 整次启用失败（界面显示"异常"）。
  // 所以三条路由都必须用 ctx.effect 登记。
  const h = makeCtx()
  apply(h.ctx)
  assert.equal(h.registered.routes.length, 3, '三条路由')
  assert.equal(h.registered.effects.length, 3, '三条路由都必须登记成可回收的 effect')

  // 卸载：cordis 会把 effect 的 disposer 全跑一遍
  for (const e of h.registered.effects) e.dispose()
  assert.equal(h.registered.routes.length, 0, '卸载后路由表必须清空')

  // 重新 apply 同一个 ctx：旧路由已回收，不应抛
  h.registered.effects.length = 0
  assert.doesNotThrow(() => apply(h.ctx), '热重载不能因 duplicate route 失败')
  assert.equal(h.registered.routes.length, 3, '重载后路由重新就位')
})

test('压力越过阈值 + 回合结束 → 真的触发一次提醒', async () => {
  const session = { id: 'sess-1' }
  const h = makeCtx({ sessions: [session], pressure: { 'sess-1': stateAt(70) } })
  apply(h.ctx)

  // 用户在这个会话里发过消息
  h.emit('agent/inbox/inserted', { agent: { id: 'sess-1', session } })
  // 会话提交事件 → 压力被喂进去
  h.emit('session/event', session, { kind: 'x' })
  // 回合结束 → 该提醒了
  h.emit('agent/turn-stopping', { agent: { id: 'sess-1', session }, turn: 1 })
  await flush()

  const fired = h.logs.filter(([, m]) => m.includes('[演练] 本应提醒'))
  assert.equal(fired.length, 1, '应恰好提醒一次')
  assert.match(fired[0][1], /70%/)
  assert.match(fired[0][1], /toast/, '普通提醒默认走桌面通知')
})

test('子代理会话（用户没发过消息）不提醒', () => {
  const session = { id: 'sub-1' }
  const h = makeCtx({ sessions: [session], pressure: { 'sub-1': stateAt(95) } })
  apply(h.ctx)
  h.emit('session/event', session, { kind: 'x' })
  h.emit('agent/turn-stopping', { agent: { id: 'sub-1', session }, turn: 1 })
  assert.equal(h.logs.filter(([, m]) => m.includes('[演练] 本应提醒')).length, 0)
})

test('回合结束时才提醒：中途压力再高也不打断', async () => {
  const session = { id: 'sess-2' }
  const h = makeCtx({ sessions: [session], pressure: { 'sess-2': stateAt(88) } })
  apply(h.ctx)
  h.emit('agent/inbox/inserted', { agent: { id: 'sess-2', session } })
  for (let i = 0; i < 5; i++) h.emit('session/event', session, { kind: 'x' })
  await flush()
  assert.equal(h.logs.filter(([, m]) => m.includes('[演练] 本应提醒')).length, 0, '还没到回合结束')
  h.emit('agent/turn-stopping', { agent: { id: 'sess-2', session }, turn: 1 })
  await flush()
  const fired = h.logs.filter(([, m]) => m.includes('[演练] 本应提醒'))
  assert.equal(fired.length, 1)
  assert.match(fired[0][1], /critical/)
  assert.match(fired[0][1], /both/, '紧急提醒默认语音+桌面')
})

test('session/disposed 后记录被清掉', () => {
  const session = { id: 'sess-3' }
  const h = makeCtx({ sessions: [session], pressure: { 'sess-3': stateAt(70) } })
  apply(h.ctx)
  h.emit('agent/inbox/inserted', { agent: { id: 'sess-3', session } })
  h.emit('session/event', session, { kind: 'x' })
  h.emit('session/disposed', session)
  // 记录没了 → 重新来过时 userDriven 也是 false → 不提醒
  h.emit('agent/turn-stopping', { agent: { id: 'sess-3', session }, turn: 1 })
  assert.equal(h.logs.filter(([, m]) => m.includes('[演练] 本应提醒')).length, 0)
})

test('/ctxalert status 报出阈值与占用', async () => {
  const session = { id: 'sess-status' }
  const h = makeCtx({ sessions: [session], pressure: { 'sess-status': stateAt(70) } })
  apply(h.ctx)
  h.emit('agent/inbox/inserted', { agent: { id: 'sess-status', session } })
  h.emit('session/event', session, { kind: 'x' })

  const cmd = h.registered.commands[0]
  const out = await cmd.handler({ rawInput: 'status' })
  assert.equal(out.kind, 'success')
  assert.match(out.text, /warn 65% \/ critical 82%/)
  assert.match(out.text, /70%/)
  assert.match(out.text, /sess-sta/)
})

test('/ctxalert status 在没有压力数据时说清楚，而不是编数字', async () => {
  const h = makeCtx()
  apply(h.ctx)
  const out = await h.registered.commands[0].handler({ rawInput: '' })
  assert.equal(out.kind, 'success')
  assert.match(out.text, /还没有可读的上下文压力数据/)
})

test('/ctxalert off|on 落盘并立即生效', async () => {
  const h = makeCtx()
  apply(h.ctx)
  const cmd = h.registered.commands[0]

  const off = await cmd.handler({ rawInput: 'off' })
  assert.equal(off.kind, 'success')
  assert.match(off.text, /停用/)
  assert.equal(JSON.parse(readFileSync(join(CONFIG_HOME, 'config.json'), 'utf8')).enabled, false)

  // 停用后即使越过阈值也不提醒
  const session = { id: 'sess-off' }
  h.emit('agent/inbox/inserted', { agent: { id: 'sess-off', session } })
  h.services.sessionProjections.stateOf = () => stateAt(95)
  h.emit('session/event', session, { kind: 'x' })
  h.emit('agent/turn-stopping', { agent: { id: 'sess-off', session }, turn: 1 })
  assert.equal(h.logs.filter(([, m]) => m.includes('[演练] 本应提醒')).length, 0, '停用后不该提醒')

  const on = await cmd.handler({ rawInput: 'on' })
  assert.equal(on.kind, 'success')
  assert.match(on.text, /启用/)
})

test('/ctxalert warn= 改阈值；非法数字被拒', async () => {
  const h = makeCtx()
  apply(h.ctx)
  const cmd = h.registered.commands[0]

  const ok = await cmd.handler({ rawInput: 'warn=50 critical=70 rearm=30' })
  assert.equal(ok.kind, 'success')
  const saved = JSON.parse(readFileSync(join(CONFIG_HOME, 'config.json'), 'utf8'))
  assert.equal(saved.warnPct, 50)
  assert.equal(saved.criticalPct, 70)
  assert.equal(saved.rearmPct, 30)

  const bad = await cmd.handler({ rawInput: 'warn=abc' })
  assert.equal(bad.kind, 'error')
})

test('非法阈值组合被退回默认值，不静默接受', async () => {
  const h = makeCtx()
  apply(h.ctx)
  // rearm > warn 是没意义的组合
  const out = await h.registered.commands[0].handler({ rawInput: 'warn=30 critical=20' })
  assert.equal(out.kind, 'success')
  assert.match(out.text, /warn 65% \/ critical 82%/, '应退回默认阈值')
})

test('/ctxalert test 在演练模式下报告成功而不弹窗', async () => {
  const h = makeCtx()
  apply(h.ctx)
  const out = await h.registered.commands[0].handler({ rawInput: 'test critical' })
  assert.equal(out.kind, 'success')
  assert.match(out.text, /紧急测试提醒/)
})

test('未知子命令给出用法', async () => {
  const h = makeCtx()
  apply(h.ctx)
  const out = await h.registered.commands[0].handler({ rawInput: 'wat' })
  assert.equal(out.kind, 'error')
  assert.match(out.text, /用法/)
})

test('GET /api/context-alert/state 返回配置与实时占用', () => {
  const session = { id: 'sess-http' }
  const h = makeCtx({ sessions: [session], pressure: { 'sess-http': stateAt(70) } })
  apply(h.ctx)
  const route = h.registered.routes.find((r) => r.path === '/api/context-alert/state')
  const res = fakeRes()
  route.handler({ method: 'GET' }, res)
  assert.equal(res.out.code, 200)
  assert.equal(res.out.body.ok, true)
  assert.equal(res.out.body.config.warnPct, 65)
  assert.equal(res.out.body.sessions[0].pct, 70)
  assert.equal(res.out.body.sessions[0].id, 'sess-http')
})

test('POST /api/context-alert/settings 落盘并回读', async () => {
  const h = makeCtx()
  apply(h.ctx)
  const route = h.registered.routes.find((r) => r.path === '/api/context-alert/settings')

  const res = fakeRes()
  const body = JSON.stringify({ warnPct: 55, mode: 'sound' })
  await route.handler({ method: 'POST', async * [Symbol.asyncIterator] () { yield Buffer.from(body) } }, res)
  assert.equal(res.out.code, 200)
  assert.equal(res.out.body.config.warnPct, 55)
  assert.equal(res.out.body.config.mode, 'sound')

  const get = fakeRes()
  await route.handler({ method: 'GET' }, get)
  assert.equal(get.out.body.config.warnPct, 55)

  const bad = fakeRes()
  await route.handler({ method: 'DELETE' }, bad)
  assert.equal(bad.out.code, 405)
})

test('没有 token-meter 时插件仍加载并说清楚原因', () => {
  const h = makeCtx()
  h.services.sessionProjections = {} // 没有 stateOf
  apply(h.ctx)
  const warned = h.logs.filter(([lvl, m]) => lvl === 'warn' && m.includes('stateOf 不可用'))
  assert.equal(warned.length, 1)
  // 命令仍然注册，插件没有整体挂掉
  assert.equal(h.registered.commands.length, 1)
})

test('通知后端抛错时不影响事件链', async () => {
  const h = makeCtx()
  apply(h.ctx)
  const session = { id: 'sess-err' }
  h.emit('agent/inbox/inserted', { agent: { id: 'sess-err', session } })
  h.emit('session/event', session, { kind: 'x' })
  // 这里只是确保 turn-stopping 不抛（fire 内部已兜住所有异常）
  assert.doesNotThrow(() => {
    h.emit('agent/turn-stopping', { agent: { id: 'sess-err', session }, turn: 1 })
  })
})

// ── 压缩历史接线 ─────────────────────────────────────────────────────────
// 真实事件形状（取自本机会话日志）。
const C_START = (turn) => ({ type: 'compaction/start', seq: 1, time: 1000, data: { compactionId: 'a', turn } })
const C_SUMMARY = (shadowed) => ({ type: 'compaction/summary', seq: 2, time: 1100, data: { compactionId: 'a', shadowedTokenCount: shadowed } })
const C_END = (turn) => ({ type: 'compaction/end', seq: 3, time: 1200, data: { compactionId: 'a', turn } })
const C_PRUNE = (shadowed) => ({ type: 'compaction/prune', seq: 4, time: 1300, data: { shadowedTokenCount: shadowed } })

const fired = (h) => h.logs.filter(([, m]) => m.includes('[演练] 本应提醒'))

/**
 * 显式设定配置再跑。
 * 配置文件是**跨测试共享**的（同一个 DSH_CTX_ALERT_HOME），前面的用例
 * 会把 warnPct/mode 落盘，后面的用例就会读到 —— 不显式设定就会随执行顺序飘。
 */
async function configure (h, patch) {
  const route = h.registered.routes.find((r) => r.path === '/api/context-alert/settings')
  const res = fakeRes()
  const body = JSON.stringify(patch)
  await route.handler({ method: 'POST', async * [Symbol.asyncIterator] () { yield Buffer.from(body) } }, res)
  assert.equal(res.out.code, 200, '配置写入应成功')
}

/** 让每个用例都从一套确定的阈值出发。 */
const BASE_CFG = { enabled: true, warnPct: 65, criticalPct: 82, rearmPct: 45, cooldownMs: 0, maxAlertsPerSession: 3, mode: 'toast', criticalMode: 'both' }

test('会话日志里有两次压缩 → 提醒说"第三次"', async () => {
  const session = {
    id: 'sess-c',
    // 关键：方法名是 snapshotEvents，不是 session.events（后者不存在）
    snapshotEvents: () => [
      C_PRUNE(2118),
      C_START(3), C_SUMMARY(74314), C_END(3),
      C_START(9), C_SUMMARY(78463), C_END(9),
    ],
  }
  const h = makeCtx({ sessions: [session], pressure: { 'sess-c': stateAt(70) } })
  apply(h.ctx)
  await configure(h, BASE_CFG)
  h.emit('agent/inbox/inserted', { agent: { id: 'sess-c', session } })
  h.emit('session/event', session, { kind: 'x' })
  h.emit('agent/turn-stopping', { agent: { id: 'sess-c', session }, turn: 12 })
  await flush()

  const f = fired(h)
  assert.equal(f.length, 1)
  assert.match(f[0][1], /第三次自动压缩/, '标题要带序号')
  assert.match(f[0][1], /累计遮蔽 152,777 tokens/, '要带累计遮蔽量（74314 + 78463）')
  assert.match(f[0][1], /信息丢失率约 52\.2%/, '152777 / (152777 + 140000)')
  assert.match(f[0][1], /最近一次（第 9 回合）遮蔽了 78,463 tokens/, '要带实测的遮蔽量')
  assert.match(f[0][1], /另有 2,118 tokens 的工具输出被修剪/, '修剪单独说')
})

test('日志里有失败压缩 → 不计入次数，并在提醒里说明', async () => {
  // 失败路径：start → end{ error }，且没有 summary（dsh-compaction-basic 0.2.2-rc.1）。
  // 一次成功 + 一次失败 → 下一次压缩仍然是"第二次"，不是"第三次"。
  const session = {
    id: 'sess-f',
    snapshotEvents: () => [
      C_START(3), C_SUMMARY(74314), C_END(3),
      { type: 'compaction/start', seq: 4, time: 1400, data: { compactionId: 'b', turn: 5 } },
      { type: 'compaction/end', seq: 5, time: 1500, data: { compactionId: 'b', turn: 5, error: 'boom' } },
    ],
  }
  const h = makeCtx({ sessions: [session], pressure: { 'sess-f': stateAt(70) } })
  apply(h.ctx)
  await configure(h, BASE_CFG)
  h.emit('agent/inbox/inserted', { agent: { id: 'sess-f', session } })
  h.emit('session/event', session, { kind: 'x' })
  h.emit('agent/turn-stopping', { agent: { id: 'sess-f', session }, turn: 12 })
  await flush()

  const f = fired(h)
  assert.equal(f.length, 1)
  assert.match(f[0][1], /第二次自动压缩/, '失败那次不算成功，序数不能跳到第三次')
  assert.match(f[0][1], /另有 1 次压缩失败/, '失败要在提醒里说明')
})

test('会话没压缩过 → 提醒说"第一次"', async () => {
  const session = { id: 'sess-d', snapshotEvents: () => [{ type: 'tool/call' }] }
  const h = makeCtx({ sessions: [session], pressure: { 'sess-d': stateAt(70) } })
  apply(h.ctx)
  await configure(h, BASE_CFG)
  h.emit('agent/inbox/inserted', { agent: { id: 'sess-d', session } })
  h.emit('session/event', session, { kind: 'x' })
  h.emit('agent/turn-stopping', { agent: { id: 'sess-d', session }, turn: 1 })
  await flush()
  assert.match(fired(h)[0][1], /第一次自动压缩/)
})

test('读不到会话日志时不谎称"第一次"，并留下告警', async () => {
  // 没有 snapshotEvents 的会话（或 API 改名）→ 必须退化成不带序数的说法
  const session = { id: 'sess-e' }
  const h = makeCtx({ sessions: [session], pressure: { 'sess-e': stateAt(70) } })
  apply(h.ctx)
  await configure(h, BASE_CFG)
  h.emit('agent/inbox/inserted', { agent: { id: 'sess-e', session } })
  h.emit('session/event', session, { kind: 'x' })
  h.emit('agent/turn-stopping', { agent: { id: 'sess-e', session }, turn: 1 })
  await flush()

  const f = fired(h)
  assert.equal(f.length, 1)
  assert.doesNotMatch(f[0][1], /第一次/, '不知道就不许说第一次')
  assert.match(f[0][1], /上下文变重了/)
  assert.equal(h.logs.filter(([lvl, m]) => lvl === 'warn' && m.includes('读不到会话日志')).length, 1)
})

test('snapshotEvents 抛错也只是退化，不会让事件链崩掉', async () => {
  const session = { id: 'sess-f', snapshotEvents: () => { throw new Error('日志被锁') } }
  const h = makeCtx({ sessions: [session], pressure: { 'sess-f': stateAt(70) } })
  apply(h.ctx)
  await configure(h, BASE_CFG)
  h.emit('agent/inbox/inserted', { agent: { id: 'sess-f', session } })
  assert.doesNotThrow(() => h.emit('session/event', session, { kind: 'x' }))
  assert.doesNotThrow(() => h.emit('agent/turn-stopping', { agent: { id: 'sess-f', session }, turn: 1 }))
  await flush()
  assert.match(fired(h)[0][1], /上下文变重了/)
})

test('直播压缩事件也累加次数（不依赖重新读日志）', async () => {
  // 会话先被扫过一次（0 次压缩），之后现场发生一次压缩 → 下一次提醒要变"第二次"
  const session = { id: 'sess-g', snapshotEvents: () => [] }
  const h = makeCtx({ sessions: [session], pressure: { 'sess-g': stateAt(70) } })
  apply(h.ctx)
  await configure(h, BASE_CFG)
  h.emit('agent/inbox/inserted', { agent: { id: 'sess-g', session } })
  h.emit('session/event', session, { kind: 'x' })
  h.emit('agent/turn-stopping', { agent: { id: 'sess-g', session }, turn: 1 })
  await flush()
  assert.match(fired(h)[0][1], /第一次自动压缩/)

  // 现场压缩一次，然后占用跌回再涨回去，触发第二次提醒
  h.emit('session/event', session, C_START(2))
  h.emit('session/event', session, C_SUMMARY(50000))
  h.emit('session/event', session, C_END(2))
  h.services.sessionProjections.stateOf = () => stateAt(20)   // 回落到 rearm 以下
  h.emit('session/event', session, { kind: 'x' })
  h.services.sessionProjections.stateOf = () => stateAt(75)   // 再涨上来
  h.emit('session/event', session, { kind: 'x' })
  h.emit('agent/turn-stopping', { agent: { id: 'sess-g', session }, turn: 3 })
  await flush()

  const f = fired(h)
  assert.equal(f.length, 2, '应该有第二次提醒')
  assert.match(f[1][1], /第二次自动压缩/, '直播压缩事件把次数加上了')
})

test('state 路由带上横幅要用的序号措辞', async () => {
  const session = {
    id: 'sess-h',
    snapshotEvents: () => [C_START(1), C_SUMMARY(1000), C_END(1)],
  }
  const h = makeCtx({ sessions: [session], pressure: { 'sess-h': stateAt(70) } })
  apply(h.ctx)
  // 只有用户自己的会话才值得扫日志（子代理不提醒、也不给用户看）
  h.emit('agent/inbox/inserted', { agent: { id: 'sess-h', session } })
  const route = h.registered.routes.find((r) => r.path === '/api/context-alert/state')
  const res = fakeRes()
  await route.handler({ method: 'GET' }, res)
  const row = res.out.body.sessions.find((r) => r.id === 'sess-h')
  assert.equal(row.compactionCount, 1)
  assert.equal(row.compactionKnown, true)
  assert.equal(row.ordinalText, '第二次')
  assert.equal(row.lastShadowedTokens, 1000)
})

test('子代理会话不扫日志：没有 userDriven 就不付这个成本', async () => {
  let scanned = 0
  const session = {
    id: 'sub-scan',
    header: { delegationDepth: 2 },   // 子代理
    snapshotEvents: () => { scanned++; return [C_START(1), C_SUMMARY(1000), C_END(1)] },
  }
  const h = makeCtx({ sessions: [session], pressure: { 'sub-scan': stateAt(95) } })
  apply(h.ctx)
  const route = h.registered.routes.find((r) => r.path === '/api/context-alert/state')
  await route.handler({ method: 'GET' }, fakeRes())
  await route.handler({ method: 'GET' }, fakeRes())
  assert.equal(scanned, 0, '子代理会话不该被扫日志')

  // 用户在这个会话里发过消息之后才扫，且只扫一次
  h.emit('agent/inbox/inserted', { agent: { id: 'sub-scan', session } })
  await route.handler({ method: 'GET' }, fakeRes())
  await route.handler({ method: 'GET' }, fakeRes())
  assert.equal(scanned, 1, '每个会话只扫一次')
})

test('恢复进来的顶层会话也扫日志（否则重启后横幅一直显示兜底文案）', async () => {
  // 会话是恢复的 → 不会触发 agent/inbox/inserted → userDriven 还是 false。
  // 但 delegationDepth 为 0，说明这就是用户在用的会话，应当照扫。
  let scanned = 0
  const session = {
    id: 'resumed',
    header: { delegationDepth: 0 },
    snapshotEvents: () => { scanned++; return [C_START(1), C_SUMMARY(4242), C_END(1)] },
  }
  const h = makeCtx({ sessions: [session], pressure: { 'resumed': stateAt(70) } })
  apply(h.ctx)
  const route = h.registered.routes.find((r) => r.path === '/api/context-alert/state')
  const res = fakeRes()
  await route.handler({ method: 'GET' }, res)
  assert.equal(scanned, 1, '顶层会话应被扫描')
  const row = res.out.body.sessions.find((r) => r.id === 'resumed')
  assert.equal(row.ordinalText, '第二次', '横幅要能立刻拿到序号')
  assert.equal(row.userDriven, false, '但没发过消息的会话仍然不会被提醒')
})

test('没有 header 的会话按顶层处理（宁可多扫一次，也不要序号一直缺着）', async () => {
  let scanned = 0
  const session = {
    id: 'no-header',
    snapshotEvents: () => { scanned++; return [] },
  }
  const h = makeCtx({ sessions: [session], pressure: { 'no-header': stateAt(70) } })
  apply(h.ctx)
  const route = h.registered.routes.find((r) => r.path === '/api/context-alert/state')
  await route.handler({ method: 'GET' }, fakeRes())
  assert.equal(scanned, 1)
})
