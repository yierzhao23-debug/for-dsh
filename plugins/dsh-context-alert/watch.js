/**
 * dsh-context-alert — 纯逻辑层（无 DSH 依赖，可脱离宿主单测）
 *
 * 数据来源：dsh-token-meter 注册的官方 `contextPressure` 投影。
 *   宿主端 stateOf() 返回内部 state：
 *     { contextWindow?, pressureTokens?, surfaceTokens, sampledSurfaceTokens?, claim? }
 *   客户端 useProjection() 返回 wire view：
 *     { contextWindow?, pressureTokens?, projectedTokens? }
 *   两者都吃，见 occupancyOf()。
 *
 * 占用率的官方口径（usage-projection.ts 的 wire.view）：
 *   projectedTokens = max(0, pressureTokens + surfaceTokens - sampledSurfaceTokens)
 * 其中 pressureTokens 是提供方报告的最新提示词规模，surfaceTokens 是当前保留
 * surface 的启发式规模，sampledSurfaceTokens 是那次采样时的 surface 规模。
 * 差值就是"采样之后又长出来的部分"——不这么算会低估（压缩后尤其明显）。
 */

/** 配置默认值。宿主与客户端共用。 */
export const DEFAULTS = {
  enabled: true,
  /** 到多少百分比开始提醒 */
  warnPct: 65,
  /** 到多少百分比算紧急（默认贴着 dsh-compaction-basic 的 thresholdRatio 0.8） */
  criticalPct: 82,
  /** 占用回落到这个百分比以下才重新"上膛"，避免在阈值附近反复唠叨 */
  rearmPct: 45,
  /** 同一会话两次提醒的最小间隔（毫秒） */
  cooldownMs: 10 * 60 * 1000,
  /** 同一会话最多提醒几次（硬上限，防止长会话被反复打断） */
  maxAlertsPerSession: 3,
  /** 普通提醒的通知方式 */
  mode: 'toast',
  /** 紧急提醒的通知方式（默认语音+桌面，因为这时候真的该停手换会话了） */
  criticalMode: 'both',
  /** 上下文窗口小于这个值就不提醒（小窗口模型刷得太快，提醒没意义） */
  minWindow: 8000,
}

const RANK = { ok: 0, warn: 1, critical: 2 }

/** 只接受有限非负数字；其余一律 null（不猜、不把 NaN 当 0）。 */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * 把 contextPressure 的 state 或 wire view 归一成占用率。
 * 拿不到窗口或用量时返回 null——**宁可什么都不说，也不编一个百分比**。
 *
 * @returns {{used:number, window:number, pct:number}|null}
 */
export function occupancyOf(state) {
  if (state === null || typeof state !== 'object') return null
  const window = num(state.contextWindow)
  if (window === null || window <= 0) return null

  let used = null
  const projected = num(state.projectedTokens)
  const pressure = num(state.pressureTokens)
  const surface = num(state.surfaceTokens)
  const sampled = num(state.sampledSurfaceTokens)

  if (projected !== null) {
    used = projected
  } else if (pressure !== null && surface !== null && sampled !== null) {
    used = Math.max(0, pressure + surface - sampled)
  } else if (pressure !== null) {
    used = pressure
  }
  if (used === null) return null

  return { used, window, pct: Math.min(100, Math.round((used / window) * 1000) / 10) }
}

function levelFor(pct, cfg) {
  if (pct >= cfg.criticalPct) return 'critical'
  if (pct >= cfg.warnPct) return 'warn'
  return 'ok'
}

/**
 * 每个会话一份的阈值磁滞状态机。
 *
 * 三条纪律：
 *  1. 只在"上膛"（pending 非 ok）且真的越过阈值时才产出提醒；
 *  2. 占用跌回 rearmPct 以下才允许下一次提醒（避免阈值附近抖动反复打扰）；
 *  3. 每个会话有硬上限和冷却时间，长会话不会被反复打断。
 */
export function createWatcher(config = {}) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) }
  const sessions = new Map()

  function rec(id) {
    let r = sessions.get(id)
    if (r === undefined) {
      r = {
        id,
        pct: null,
        used: null,
        window: null,
        level: 'ok',
        pending: 'ok',
        notifiedLevel: 'ok',
        notifyCount: 0,
        lastNotifyAt: 0,
        userDriven: false,
      }
      sessions.set(id, r)
    }
    return r
  }

  /**
   * 喂一次观测。任何一次会话事件后都可以调，代价是几次算术。
   * @returns 该会话的记录（便于调用方取 pct），无可用数据时返回 null
   */
  function observe(id, state) {
    const occ = occupancyOf(state)
    if (occ === null) return null
    if (occ.window < cfg.minWindow) return null

    const r = rec(id)
    r.pct = occ.pct
    r.used = occ.used
    r.window = occ.window

    const level = levelFor(occ.pct, cfg)
    r.level = level
    if (level === 'ok') {
      if (occ.pct <= cfg.rearmPct) {
        r.pending = 'ok'
        r.notifiedLevel = 'ok'
      }
    } else if (RANK[level] > RANK[r.notifiedLevel] && RANK[level] > RANK[r.pending]) {
      r.pending = level
    }
    return r
  }

  /** 标记这是"用户自己在用的会话"。子代理/后台会话不标记，于是不会被提醒。 */
  function markUserDriven(id) {
    if (typeof id !== 'string' || id === '') return null
    const r = rec(id)
    r.userDriven = true
    return r
  }

  /**
   * 取一次待发提醒（取走即清空 pending）。
   * 调用点应该是"回合结束"——用户正要决定下一条消息怎么发的时候。
   *
   * 冷却只压同级重复：**紧急升级直接放行**。如果用户忽略了 warn，
   * 两分钟后会话真的贴到压缩线，那时候再让他等 8 分钟是错的。
   * @returns {{id, level, pct, used, window, count}|null}
   */
  function takeAlert(id, now = Date.now()) {
    const r = sessions.get(id)
    if (r === undefined || !cfg.enabled) return null
    if (!r.userDriven) return null
    if (r.pending === 'ok') return null
    if (r.notifyCount >= cfg.maxAlertsPerSession) return null

    const level = r.pending
    const cooling = now - r.lastNotifyAt < cfg.cooldownMs
    if (cooling && level !== 'critical') return null

    r.pending = 'ok'
    r.notifiedLevel = level
    r.notifyCount += 1
    r.lastNotifyAt = now
    return { id, level, pct: r.pct, used: r.used, window: r.window, count: r.notifyCount }
  }

  function snapshot() {
    return [...sessions.values()].map((r) => ({ ...r }))
  }

  function forget(id) {
    return sessions.delete(id)
  }

  function reset() {
    sessions.clear()
  }

  return { config: cfg, observe, markUserDriven, takeAlert, snapshot, forget, reset }
}

/** 千分位，给通知文案用。 */
export function fmtTokens(n) {
  const v = num(n)
  return v === null ? '?' : Math.round(v).toLocaleString('en-US')
}

/** 提醒文案。宿主与客户端共用同一套措辞。 */
export function alertMessage(alert) {
  const pct = alert.pct === null ? '?' : alert.pct
  const figures = `${fmtTokens(alert.used)} / ${fmtTokens(alert.window)} tokens`
  if (alert.level === 'critical') {
    return `当前会话上下文已用 ${pct}%（${figures}），已经贴到自动压缩线。再聊下去旧内容会被压成摘要、细节就找不回来了——现在开个新会话最划算。`
  }
  return `当前会话上下文已用 ${pct}%（${figures}），这个会话开始变重了。如果接下来还要做多步的长任务，建议开个新会话。`
}

export function alertTitle(alert) {
  return alert.level === 'critical' ? '该换会话了（上下文接近压缩线）' : '上下文变重了，建议换会话'
}
