/**
 * 诊断：直接从 DSH 会话日志里数压缩次数与累计遮蔽量。
 *
 *   node tools/scan-compactions.mjs [最多看几个会话]
 *
 * 用途有三个：
 *  1. 让你能自己核对插件说的"这是第 N 次压缩"——数字就是从这些日志数出来的；
 *  2. 让你能核对横幅/提醒里的"累计遮蔽 N tokens"与"信息丢失率"的分子；
 *  3. DSH 升级后如果改了事件名，这里会立刻显形（而不是让插件悄悄说错次数）。
 *
 * 会话日志格式：`~/.dsh/sessions/<工作区>/<会话>/session.v4.jsonl.zstd`。
 * 它是**多帧拼接**的 zstd（一帧一行 JSONL），而 Node 的 zstdDecompressSync
 * 只解第一帧 —— 所以这里按魔数手动切帧，否则只能读到一行会话头。
 *
 * 只输出事件类型与计数，不打印对话正文。
 *
 * ⚠️ 这里**算不出**丢失率的分母（当前上下文 token 只在运行时的
 * contextPressure 投影里有，静态扫描拿不到），所以只打印分子与次数；
 * 丢失率本身以横幅/`/ctxalert status` 为准。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import { compactionHistory } from '../watch.js'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 逐帧解压一个会话日志，返回全部事件对象。 */
export function readSessionEvents (path) {
  const buf = readFileSync(path)
  const offsets = []
  let at = buf.indexOf(MAGIC)
  while (at !== -1) { offsets.push(at); at = buf.indexOf(MAGIC, at + 4) }

  const events = []
  for (const off of offsets) {
    let text
    try { text = zstdDecompressSync(buf.subarray(off)).toString('utf8') } catch { continue }
    for (const line of text.split('\n')) {
      const s = line.trim()
      if (s === '' || s[0] !== '{') continue
      try { events.push(JSON.parse(s)) } catch { /* 假魔数产生的碎片 */ }
    }
  }
  return events
}

function walk (dir, out = []) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.jsonl.zstd')) out.push(p)
  }
  return out
}

const limit = Number(process.argv[2] ?? 8)
const root = join(homedir(), '.dsh', 'sessions')
const files = walk(root)
  .map((p) => ({ p, mtime: statSync(p).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime)
  .slice(0, Number.isFinite(limit) && limit > 0 ? limit : 8)

if (files.length === 0) {
  console.log(`没找到会话日志（${root}）。`)
  process.exit(0)
}

console.log(`扫描最近 ${files.length} 个会话（${root}）\n`)

let anyCompacted = 0
for (const f of files) {
  const events = readSessionEvents(f.p)
  // 用与插件**同一份**折叠逻辑，确保这里的数字和横幅里的一字不差。
  const h = compactionHistory(events)
  const starts = events.filter((e) => e.type === 'compaction/start').length
  const summaries = events.filter((e) => e.type === 'compaction/summary').length
  const ends = events.filter((e) => e.type === 'compaction/end').length
  const prunes = events.filter((e) => e.type === 'compaction/prune').length
  const id = f.p.split(/[\\/]/).slice(-2)[0].replace(/^session-/, '').slice(0, 8)

  // start 与 end 必须成对；不成对说明事件名变了。
  const paired = starts === ends
  const warn = !paired
    ? '  ⚠ start/end 不成对 —— DSH 可能改了事件名'
    : starts === 0 && summaries > 0
      ? '  ⚠ 有 summary 没有 start —— DSH 可能改了事件名'
      : ''

  const detail = h.count === 0
    ? ''
    : `  累计遮蔽 ${h.shadowedTotal.toLocaleString('en-US')}` +
      `${h.prunedTotal > 0 ? ` / 修剪 ${h.prunedTotal.toLocaleString('en-US')}` : ''}` +
      `${h.lastTurn === null ? '' : `（最近第 ${h.lastTurn} 回合遮蔽 ${h.lastShadowedTokens?.toLocaleString('en-US')}）`}`

  console.log(
    `${id}  事件 ${String(events.length).padStart(5)}  ` +
    `压缩 ${h.count} 次（start ${starts} / summary ${summaries} / end ${ends}）  ` +
    `prune ${prunes}${detail}${warn}`,
  )
  if (h.count > 0) anyCompacted++
}

console.log(`\n${anyCompacted}/${files.length} 个会话压缩过。`)
console.log('插件在提醒里说的"第 N 次"，就是上面"压缩次数 + 1"。')
console.log('"信息丢失率"的分子就是上面的"累计遮蔽"；分母是运行时的当前上下文 token，')
console.log('静态扫描拿不到，所以以横幅和 /ctxalert status 里显示的为准。')
