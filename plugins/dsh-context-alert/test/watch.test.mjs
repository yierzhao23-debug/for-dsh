import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULTS,
  occupancyOf,
  createWatcher,
  alertMessage,
  alertTitle,
  compactLine,
  compactionHistory,
  emptyCompaction,
  fmtTokens,
  foldCompaction,
  lossIsMeaningful,
  lossRatePct,
  ordinal,
  ordinalPhrase,
} from '../watch.js'

const WIN = 200000

// ── occupancyOf：两种 shape 都要吃，拿不到就返回 null ────────────────────────
test('occupancyOf 读宿主 state（surface 差值口径）', () => {
  const occ = occupancyOf({
    contextWindow: WIN,
    pressureTokens: 100000,
    surfaceTokens: 42000,
    sampledSurfaceTokens: 40000,
  })
  // 100000 + 42000 - 40000 = 102000 → 51%
  assert.equal(occ.used, 102000)
  assert.equal(occ.pct, 51)
})

test('occupancyOf 优先用 wire view 的 projectedTokens', () => {
  const occ = occupancyOf({ contextWindow: WIN, pressureTokens: 1, projectedTokens: 150000 })
  assert.equal(occ.used, 150000)
  assert.equal(occ.pct, 75)
})

test('occupancyOf 只有 pressureTokens 时退回它', () => {
  assert.equal(occupancyOf({ contextWindow: WIN, pressureTokens: 50000 }).pct, 25)
})

test('occupancyOf 拿不到窗口/用量就返回 null，不编数字', () => {
  assert.equal(occupancyOf(null), null)
  assert.equal(occupancyOf(undefined), null)
  assert.equal(occupancyOf({}), null)
  assert.equal(occupancyOf({ contextWindow: 0, pressureTokens: 10 }), null)
  assert.equal(occupancyOf({ contextWindow: WIN }), null)
  assert.equal(occupancyOf({ contextWindow: WIN, pressureTokens: NaN }), null)
  assert.equal(occupancyOf({ contextWindow: WIN, surfaceTokens: 5, sampledSurfaceTokens: 1 }), null)
})

test('occupancyOf 的 surface 差值按官方口径夹到 0，不报负数', () => {
  // 官方 wire.view 就是 max(0, pressure + surface - sampled)。压缩后 surface
  // 会小于采样时的值，差值转负 → 夹到 0。这个输入本身是"不一致"的
  // （pressure 与 sampled 不是同一时刻），真机上 self-correct 于下一次用量采样。
  // 对告警插件来说这是安全方向：宁可少报，不虚报。
  const occ = occupancyOf({
    contextWindow: WIN,
    pressureTokens: 30000,
    surfaceTokens: 1000,
    sampledSurfaceTokens: 90000,
  })
  assert.equal(occ.used, 0)
  assert.equal(occ.pct, 0)
})

// ── 阈值磁滞状态机 ────────────────────────────────────────────────────────
function stateFor (pct) {
  return { contextWindow: WIN, pressureTokens: Math.round((WIN * pct) / 100) }
}

test('低于 warnPct 不产出提醒', () => {
  const w = createWatcher()
  w.markUserDriven('s1')
  w.observe('s1', stateFor(50))
  assert.equal(w.takeAlert('s1'), null)
})

test('越过 warnPct 后取到提醒，且取走即清空', () => {
  const w = createWatcher()
  w.markUserDriven('s1')
  w.observe('s1', stateFor(70))
  const a = w.takeAlert('s1')
  assert.equal(a.level, 'warn')
  assert.equal(a.pct, 70)
  assert.equal(a.count, 1)
  assert.equal(w.takeAlert('s1'), null, '同一次越界只能提醒一次')
})

test('未标记 userDriven 的会话（子代理/后台）永不提醒', () => {
  const w = createWatcher()
  w.observe('sub', stateFor(95))
  assert.equal(w.takeAlert('sub'), null)
  w.markUserDriven('sub')
  assert.equal(w.takeAlert('sub')?.level, 'critical')
})

test('磁滞：不跌回 rearmPct 以下就不再次提醒', () => {
  const w = createWatcher({ cooldownMs: 0 })
  w.markUserDriven('s1')
  w.observe('s1', stateFor(70))
  assert.ok(w.takeAlert('s1'))
  w.observe('s1', stateFor(60)) // 仍在阈值附近抖动
  assert.equal(w.takeAlert('s1'), null)
  w.observe('s1', stateFor(30)) // 真跌下去了 → 重新上膛
  w.observe('s1', stateFor(70))
  assert.ok(w.takeAlert('s1'), '重新上膛后应能再提醒')
})

test('压缩后占用归零会重新上膛', () => {
  const w = createWatcher({ cooldownMs: 0 })
  w.markUserDriven('s1')
  w.observe('s1', stateFor(85))
  assert.equal(w.takeAlert('s1').level, 'critical')
  // 压缩把 surface 砍掉 → 官方口径下 projected 夹到 0 → 视为低占用，重新上膛
  w.observe('s1', {
    contextWindow: WIN,
    pressureTokens: 170000,
    surfaceTokens: 1000,
    sampledSurfaceTokens: 170000,
  })
  w.observe('s1', stateFor(85))
  assert.ok(w.takeAlert('s1'), '压缩后应重新获得提醒额度')
})

test('升级：已提醒 warn 后再到 critical 会再提醒一次', () => {
  const w = createWatcher()
  w.markUserDriven('s1')
  w.observe('s1', stateFor(70))
  assert.equal(w.takeAlert('s1').level, 'warn')
  w.observe('s1', stateFor(90))
  const a = w.takeAlert('s1')
  assert.equal(a.level, 'critical')
  assert.equal(a.count, 2)
})

test('冷却时间内的同级提醒被压住', () => {
  const w = createWatcher({ cooldownMs: 60000 })
  w.markUserDriven('s1')
  const t0 = 1_000_000
  w.observe('s1', stateFor(70))
  assert.ok(w.takeAlert('s1', t0))
  w.observe('s1', stateFor(30))
  w.observe('s1', stateFor(70))
  assert.equal(w.takeAlert('s1', t0 + 30000), null, '冷却中')
  assert.ok(w.takeAlert('s1', t0 + 61000), '冷却结束后可提醒')
})

test('紧急升级绕过冷却：用户忽略 warn 后贴到压缩线必须立刻说', () => {
  const w = createWatcher({ cooldownMs: 600000 }) // 冷却 10 分钟
  w.markUserDriven('s1')
  const t0 = 1_000_000
  w.observe('s1', stateFor(70))
  assert.equal(w.takeAlert('s1', t0).level, 'warn')
  w.observe('s1', stateFor(90))
  const crit = w.takeAlert('s1', t0 + 60000) // 只过了 1 分钟，仍在冷却里
  assert.ok(crit, '紧急提醒不应被冷却压住')
  assert.equal(crit.level, 'critical')
})

test('每会话硬上限生效', () => {
  const w = createWatcher({ cooldownMs: 0, maxAlertsPerSession: 2 })
  w.markUserDriven('s1')
  let got = 0
  for (let i = 0; i < 5; i++) {
    w.observe('s1', stateFor(30))
    w.observe('s1', stateFor(70))
    if (w.takeAlert('s1')) got++
  }
  assert.equal(got, 2, '超过上限后不再提醒')
})

test('enabled=false 时完全不提醒', () => {
  const w = createWatcher({ enabled: false })
  w.markUserDriven('s1')
  w.observe('s1', stateFor(95))
  assert.equal(w.takeAlert('s1'), null)
})

test('窗口小于 minWindow 的会话被忽略', () => {
  const w = createWatcher()
  w.markUserDriven('s1')
  w.observe('s1', { contextWindow: 4000, pressureTokens: 3900 })
  assert.equal(w.takeAlert('s1'), null)
})

test('snapshot / forget / reset', () => {
  const w = createWatcher()
  w.markUserDriven('s1')
  w.observe('s1', stateFor(70))
  assert.equal(w.snapshot().length, 1)
  assert.equal(w.snapshot()[0].pct, 70)
  w.forget('s1')
  assert.equal(w.snapshot().length, 0)
  w.observe('s2', stateFor(10))
  w.reset()
  assert.equal(w.snapshot().length, 0)
})

test('默认配置贴着 dsh-compaction-basic 的 thresholdRatio', () => {
  assert.equal(DEFAULTS.criticalPct, 82)
  assert.ok(DEFAULTS.rearmPct < DEFAULTS.warnPct)
  assert.ok(DEFAULTS.warnPct < DEFAULTS.criticalPct)
})

// ── 文案 ─────────────────────────────────────────────────────────────────
test('文案带上百分比与用量，且区分 warn/critical', () => {
  const warn = alertMessage({ level: 'warn', pct: 70, used: 140000, window: 200000 })
  assert.match(warn, /70%/)
  assert.match(warn, /140,000 \/ 200,000 tokens/)
  const crit = alertMessage({ level: 'critical', pct: 90, used: 180000, window: 200000 })
  assert.match(crit, /90%/)
  assert.match(crit, /压缩/)
  assert.notEqual(alertTitle({ level: 'warn' }), alertTitle({ level: 'critical' }))
})

test('fmtTokens 对缺失值不撒谎', () => {
  assert.equal(fmtTokens(200000), '200,000')
  assert.equal(fmtTokens(null), '?')
  assert.equal(fmtTokens(undefined), '?')
})

// ── 压缩历史 ─────────────────────────────────────────────────────────────
// 事件形状取自本机真实会话日志（session.v4.jsonl.zstd）。
const START = (turn) => ({ type: 'compaction/start', seq: 1, time: 1000, data: { compactionId: 'a', turn } })
const SUMMARY = (shadowed) => ({ type: 'compaction/summary', seq: 2, time: 1100, data: { compactionId: 'a', shadowedTokenCount: shadowed } })
const END = (turn) => ({ type: 'compaction/end', seq: 3, time: 1200, data: { compactionId: 'a', turn } })
const PRUNE = (shadowed) => ({ type: 'compaction/prune', seq: 4, time: 1300, data: { shadowedRange: { start: 21, end: 21 }, shadowedSeqs: [21], shadowedTokenCount: shadowed } })

test('compactionHistory 数 compaction/start，不是数 prune', () => {
  // 真实日志里 prune 的数量和压缩次数完全不成比例（实测 4 个 prune 对 2 次压缩，
  // 12 个 prune 对 1 次压缩），把 prune 算进去就会数多。
  const info = compactionHistory([
    PRUNE(2118), PRUNE(2548),
    START(3), SUMMARY(74314), END(3),
    START(9), SUMMARY(78463), END(9),
  ])
  assert.equal(info.count, 2)
  assert.equal(info.lastShadowedTokens, 78463)
  assert.equal(info.lastTurn, 9)
  assert.equal(info.lastEndTime, 1200)
})

test('compactionHistory 没有压缩事件时是 0，且 known 为 true', () => {
  const info = compactionHistory([{ type: 'tool/call' }, { type: 'assistant/message' }])
  assert.equal(info.count, 0)
  assert.equal(info.lastShadowedTokens, null)
  assert.equal(info.known, true)
})

test('emptyCompaction 的 known 是 false —— 没读过日志就不许声称次数', () => {
  assert.equal(emptyCompaction().known, false)
  assert.equal(emptyCompaction().count, 0)
})

test('看到 summary/end 却没有 start → 判定事件名变了，不许声称次数', () => {
  // 模拟 DSH 把 compaction/start 改名的情况：summary 还在，start 认不出来。
  // 这时 count=0 是假的，必须降级成 known=false。
  const renamed = compactionHistory([
    { type: 'compaction/begin', seq: 1, time: 1, data: { turn: 3 } },
    SUMMARY(74314),
    END(3),
  ])
  assert.equal(renamed.count, 0)
  assert.equal(renamed.known, false, '不能对着压过三次的会话说"第一次"')
})

test('只有 prune（工具结果修剪）不算压缩，也不触发降级', () => {
  // prune 是独立机制，可以单独出现，不能当成"事件名变了"的证据。
  const onlyPrune = compactionHistory([PRUNE(2118), PRUNE(2548)])
  assert.equal(onlyPrune.count, 0)
  assert.equal(onlyPrune.known, true, 'prune 单独出现是正常的，不该降级')
})

test('foldCompaction 非就地，不改动传入的历史', () => {
  const before = emptyCompaction()
  const after = foldCompaction(before, START(1))
  assert.equal(before.count, 0)
  assert.equal(after.count, 1)
})

test('foldCompaction 对垃圾输入不炸，也不编造', () => {
  assert.equal(foldCompaction(null, null).count, 0)
  assert.equal(foldCompaction(undefined, { type: 'compaction/start' }).count, 1)
  assert.equal(foldCompaction(emptyCompaction(), { type: 'compaction/start', data: { turn: 'x' } }).lastTurn, null)
  assert.equal(foldCompaction(emptyCompaction(), { type: 'compaction/summary', data: {} }).lastShadowedTokens, null)
})

test('ordinal / ordinalPhrase 的中文序数', () => {
  assert.equal(ordinal(1), '一')
  assert.equal(ordinal(10), '十')
  assert.equal(ordinal(11), '11')
  assert.equal(ordinalPhrase(0), '第一次')
  assert.equal(ordinalPhrase(1), '第二次')
  assert.equal(ordinalPhrase(2), '第三次')
  assert.equal(ordinalPhrase(10), '第11次')
})

test('标题把"第几次压缩"顶到最前面', () => {
  const first = alertTitle({ level: 'warn', compactionKnown: true, compactionCount: 0 })
  assert.equal(first, '即将开始本对话的第一次自动压缩')
  const fourth = alertTitle({ level: 'warn', compactionKnown: true, compactionCount: 3 })
  assert.equal(fourth, '即将开始本对话的第四次自动压缩')
  assert.match(alertTitle({ level: 'critical', compactionKnown: true, compactionCount: 0 }), /随时会触发/)
})

test('历史不可知时不带序数，也不说"上次遮蔽了多少"', () => {
  const unknown = { level: 'warn', compactionKnown: false, compactionCount: 0, pct: 70, used: 1, window: 2 }
  assert.equal(alertTitle(unknown), '上下文变重了，建议换会话')
  const msg = alertMessage({ ...unknown, lastShadowedTokens: 78463, lastTurn: 9 })
  assert.doesNotMatch(msg, /遮蔽/)
  assert.doesNotMatch(msg, /第 9 回合/)
})

test('正文写实测的遮蔽量，并且只把压缩线当上界说', () => {
  const msg = alertMessage({
    level: 'warn', pct: 84.1, used: 220400, window: 262144,
    compactionKnown: true, compactionCount: 2,
    shadowedTotal: 152777, lossPct: 40.9,
    lastShadowedTokens: 78463, lastTurn: 9,
    compactPct: 80, headroomTokens: 65536,
  })
  assert.match(msg, /已压缩 2 次/)
  assert.match(msg, /累计遮蔽 152,777 tokens/)
  assert.match(msg, /信息丢失率约 40\.9%/)
  assert.match(msg, /最近一次（第 9 回合）遮蔽了 78,463 tokens/)
  assert.match(msg, /不晚于窗口 80%/)
  assert.match(msg, /209,715/)          // 262144 * 0.8 向下取整
  assert.match(msg, /可能更早/)          // 不谎称那是精确触发点
  assert.doesNotMatch(msg, /还有.*tokens.*才/)  // 绝不出现"距压缩线还有 N"
})

test('压过但遮蔽数据缺失时不报丢失率（避免"遮蔽了 7 万却说 0%"）', () => {
  // lossPct 本该由宿主把关，但 alertMessage 也要自保：shadowedTotal=0 时不许说丢失率
  const msg = alertMessage({
    level: 'warn', pct: 70, used: 140000, window: 200000,
    compactionKnown: true, compactionCount: 2,
    shadowedTotal: 0, lossPct: 0,          // ← 矛盾输入：压过 2 次却没有任何遮蔽数
    lastShadowedTokens: 78463, lastTurn: 9,
  })
  assert.match(msg, /已压缩 2 次/)
  assert.match(msg, /最近一次（第 9 回合）遮蔽了 78,463 tokens/)
  assert.doesNotMatch(msg, /丢失率/)
})

test('一次都没压过时说"信息都还在"，不报丢失率数字', () => {
  const msg = alertMessage({
    level: 'warn', pct: 70, used: 140000, window: 200000,
    compactionKnown: true, compactionCount: 0, shadowedTotal: 0, lossPct: 0,
  })
  assert.match(msg, /还没有压缩过，信息都还在/)
  assert.doesNotMatch(msg, /丢失率/)
  assert.doesNotMatch(msg, /遮蔽/)
})

test('工具修剪单独说，不混进压缩次数', () => {
  const msg = alertMessage({
    level: 'warn', pct: 70, used: 140000, window: 200000,
    compactionKnown: true, compactionCount: 1,
    shadowedTotal: 87497, lossPct: 38.5, prunedTotal: 2118,
    lastShadowedTokens: 87497, lastTurn: 3,
  })
  assert.match(msg, /已压缩 1 次/)          // prune 不算压缩次数
  assert.match(msg, /另有 2,118 tokens 的工具输出被修剪/)
  assert.doesNotMatch(msg, /已压缩 2 次/)
})

test('lossRatePct：口径是"累计遮蔽 ÷（累计遮蔽 + 当前上下文）"，且宁可低估', () => {
  assert.equal(lossRatePct(0, 50000), 0)        // 确定的 0，不是"不知道"
  assert.equal(lossRatePct(null, 50000), null)  // 历史不可知 → 不编
  assert.equal(lossRatePct(100, null), null)    // 没有当前用量 → 算不了
  assert.equal(lossRatePct(50000, 50000), 50)
  assert.equal(lossRatePct(150000, 50000), 75)
  assert.equal(lossRatePct(-5, 100), 0)         // 负数按无数据处理
})

test('lossIsMeaningful：压过但没遮蔽数据时不许展示丢失率', () => {
  assert.equal(lossIsMeaningful(0, 0), true)       // 没压过 → 0% 是确定的
  assert.equal(lossIsMeaningful(2, 152777), true)  // 有数据
  assert.equal(lossIsMeaningful(2, 0), false)      // 压过却没数据 → 别展示
  assert.equal(lossIsMeaningful(null, 0), true)    // 次数未知按 0 处理
})

test('compactLine 只在窗口与比例都有效时给上界', () => {
  assert.deepEqual(compactLine({ window: 100000, compactPct: 80 }), { pct: 80, tokens: 80000 })
  assert.equal(compactLine({ window: null, compactPct: 80 }), null)
  assert.equal(compactLine({ window: 0, compactPct: 80 }), null)
  assert.equal(compactLine({}), null)
})

test('setCompaction 把历史带进 takeAlert 的返回值', () => {
  const w = createWatcher({ warnPct: 50, criticalPct: 90, rearmPct: 10, cooldownMs: 0 })
  w.markUserDriven('s1')
  w.observe('s1', { contextWindow: 100000, pressureTokens: 60000 })
  w.setCompaction('s1', { count: 2, shadowedTotal: 152777, prunedTotal: 2118, lastShadowedTokens: 78463, lastTurn: 9, known: true })
  const alert = w.takeAlert('s1')
  assert.equal(alert.compactionCount, 2)
  assert.equal(alert.compactionKnown, true)
  assert.equal(alert.shadowedTotal, 152777)
  assert.equal(alert.prunedTotal, 2118)
  assert.equal(alert.lastShadowedTokens, 78463)
  assert.equal(alert.lastTurn, 9)
  assert.equal(alert.compactPct, DEFAULTS.compactPct)
  // 丢失率由宿主侧同一公式算出：152777 / (152777 + 60000) = 71.8%
  assert.equal(alert.lossPct, 71.8)
})

test('setCompaction 之后提醒文案真的变成"第三次"', () => {
  const w = createWatcher({ warnPct: 50, criticalPct: 90, rearmPct: 10, cooldownMs: 0 })
  w.markUserDriven('s1')
  w.observe('s1', { contextWindow: 100000, pressureTokens: 60000 })
  w.setCompaction('s1', { count: 2, shadowedTotal: 152777, lastShadowedTokens: 78463, lastTurn: 9, known: true })
  const alert = w.takeAlert('s1')
  assert.equal(alertTitle(alert), '即将开始本对话的第三次自动压缩')
  assert.match(alertMessage(alert), /已压缩 2 次/)
  assert.match(alertMessage(alert), /最近一次（第 9 回合）遮蔽了 78,463 tokens/)
})
