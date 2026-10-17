/**
 * 客户端半边的测试。
 *
 * ⚠️ 这不是视觉验证。本会话没有浏览器控制，官方验证指南也明确禁止用
 * 模拟 React/DOM 的方式冒充真机验证。这里只做三件**非视觉**的事：
 *
 *  1. 把 client bundle 真的加载起来（假 ModuleLoader），确认它注册了
 *     正确的 slot，并且 dock 注册带了 `inject(sessionId)`；
 *  2. **冒烟调用**两个组件，确认它们不抛异常 —— 这能抓到"引用了不存在的
 *     标识符"这类 bug（例如手滑写了一个没定义的 deps 变量）。这类 bug 在
 *     真机上表现为**整个 slot 条目被清空**（控制台 "slot entry crashed"），
 *     而它恰恰是 `node --check` 抓不到的。
 *  3. 顺手断言渲染出来的**文本**。（用的是一个三行的 createElement 桩，
 *     不是 DOM 仿真，也不能代表真实渲染效果。）
 *
 * 真正的视觉确认仍需你重启 DSH 后自己看一眼。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE = join(HERE, '..', 'client.js')

/** 最小 React 桩：只提供本插件用到的三个 API。 */
function makeReact () {
  const hooks = { states: [] }
  return {
    hooks,
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (init) => { hooks.states.push(init); return [init, () => {}] },
    useEffect: () => {},
    useMemo: (fn) => fn(),
  }
}

/** 在假的 ModuleLoader 里加载 client bundle，返回 { spec, plugin, react }。 */
function loadBundle () {
  const src = readFileSync(BUNDLE, 'utf8')
  const react = makeReact()
  let captured = null
  const win = { __ModuleLoader__: { load: (spec) => { captured = spec } } }
  const requireStub = (name) => {
    if (name === 'react') return react
    throw new Error(`client bundle 不该 require("${name}")`)
  }
  // 用 Function 构造器执行 bundle，避免污染全局。
  new Function('window', 'require', src)(win, requireStub)
  assert.ok(captured !== null, 'bundle 应调用 __ModuleLoader__.load')
  return { spec: captured, plugin: captured.factory(requireStub), react }
}

/** 假的 slots 服务，记录每次注册。 */
function makeCtx () {
  const registered = []
  let bootFns = []
  return {
    registered,
    ctx: {
      slots: {
        inject (_name, cb) { bootFns.push(cb) },
        register (descriptor, component) {
          registered.push({ descriptor, component })
          return () => {}
        },
      },
    },
    // 模拟 runner 调用每个 inject 回调
    boot () { for (const fn of bootFns) fn() },
  }
}

/** 把元素树里的文本片段全部收集起来（用于断言文案）。 */
function textOf (node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const n of node) textOf(n, out); return out }
  if (typeof node === 'object' && node.children !== undefined) {
    if (node.props && typeof node.props === 'object') {
      const st = node.props.style
      if (st && typeof st === 'object' && typeof st.color === 'string' && st.color.startsWith('var(')) { /* 样式里的令牌不算文本 */ }
    }
    for (const c of node.children) textOf(c, out)
  }
  return out
}

// ── 模块注册 ─────────────────────────────────────────────────────────────
test('client bundle 的模块 id 等于包名，且只 inject slots', () => {
  const { spec, plugin } = loadBundle()
  assert.equal(spec.id, 'dsh-context-alert')
  assert.equal(typeof spec.factory, 'function')
  assert.deepEqual(plugin.inject, ['slots'])
})

test('注册了两个 slot：聊天区横幅 + 设置分区', () => {
  const { plugin } = loadBundle()
  const h = makeCtx()
  plugin.apply(h.ctx)
  h.boot()
  const byId = new Map(h.registered.map((r) => [r.descriptor.id, r]))
  assert.ok(byId.has('context-alert'), '应注册 id=context-alert')

  const dock = h.registered.find((r) => r.descriptor.name === 'conversation.input.dock')
  const settings = h.registered.find((r) => r.descriptor.name === 'settings.section')
  assert.ok(dock !== undefined, '应注册 conversation.input.dock')
  assert.ok(settings !== undefined, '应注册 settings.section')
  assert.equal(settings.descriptor.label, '上下文提醒')
})

test('dock 注册必须带 inject(sessionId) —— 否则横幅认不出自己属于哪个会话', () => {
  // 这是真踩过的坑：dock 组件的 props 里没有 session，
  // 内置 TodoDock 的签名就是 ({ useProjection, t })。
  // 少了这个 inject，横幅永远拿不到"第几次压缩"，只会显示兜底文案。
  const { plugin } = loadBundle()
  const h = makeCtx()
  plugin.apply(h.ctx)
  h.boot()
  const dock = h.registered.find((r) => r.descriptor.name === 'conversation.input.dock')
  assert.equal(typeof dock.descriptor.inject, 'function', 'dock 注册必须提供 inject 函数')
  assert.deepEqual(dock.descriptor.inject('sess-abc'), { sessionId: 'sess-abc' })
})

// ── 冒烟调用（抓自由标识符，不抓视觉）────────────────────────────────────
test('横幅组件冒烟：不抛异常，且兜底文案出现在元素树里', () => {
  const { plugin } = loadBundle()
  const h = makeCtx()
  plugin.apply(h.ctx)
  h.boot()
  const dock = h.registered.find((r) => r.descriptor.name === 'conversation.input.dock')

  // 70% 越过默认 warnPct=65 → 必须渲染
  const props = {
    sessionId: 'sess-abc',
    t: (k) => k,
    useProjection: (key) => (key === 'contextPressure'
      ? { contextWindow: 262144, projectedTokens: 183957 }
      : null),
  }
  let tree
  assert.doesNotThrow(() => { tree = dock.component(props) }, '横幅渲染不能抛（一抛整个 slot 就空了）')
  const text = textOf(tree).join('')
  assert.match(text, /70\.2%/, '应显示百分比')
  assert.match(text, /183,957 \/ 262,144 tokens/, '应显示用量')
})

test('横幅常驻：低占用时只渲染"压过几次 + 丢失率"，不重复官方环的占用率', () => {
  const { plugin } = loadBundle()
  const h = makeCtx()
  plugin.apply(h.ctx)
  h.boot()
  const dock = h.registered.find((r) => r.descriptor.name === 'conversation.input.dock')

  // 12% —— 远低于 warnPct=65，但横幅仍应出现（bannerAlways 默认 true）
  const low = { sessionId: 's', t: (k) => k, useProjection: () => ({ contextWindow: 262144, projectedTokens: 32500 }) }
  let tree
  assert.doesNotThrow(() => { tree = dock.component(low) }, '常驻模式下低占用也要渲染')
  const text = textOf(tree).join('')
  // 没预置 stateCache → 压缩历史未知，必须说"未知"而不是编一个次数
  assert.match(text, /压缩次数未知/, '拿不到宿主状态时说未知，不编次数')
  // 分工：占用率与 token 用量归官方 ContextMeter（它渲染在输入栏的 dock 里，
  // 紧挨在本横幅下方）。同一区域上下并排显示同一个数字，只会让人怀疑哪个是准的。
  // 下面两条断言就是防止这次重构被改回去的那道闸。
  assert.doesNotMatch(text, /12\.4%/, '平时不再重复占用率（官方环已有）')
  assert.doesNotMatch(text, /tokens/, '平时不再重复 token 用量（官方环已有）')
  assert.doesNotMatch(text, /即将开始/, '低占用不该出现警告标题')
})

test('横幅常驻：压过 2 次时，平时一行里带次数与丢失率', () => {
  const { plugin } = loadBundle()
  const h = makeCtx()
  plugin.apply(h.ctx)
  h.boot()
  const dock = h.registered.find((r) => r.descriptor.name === 'conversation.input.dock')

  // 预置 stateCache，让横幅能拿到宿主算好的压缩历史
  plugin.__test__.setStateCache({ at: Date.now(), rows: [{
    id: 's', compactionKnown: true, compactionCount: 2,
    shadowedTotal: 152777, lossPct: 52.2, lastShadowedTokens: 78463, lastTurn: 9,
  }] })
  try {
    const low = { sessionId: 's', t: (k) => k, useProjection: () => ({ contextWindow: 262144, projectedTokens: 32500 }) }
    const text = textOf(dock.component(low)).join('')
    assert.match(text, /已压缩 2 次/, '平时也要说压过几次')
    assert.match(text, /信息丢失率 52\.2%/, '平时也要说丢失率')
    assert.doesNotMatch(text, /32,500/, '平时不再重复 token 用量（官方环已有）')
  } finally { plugin.__test__.clear() }
})

test('横幅常驻：从未压缩时说"尚未发生"，且丢失率为 0 也要说', () => {
  const { plugin } = loadBundle()
  const h = makeCtx()
  plugin.apply(h.ctx)
  h.boot()
  const dock = h.registered.find((r) => r.descriptor.name === 'conversation.input.dock')

  plugin.__test__.setStateCache({ at: Date.now(), rows: [{
    id: 's', compactionKnown: true, compactionCount: 0,
    shadowedTotal: 0, lossPct: 0, lastShadowedTokens: null, lastTurn: null,
  }] })
  try {
    const low = { sessionId: 's', t: (k) => k, useProjection: () => ({ contextWindow: 262144, projectedTokens: 32500 }) }
    const text = textOf(dock.component(low)).join('')
    assert.match(text, /尚未发生上下文压缩/)
    assert.match(text, /信息丢失率 0%/)
  } finally { plugin.__test__.clear() }
})

test('bannerAlways=false 时退回旧行为：低占用不渲染', () => {
  const { plugin } = loadBundle()
  const h = makeCtx()
  plugin.apply(h.ctx)
  h.boot()
  const dock = h.registered.find((r) => r.descriptor.name === 'conversation.input.dock')

  plugin.__test__.setConfigCache({ enabled: true, warnPct: 65, criticalPct: 82, minWindow: 8000, bannerAlways: false })
  try {
    const low = { sessionId: 's', t: (k) => k, useProjection: () => ({ contextWindow: 262144, projectedTokens: 32500 }) }
    assert.equal(dock.component(low), null, '关掉常驻后低占用不渲染')
  } finally { plugin.__test__.clear() }
})

test('横幅冒烟：useProjection 缺失 / 抛错也不崩（slot 一崩整个条目就空了）', () => {
  const { plugin } = loadBundle()
  const h = makeCtx()
  plugin.apply(h.ctx)
  h.boot()
  const dock = h.registered.find((r) => r.descriptor.name === 'conversation.input.dock')

  // useProjection 缺失 / 抛错 → 必须安静退化，不能把 slot 弄崩
  assert.doesNotThrow(() => { dock.component({ sessionId: 's', t: (k) => k }) })
  assert.doesNotThrow(() => { dock.component({ sessionId: 's', t: (k) => k, useProjection: () => { throw new Error('x') } }) })
  assert.doesNotThrow(() => { dock.component({}) })
})

test('设置分区组件冒烟：不抛异常', () => {
  const { plugin } = loadBundle()
  const h = makeCtx()
  plugin.apply(h.ctx)
  h.boot()
  const settings = h.registered.find((r) => r.descriptor.name === 'settings.section')
  // cfg 初始为 null → 渲染"加载中…"，这条路径不碰网络也不碰主题令牌之外的东西
  assert.doesNotThrow(() => { settings.component({ t: (k) => k }) })
})
