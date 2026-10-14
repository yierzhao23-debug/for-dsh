/**
 * dsh-context-alert — 宿主半边
 *
 * 职责：盯着官方 `contextPressure` 投影，在"该换会话了"的时候主动提醒用户。
 *
 * 为什么必须放在宿主而不是客户端：
 *   `useProjection('contextPressure')` 只在某个会话标签页挂载时才存在。基于标签页
 *   的插件没法可靠地提醒——用户切到别的标签页就收不到了。而宿主侧可以通过
 *   `ctx.sessionProjections.stateOf(session, 'contextPressure')` 拿到每个会话的
 *   实时压力，不依赖任何界面。
 *
 * 提醒时机：回合结束（`agent/turn-stopping`）——用户正要决定下一条消息怎么发，
 * 此刻的提醒才有可操作性。阈值磁滞、冷却、每会话上限都在 watch.js 里。
 */

import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULTS, alertMessage, alertTitle, createWatcher, occupancyOf } from './watch.js'

export const name = 'dsh-context-alert'

// sessions / sessionProjections 不在 inject 里：它们经由 ctx.inject 按需等待，
// 这样即使某个 DSH 版本没装 token-meter，插件本体也能正常加载并说明原因，
// 而不是整个 bundle 挂掉。
export const inject = ['commands', 'webServer']

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'alert.ps1')
// 默认 ~/.dsh/context-alert；DSH_CTX_ALERT_HOME 可改（也方便测试与多份配置）。
const CONFIG_DIR = process.env.DSH_CTX_ALERT_HOME
  ? process.env.DSH_CTX_ALERT_HOME
  : join(homedir(), '.dsh', 'context-alert')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')

// 演练模式：只记录不弹窗。用于自检、演示，以及自动化测试（测试环境里
// 起子进程会被沙箱拦掉）。生产默认关闭。
const DRY_RUN = process.env.DSH_CTX_ALERT_DRYRUN === '1'

// ── 配置 ─────────────────────────────────────────────────────────────────
function coerceConfig (raw) {
  const out = { ...DEFAULTS }
  if (raw === null || typeof raw !== 'object') return out
  for (const key of Object.keys(DEFAULTS)) {
    const v = raw[key]
    if (v === undefined) continue
    if (typeof DEFAULTS[key] === 'boolean') { if (typeof v === 'boolean') out[key] = v; continue }
    if (typeof DEFAULTS[key] === 'number') { const n = Number(v); if (Number.isFinite(n)) out[key] = n; continue }
    if (typeof DEFAULTS[key] === 'string') { if (typeof v === 'string') out[key] = v }
  }
  // 阈值必须有序，否则状态机没有意义；非法组合退回默认值而不是静默接受。
  if (!(out.rearmPct < out.warnPct && out.warnPct < out.criticalPct)) {
    out.rearmPct = DEFAULTS.rearmPct
    out.warnPct = DEFAULTS.warnPct
    out.criticalPct = DEFAULTS.criticalPct
  }
  if (out.cooldownMs < 0) out.cooldownMs = DEFAULTS.cooldownMs
  if (out.maxAlertsPerSession < 1) out.maxAlertsPerSession = DEFAULTS.maxAlertsPerSession
  return out
}

function loadConfig () {
  try {
    return coerceConfig(JSON.parse(readFileSync(CONFIG_FILE, 'utf8')))
  } catch {
    return { ...DEFAULTS }
  }
}

function saveConfig (patch, current) {
  const next = coerceConfig({ ...current, ...(patch ?? {}) })
  try {
    mkdirSync(CONFIG_DIR, { recursive: true })
    writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8')
  } catch (e) {
    throw new Error(`写入 ${CONFIG_FILE} 失败：${e.message}`)
  }
  return next
}

// ── 通知后端 ─────────────────────────────────────────────────────────────
function runScript (payload, timeoutMs = 120000) {
  if (DRY_RUN) {
    const stdout = payload.mode === 'probe' ? 'render-devices=-1' : 'dry-run'
    return Promise.resolve({ stdout, stderr: '', dryRun: true, payload })
  }
  return new Promise((resolve, reject) => {
    const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT], {
      windowsHide: true,
      env: { ...process.env, DSH_CTX_ALERT_PAYLOAD: b64 },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill() } catch { /* 已经退出 */ }
      reject(new Error(`alert.ps1 超时（${timeoutMs}ms）`))
    }, timeoutMs)
    child.stdout.on('data', (d) => { stdout += d.toString() })
    child.stderr.on('data', (d) => { stderr += d.toString() })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) resolve({ stdout: stdout.trim(), stderr: stderr.trim(), dryRun: false })
      else reject(new Error((stderr || stdout).trim().slice(0, 300) || `alert.ps1 退出码 ${code}`))
    })
  })
}

// ── HTTP 小工具（与 dsh-plugin-notify 同形，已验证可用）────────────────────
function sendJson (res, code, obj) {
  const data = Buffer.from(JSON.stringify(obj), 'utf8')
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': data.length })
  res.end(data)
}

async function readBody (req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}

/** Session 与 Agent 都靠 `id` 认人；拿不到就当没有，不猜。 */
function idOf (entity) {
  const id = entity?.id
  return typeof id === 'string' && id !== '' ? id : null
}

export function apply (ctx) {
  const log = (msg) => {
    const line = `[context-alert] ${msg}`
    let handled = false
    try {
      if (ctx.logger?.info) { ctx.logger.info(line); handled = true }
    } catch { /* logger 不可用 */ }
    if (!handled) console.log(line)
  }
  const warn = (msg) => {
    const line = `[context-alert] ${msg}`
    let handled = false
    try {
      if (ctx.logger?.warn) { ctx.logger.warn(line); handled = true }
    } catch { /* logger 不可用 */ }
    if (!handled) console.warn(line)
  }

  const config = loadConfig()
  const watcher = createWatcher(config)
  // 由 ctx.inject 句柄填上；collect() 用它实时盘点，不依赖根 ctx 的服务可见性。
  const services = { projections: null, sessions: null }
  let audioReported = false

  /** 送出一条提醒。通知失败绝不能让会话事件处理链崩掉。 */
  async function fire (alert, reason = 'auto') {
    const title = alertTitle(alert)
    const message = alertMessage(alert)
    const mode = alert.level === 'critical' ? watcher.config.criticalMode : watcher.config.mode
    try {
      const out = await runScript({ mode, title, message })
      if (out.stderr) warn(`通知后端有告警：${out.stderr.split('\n')[0]}`)
      if (out.dryRun) log(`[演练] 本应提醒（${reason}/${alert.level}/${alert.pct}%/${mode}）：${message}`)
      else log(`已提醒（${reason}/${alert.level}/${alert.pct}%/${mode}）：${out.stdout || 'ok'}`)
      return { ok: true, mode, message, dryRun: out.dryRun === true }
    } catch (e) {
      warn(`提醒失败：${e.message}`)
      return { ok: false, error: e.message, message }
    }
  }

  // 启动自检：音频设备为 0 时语音/提示音都出不来声，早说比晚说好。
  runScript({ mode: 'probe' }, 20000)
    .then(({ stdout }) => {
      const m = /render-devices=(-?\d+)/.exec(stdout)
      const n = m ? Number(m[1]) : -1
      audioReported = true
      if (n === 0) {
        warn('本机没有音频输出设备（waveOutGetNumDevs=0）：语音播报与提示音不会出声，提醒将以桌面气泡呈现。插上耳机/音箱后重启 DSH 即可恢复。')
      } else if (n > 0) {
        log(`音频输出设备 ${n} 个，语音播报可用。`)
      } else {
        log('未能判定音频输出设备（不影响桌面通知）。')
      }
    })
    .catch((e) => { audioReported = true; log(`音频自检跳过：${e.message}`) })

  // ── 核心：订阅投影 + 回合结束提醒 ────────────────────────────────────────
  ctx.inject(['sessionProjections', 'sessions'], (c) => {
    const projections = c.get('sessionProjections')
    const sessions = c.get('sessions')

    if (projections === undefined || typeof projections.stateOf !== 'function') {
      warn('sessionProjections.stateOf 不可用（dsh-token-meter 没装？）——上下文压力提醒已停用，其余功能正常。')
      return () => {}
    }
    services.projections = projections
    services.sessions = sessions ?? null

    const readPressure = (session) => {
      if (session === undefined || session === null) return null
      try {
        return projections.stateOf(session, 'contextPressure') ?? null
      } catch {
        return null
      }
    }

    // 会话每提交一个事件就更新一次压力。纯算术，开销可忽略。
    const offEvent = ctx.on('session/event', (session) => {
      const id = idOf(session)
      if (id === null) return
      const state = readPressure(session)
      if (state !== null) watcher.observe(id, state)
    })

    // 只有"用户自己发过消息"的会话才值得提醒；子代理与后台会话一律忽略。
    const offUser = ctx.on('agent/inbox/inserted', (payload) => {
      const id = idOf(payload?.agent)
      if (id !== null) watcher.markUserDriven(id)
    })

    // 回合结束：用户正要看结果、决定下一条消息 —— 提醒的最佳时刻。
    const offTurn = ctx.on('agent/turn-stopping', (payload) => {
      const agent = payload?.agent
      const id = idOf(agent)
      if (id === null) return
      const state = readPressure(agent.session)
      if (state !== null) watcher.observe(id, state)
      const alert = watcher.takeAlert(id)
      if (alert !== null) void fire(alert)
    })

    const offGone = ctx.on('session/disposed', (session) => {
      const id = idOf(session)
      if (id !== null) watcher.forget(id)
    })

    log(`已开始监视上下文压力（warn ${watcher.config.warnPct}% / critical ${watcher.config.criticalPct}%）。`)

    return () => {
      for (const off of [offEvent, offUser, offTurn, offGone]) {
        if (typeof off === 'function') { try { off() } catch { /* 已释放 */ } }
      }
    }
  })

  /** 实时盘点所有活着的会话（状态命令与 HTTP 面板共用）。 */
  function collect () {
    const projections = services.projections
    const rows = []
    const seen = new Set()
    let live = []
    try { live = services.sessions?.list?.() ?? [] } catch { live = [] }
    for (const session of live) {
      const id = idOf(session)
      if (id === null || seen.has(id)) continue
      seen.add(id)
      let state = null
      try { state = projections?.stateOf?.(session, 'contextPressure') ?? null } catch { state = null }
      const occ = occupancyOf(state)
      const rec = watcher.snapshot().find((r) => r.id === id)
      rows.push({
        id,
        userDriven: rec?.userDriven ?? false,
        pct: occ?.pct ?? rec?.pct ?? null,
        used: occ?.used ?? rec?.used ?? null,
        window: occ?.window ?? rec?.window ?? null,
        pending: rec?.pending ?? 'ok',
        notifyCount: rec?.notifyCount ?? 0,
      })
    }
    // 已观测到但已不在 live 列表里的（理论上很少）也带上，便于排查。
    for (const rec of watcher.snapshot()) {
      if (seen.has(rec.id)) continue
      rows.push({
        id: rec.id,
        userDriven: rec.userDriven,
        pct: rec.pct,
        used: rec.used,
        window: rec.window,
        pending: rec.pending,
        notifyCount: rec.notifyCount,
        stale: true,
      })
    }
    return rows
  }

  // ── 命令：/ctxalert ──────────────────────────────────────────────────────
  ctx.commands.register({
    name: 'ctxalert',
    description: '上下文压力提醒：查看当前占用 / 开关 / 试一次提醒 / 改阈值',
    input: { hint: '[status|on|off|test [warn|critical]|warn=<n> critical=<n>]' },
    handler: async (invocation) => {
      const raw = String(invocation?.rawInput ?? '').trim()
      const [verb, ...rest] = raw.split(/\s+/).filter(Boolean)

      if (verb === undefined || verb === 'status') {
        const rows = collect().filter((r) => r.pct !== null)
        const head = `阈值 warn ${watcher.config.warnPct}% / critical ${watcher.config.criticalPct}%，重臂 ${watcher.config.rearmPct}%，冷却 ${Math.round(watcher.config.cooldownMs / 60000)} 分钟，每会话上限 ${watcher.config.maxAlertsPerSession} 次；当前${watcher.config.enabled ? '已启用' : '已停用'}。`
        if (rows.length === 0) {
          return { kind: 'success', text: `${head}\n还没有可读的上下文压力数据（本回合尚未产生用量采样，或会话窗口未知）。` }
        }
        const lines = rows
          .sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1))
          .map((r) => {
            const tag = r.userDriven ? '' : '（非用户会话，不提醒）'
            const armed = r.pending === 'ok' ? '' : ` 待发:${r.pending}`
            const stale = r.stale ? '（已结束）' : ''
            return `  ${String(r.pct).padStart(5)}%  ${r.used}/${r.window}  ${r.id.slice(0, 8)}${stale}${tag}${armed}  已提醒${r.notifyCount}次`
          })
        return { kind: 'success', text: `${head}\n${lines.join('\n')}` }
      }

      if (verb === 'on' || verb === 'off') {
        try {
          const next = saveConfig({ enabled: verb === 'on' }, watcher.config)
          Object.assign(watcher.config, next)
          return { kind: 'success', text: `上下文压力提醒已${next.enabled ? '启用' : '停用'}。` }
        } catch (e) {
          return { kind: 'error', text: `保存失败：${e.message}` }
        }
      }

      if (verb === 'test') {
        const level = rest[0] === 'critical' ? 'critical' : 'warn'
        const rows = collect().filter((r) => r.pct !== null)
        const sample = rows[0] ?? { pct: level === 'critical' ? 88 : 70, used: 0, window: 0 }
        const fake = {
          id: 'test',
          level,
          pct: sample.pct ?? (level === 'critical' ? 88 : 70),
          used: sample.used ?? 0,
          window: sample.window ?? 0,
        }
        const res = await fire(fake, 'test')
        return res.ok
          ? { kind: 'success', text: `已发出一次${level === 'critical' ? '紧急' : '普通'}测试提醒（${res.mode}）。\n${res.message}` }
          : { kind: 'error', text: `测试提醒失败：${res.error}` }
      }

      if (verb.startsWith('warn=') || verb.startsWith('critical=') || verb.startsWith('rearm=')) {
        const patch = {}
        for (const token of [verb, ...rest]) {
          const m = /^(warn|critical|rearm|cooldown|max)=(.+)$/.exec(token)
          if (m === null) continue
          const n = Number(m[2])
          if (!Number.isFinite(n)) return { kind: 'error', text: `${m[1]} 需要一个数字，收到 "${m[2]}"。` }
          if (m[1] === 'warn') patch.warnPct = n
          else if (m[1] === 'critical') patch.criticalPct = n
          else if (m[1] === 'rearm') patch.rearmPct = n
          else if (m[1] === 'cooldown') patch.cooldownMs = n * 60000
          else if (m[1] === 'max') patch.maxAlertsPerSession = n
        }
        if (Object.keys(patch).length === 0) return { kind: 'error', text: '没解析出要改的项。' }
        let next
        try {
          next = saveConfig(patch, watcher.config)
        } catch (e) {
          return { kind: 'error', text: `保存失败：${e.message}` }
        }
        Object.assign(watcher.config, next)
        return {
          kind: 'success',
          text: `已更新：warn ${next.warnPct}% / critical ${next.criticalPct}% / 重臂 ${next.rearmPct}% / 冷却 ${Math.round(next.cooldownMs / 60000)} 分钟 / 上限 ${next.maxAlertsPerSession} 次。\n写入 ${CONFIG_FILE}`,
        }
      }

      return {
        kind: 'error',
        text: '用法：/ctxalert [status | on | off | test [warn|critical] | warn=65 critical=82 rearm=45 cooldown=10 max=3]',
      }
    },
  })

  // ── HTTP：状态 / 设置 / 测试（客户端设置面板用）──────────────────────────
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/context-alert/state',
    handler: (req, res) => {
      try {
        sendJson(res, 200, {
          ok: true,
          config: watcher.config,
          audioReported,
          sessions: collect(),
        })
      } catch (e) {
        sendJson(res, 500, { ok: false, error: e.message })
      }
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: '/api/context-alert/settings',
    handler: async (req, res) => {
      try {
        if (req.method === 'GET') {
          sendJson(res, 200, { ok: true, config: watcher.config })
          return
        }
        if (req.method === 'POST') {
          const body = await readBody(req).catch(() => ({}))
          const next = saveConfig(body, watcher.config)
          Object.assign(watcher.config, next)
          log(`设置已更新：${JSON.stringify(next)}`)
          sendJson(res, 200, { ok: true, config: next })
          return
        }
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
      } catch (e) {
        sendJson(res, 500, { ok: false, error: e.message })
      }
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: '/api/context-alert/test',
    handler: async (req, res) => {
      try {
        const body = await readBody(req).catch(() => ({}))
        const level = body.level === 'critical' ? 'critical' : 'warn'
        const fake = { id: 'test', level, pct: level === 'critical' ? 88 : 70, used: 0, window: 0 }
        const out = await fire(fake, 'test')
        sendJson(res, out.ok ? 200 : 500, { ok: out.ok, ...out })
      } catch (e) {
        sendJson(res, 500, { ok: false, error: e.message })
      }
    },
  })
}
