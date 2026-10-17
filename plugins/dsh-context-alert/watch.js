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
  /**
   * 横幅是否常驻。
   * true（默认）= 只要拿得到窗口读数就一直显示，平时用一行小字报
   *   "已压缩几次 + 信息丢失率"，越过阈值才展开成醒目的多行。
   * false = 退回旧行为，只在越过 warnPct 时才出现。
   */
  bannerAlways: true,
  /**
   * 自动压缩线占窗口的比例，用于文案里的"压缩线不晚于 X%"。
   * 对应 dsh-compaction-basic 的 thresholdRatio（默认 0.8）。
   * 注意它只是**上界**：真实触发点是 floor(min(W×ratio, W−O−headroom))，
   * 其中 O 是路由的输出预留、headroom 是额外余量。O 在插件侧读不到，
   * 所以这里绝不算"距压缩线还有 N tokens"——那会给出虚假的安心。
   */
  compactPct: 80,
  /** 与 dsh-compaction-basic 的 headroomTokens 保持一致，仅用于文案说明 */
  headroomTokens: 65536,
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

// ── 压缩历史 ─────────────────────────────────────────────────────────────
//
// 事件形状实测自本机会话日志（session.v4.jsonl.zstd，逐帧 zstd + JSONL）：
//   compaction/start   { compactionId, turn }
//   compaction/summary { compactionId, shadowedTokenCount, shadowedRange, usage, ... }
//   compaction/end     { compactionId, turn }
//   compaction/prune   { shadowedRange, shadowedSeqs, shadowedTokenCount }   ← 不是一次压缩
//
// 一次压缩 = 一个 compaction/start。compaction/prune 是工具结果修剪，必须排除，
// 否则会把压缩次数算多（实测日志里 prune 的数量和压缩次数完全不成比例）。

/** 空历史。known=false 表示还没读过日志，此时**不允许**声称"第几次"。 */
export function emptyCompaction() {
  return {
    count: 0,
    /** 累计被压缩遮蔽掉的原始 token 数（只统计 compaction，不含 prune） */
    shadowedTotal: 0,
    /** 累计被工具结果修剪掉的 token 数（机制不同，单独记） */
    prunedTotal: 0,
    lastShadowedTokens: null,
    lastTurn: null,
    lastEndTime: null,
    known: false,
  }
}

/**
 * 把一个会话事件折进压缩历史（非就地，返回新对象）。
 * @param {object|null} info 现有历史
 * @param {object|null} event 会话事件 { type, seq, time, data }
 */
export function foldCompaction(info, event) {
  const out = { ...(info ?? emptyCompaction()) }
  if (event === null || typeof event !== 'object') return out
  const data = event.data !== null && typeof event.data === 'object' ? event.data : {}

  if (event.type === 'compaction/start') {
    out.count += 1
    const turn = num(data.turn)
    if (turn !== null) out.lastTurn = turn
  } else if (event.type === 'compaction/summary') {
    const shadowed = num(data.shadowedTokenCount)
    if (shadowed !== null) {
      out.lastShadowedTokens = shadowed
      out.shadowedTotal = (num(out.shadowedTotal) ?? 0) + shadowed
    }
  } else if (event.type === 'compaction/end') {
    const turn = num(data.turn)
    if (turn !== null) out.lastTurn = turn
    const time = num(event.time)
    if (time !== null) out.lastEndTime = time
  } else if (event.type === 'compaction/prune') {
    // 工具结果修剪也是信息丢失，但机制不同（只动工具结果，重跑一次就能拿回来），
    // 所以单独累计，不混进"压缩次数"，也不混进下面的丢失率。
    const pruned = num(data.shadowedTokenCount)
    if (pruned !== null) out.prunedTotal = (num(out.prunedTotal) ?? 0) + pruned
  }
  return out
}

/** 从一段完整事件流里算出压缩历史（一次性读日志时用）。 */
export function compactionHistory(events) {
  let info = emptyCompaction()
  let sawSummary = false
  for (const event of events ?? []) {
    info = foldCompaction(info, event)
    if (event !== null && typeof event === 'object') {
      if (event.type === 'compaction/summary' || event.type === 'compaction/end') sawSummary = true
    }
  }
  // 自检：summary/end 永远和 start 成对出现。只看到 summary/end 却没有 start，
  // 说明 DSH 换了事件名 —— 此时 count=0 是**假的**，宁可不报次数，
  // 也不能对着已经压过三次的会话说"第一次"。
  if (info.count === 0 && sawSummary) info.known = false
  else info.known = true
  return info
}

const CN_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十']

/** 中文序数：1→一，10→十，11→11（中文数字只用到十，之后用阿拉伯数字更好读）。 */
export function ordinal(n) {
  const v = num(n)
  if (v === null || v < 1) return '?'
  return v <= 10 ? CN_DIGITS[v] : String(v)
}

/**
 * "第一次" / "第2次" —— 序号措辞的**唯一出处**。
 * 通知标题与聊天区横幅都用它，避免两处各写一套说法而漂移。
 * @param {number} compactionCount 已经发生的压缩次数（0 表示这次是第一次）
 */
export function ordinalPhrase(compactionCount) {
  const n = (num(compactionCount) ?? 0) + 1
  return n === 1 ? '第一次' : `第${ordinal(n)}次`
}

/** 压缩线的**上界**（只报上界，因为真实触发点只会更早）。 */
export function compactLine(alert) {
  const window = num(alert?.window)
  const pct = num(alert?.compactPct)
  if (window === null || window <= 0 || pct === null) return null
  return { pct, tokens: Math.floor((window * pct) / 100) }
}

/**
 * 信息丢失率：本会话历史里**已经不再逐字保留**的比例。
 *
 *   丢失率 = 累计被遮蔽的 token ÷ (累计被遮蔽的 token + 当前上下文 token)
 *
 * 口径说明（重要，别把它当成精确值）：
 *
 *  1. 分母里的"当前上下文 token"**包含**那些摘要本身。摘要也是内容，
 *     所以分母偏大 → 算出来的比例偏**小**。也就是说这是个**保守**估计：
 *     真实丢失只会更多，不会更少。宁可低估也不高估。
 *  2. 被遮蔽 ≠ 完全消失。摘要是压缩过的有损表示，信息没归零，但原始细节
 *     确实拿不回来了。这个比例衡量的是"不再逐字保留的那部分"。
 *  3. 历史不可知（known=false）时返回 null —— 不编数字。
 *     确实一次都没压过时返回 0（这是确定的 0，不是"不知道"）。
 *
 * @param {number|null} shadowedTotal 累计被遮蔽的 token
 * @param {number|null} used 当前上下文 token
 * @returns {number|null} 百分比（保留一位小数），或 null
 */
export function lossRatePct(shadowedTotal, used) {
  const shadowed = num(shadowedTotal)
  if (shadowed === null) return null
  if (shadowed <= 0) return 0
  const current = num(used)
  if (current === null || current < 0) return null
  const total = shadowed + current
  if (total <= 0) return null
  return Math.min(100, Math.round((shadowed / total) * 1000) / 10)
}

/**
 * 丢失率是否**可以安全展示**。规则只放这一处，宿主算好后客户端只负责显示。
 *
 *   - 确实一次都没压过（count=0）→ 可以，那就是确定的 0%
 *   - 压过且有遮蔽数据（shadowedTotal>0）→ 可以
 *   - 压过但遮蔽数据缺失（count>0 而 shadowedTotal=0）→ **不可以**。
 *     否则会出现"最近一次遮蔽了 78,463 tokens"与"丢失率 0%"并列的鬼话。
 *
 * @returns {boolean}
 */
export function lossIsMeaningful(count, shadowedTotal) {
  const c = num(count) ?? 0
  if (c === 0) return true
  return (num(shadowedTotal) ?? 0) > 0
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
        compactionCount: 0,
        compactionKnown: false,
        shadowedTotal: 0,
        prunedTotal: 0,
        lastShadowedTokens: null,
        lastTurn: null,
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
   * 记下该会话的压缩历史。`known=false` 表示还没读到日志——
   * 此时文案不许声称"第几次"，只能给不带序数的说法。
   */
  function setCompaction(id, info) {
    if (typeof id !== 'string' || id === '') return null
    const r = rec(id)
    const src = info ?? emptyCompaction()
    r.compactionCount = num(src.count) ?? 0
    r.compactionKnown = src.known === true
    r.shadowedTotal = num(src.shadowedTotal) ?? 0
    r.prunedTotal = num(src.prunedTotal) ?? 0
    r.lastShadowedTokens = num(src.lastShadowedTokens)
    r.lastTurn = num(src.lastTurn)
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
    return {
      id,
      level,
      pct: r.pct,
      used: r.used,
      window: r.window,
      count: r.notifyCount,
      compactionCount: r.compactionCount,
      compactionKnown: r.compactionKnown,
      shadowedTotal: r.shadowedTotal,
      prunedTotal: r.prunedTotal,
      lastShadowedTokens: r.lastShadowedTokens,
      lastTurn: r.lastTurn,
      // 历史不可知、或遮蔽数据缺失时不给丢失率（不编数字、不自相矛盾）
      lossPct: r.compactionKnown && lossIsMeaningful(r.compactionCount, r.shadowedTotal)
        ? lossRatePct(r.shadowedTotal, r.used)
        : null,
      compactPct: cfg.compactPct,
      headroomTokens: cfg.headroomTokens,
    }
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

  return { config: cfg, observe, markUserDriven, setCompaction, takeAlert, snapshot, forget, reset }
}

/** 千分位，给通知文案用。 */
export function fmtTokens(n) {
  const v = num(n)
  return v === null ? '?' : Math.round(v).toLocaleString('en-US')
}

/**
 * 提醒标题：把"第几次压缩"顶到最前面，这是最需要一眼看到的信息。
 * 历史不可知时不带序数——宁可不精确，也不给一个错的次数。
 */
export function alertTitle(alert) {
  const known = alert.compactionKnown === true
  const nth = ordinalPhrase(alert.compactionCount)

  if (alert.level === 'critical') {
    return known ? `本对话的${nth}自动压缩随时会触发` : '上下文已贴到压缩线'
  }
  return known ? `即将开始本对话的${nth}自动压缩` : '上下文变重了，建议换会话'
}

/**
 * 提醒正文。只写能确证的事实：
 *  - 当前占用（投影给的，精确）
 *  - 已经压缩过几次、累计遮蔽多少 token、信息丢失率（日志实测）
 *  - 上一次压缩遮蔽了多少、发生在第几回合（日志实测）
 *  - 压缩线的**上界**（真实触发点只会更早）
 * 刻意不写"距压缩线还有 N tokens"：触发点是 min(W×ratio, W−O−headroom)，
 * 其中 O（路由输出预留）在插件侧读不到，算了就是假精确。
 */
export function alertMessage(alert) {
  const pct = num(alert.pct) ?? '?'
  const out = [`现在 ${pct}%（${fmtTokens(alert.used)} / ${fmtTokens(alert.window)} tokens）。`]

  const known = alert.compactionKnown === true
  const count = num(alert.compactionCount)
  const shadowedTotal = num(alert.shadowedTotal)

  if (known && count !== null && count > 0) {
    const parts = [`本对话已压缩 ${count} 次`]
    // 丢失率只在遮蔽数据真正可用时才说——压过却报 0% 会和下面的遮蔽量打架。
    const showLoss = num(alert.lossPct) !== null && (num(shadowedTotal) ?? 0) > 0
    if (shadowedTotal !== null && shadowedTotal > 0) {
      parts.push(`累计遮蔽 ${fmtTokens(shadowedTotal)} tokens 的原始记录`)
      const loss = num(alert.lossPct)
      if (showLoss && loss !== null) parts.push(`信息丢失率约 ${loss}%`)
    }
    out.push(`${parts.join('，')}。`)

    const last = num(alert.lastShadowedTokens)
    if (last !== null) {
      const turn = num(alert.lastTurn)
      out.push(`最近一次（${turn === null ? '上一次' : `第 ${turn} 回合`}）遮蔽了 ${fmtTokens(last)} tokens，只留下摘要。`)
    }
    // 修剪只动工具结果，跟"对话被压掉"不是一回事，所以单独一句、且只在有数据时说。
    const pruned = num(alert.prunedTotal)
    if (pruned !== null && pruned > 0) {
      out.push(`另有 ${fmtTokens(pruned)} tokens 的工具输出被修剪掉（这部分重跑一次通常能拿回来）。`)
    }
  } else if (known && count === 0) {
    out.push('本对话还没有压缩过，信息都还在。')
  } else {
    // 历史不可知：连"压过几次"都不能说，否则会和标题里不带序数的说法自相矛盾。
    out.push('压缩会把最旧的对话换成一条摘要消息，原始细节之后找不回来。')
  }

  const line = compactLine(alert)
  if (line !== null) {
    const headroom = num(alert.headroomTokens)
    out.push(`压缩线不晚于窗口 ${line.pct}%（≈${fmtTokens(line.tokens)} tokens）${headroom === null ? '' : `——实际可能更早（还要扣输出预留与 ${fmtTokens(headroom)} 余量）`}。`)
  }

  out.push(alert.level === 'critical'
    ? '现在换会话最划算。'
    : '如果接下来还要做多步的长任务，现在开新会话更划算。')
  return out.join('')
}
