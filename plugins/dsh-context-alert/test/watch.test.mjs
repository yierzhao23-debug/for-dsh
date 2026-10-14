import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULTS,
  occupancyOf,
  createWatcher,
  alertMessage,
  alertTitle,
  fmtTokens,
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
