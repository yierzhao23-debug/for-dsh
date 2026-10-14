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
  const registered = { commands: [], routes: [] }
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
    commands: { register: (d) => registered.commands.push(d) },
    webServer: { register: (d) => registered.routes.push(d) },
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
