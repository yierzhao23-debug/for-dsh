/**
 * 安装核验：确认插件在某个 DSH profile 里挂载完好。
 *
 *   node verify-install.mjs [profile目录]
 *
 * 默认 profile 目录为 ~/.dsh/profiles/desktop。重启 DSH 之前跑一遍，
 * 能把"插件根本没被加载"这类问题挡在前面；升级 DSH 或挪动插件之后也值得再跑。
 *
 * 只读，不改任何东西。检查项失败时退出码为 1。
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const PKG = 'dsh-context-alert'
const profileDir = resolve(process.argv[2] ?? join(homedir(), '.dsh', 'profiles', 'desktop'))

const checks = []
const ok = (name, detail = '') => checks.push({ pass: true, name, detail })
const bad = (name, detail = '') => checks.push({ pass: false, name, detail })
const skip = (name, detail = '') => checks.push({ pass: true, name, detail, skipped: true })

function readJson (path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

console.log(`核验 profile：${profileDir}\n`)

// ── 1. profile 清单 ──────────────────────────────────────────────────────
const manifestPath = join(profileDir, 'package.json')
let manifest = null
if (!existsSync(manifestPath)) {
  bad('profile package.json 存在', manifestPath)
} else {
  try {
    manifest = readJson(manifestPath)
    ok('profile package.json 是合法 JSON')
  } catch (e) {
    bad('profile package.json 是合法 JSON', e.message)
  }
}

if (manifest !== null) {
  const dep = manifest.dependencies?.[PKG]
  if (typeof dep === 'string') ok('依赖已登记', `${PKG}: ${dep}`)
  else bad('依赖已登记', `dependencies 里没有 ${PKG}`)

  const bundles = manifest.dsh?.profile?.bundles ?? []
  if (bundles.includes(PKG)) ok('bundle 已在列表中')
  else bad('bundle 已在列表中', `dsh.profile.bundles 里没有 ${PKG}`)
}

// ── 2. 按名解析（经 node_modules 里的 junction）──────────────────────────
//
// 注意：这里必须用「以 profile 目录为基准」的 require，而不是 import.meta.url。
// 本脚本自己就住在插件包内，而包内 package.json 声明了 "./package.json" 导出，
// 于是 Node 的 self-reference 会抢先命中「脚本旁边的源码副本」，
// 让整套检查悄悄跑在工作区副本上、而非真正被加载的那一份。
// 以 profile 目录为基准，才等同于 DSH 启动时的解析起点。
const profileRequire = createRequire(join(profileDir, 'package.json'))

// 先直接确认挂载点本身存在（junction / 软链 / 实目录都算）
const mountPath = join(profileDir, 'node_modules', PKG)
if (existsSync(mountPath)) ok('node_modules 下有挂载点', mountPath)
else bad('node_modules 下有挂载点', mountPath)

let pkgDir = null
try {
  pkgDir = resolve(profileRequire.resolve(`${PKG}/package.json`), '..')
  ok('从 profile 目录能按名解析到包', pkgDir)
  // 解析结果必须落在 profile 的 node_modules 之外（Node 默认解析真实路径，
  // 所以 link: 依赖会指向插件源目录），否则说明解析到的是别处的副本。
  if (resolve(pkgDir) === resolve(profileDir)) {
    bad('解析结果指向真实插件目录', '解析回了 profile 目录自身')
  }
} catch (e) {
  bad('从 profile 目录能按名解析到包', e.message)
}

let pkg = null
if (pkgDir !== null) {
  try {
    pkg = readJson(join(pkgDir, 'package.json'))
    ok('包内 package.json 可读')
  } catch (e) {
    bad('包内 package.json 可读', e.message)
  }

  // ── 3. 宿主入口 + bundle patch ─────────────────────────────────────────
  const hostEntry = join(pkgDir, pkg.main ?? './index.js')
  if (existsSync(hostEntry)) ok('宿主入口存在', hostEntry)
  else bad('宿主入口存在', hostEntry)

  const patchRel = pkg.dsh?.bundle?.patch
  if (typeof patchRel !== 'string') {
    bad('声明了 dsh.bundle.patch')
  } else {
    const patchPath = join(pkgDir, patchRel)
    if (!existsSync(patchPath)) {
      bad('bundle patch 存在', patchPath)
    } else {
      const text = readFileSync(patchPath, 'utf8')
      let parsed = null
      let yamlPath = null
      try {
        yamlPath = profileRequire.resolve('yaml')
      } catch { /* 没装 yaml 就退回文本检查 */ }

      if (yamlPath !== null) {
        const yaml = await import(pathToFileURL(yamlPath).href)
        try {
          parsed = yaml.parse(text)
          ok('bundle patch 是合法 YAML')
        } catch (e) {
          bad('bundle patch 是合法 YAML', e.message)
        }
      } else {
        skip('bundle patch 是合法 YAML', 'profile 里找不到 yaml 包，跳过')
      }

      if (parsed !== null) {
        const row = parsed?.[0]?.insert?.find?.((r) => r?.name === PKG)
        if (row !== undefined) ok('patch 里插入了正确的行', `id=${row.id} name=${row.name}`)
        else bad('patch 里插入了正确的行', JSON.stringify(parsed))
      } else {
        // 退路：只确认关键字段都在
        if (text.includes('insert:') && text.includes(PKG)) ok('patch 文本含 insert 与包名')
        else bad('patch 文本含 insert 与包名')
      }
    }
  }

  // ── 4. 客户端清单 ──────────────────────────────────────────────────────
  const client = pkg.dsh?.client
  if (client === undefined) {
    bad('声明了 dsh.client')
  } else {
    if (client.platform === 'web') ok('客户端 platform=web')
    else bad('客户端 platform=web', String(client.platform))

    const inject = client.inject ?? []
    const need = ['@deepseek-ai/dsh-client-ui-conversation', '@deepseek-ai/dsh-client-ui-settings']
    const missing = need.filter((m) => !inject.includes(m))
    if (missing.length === 0) ok('客户端 inject 覆盖所注册的 slot 宿主')
    else bad('客户端 inject 覆盖所注册的 slot 宿主', `缺 ${missing.join(', ')}`)

    // ── 5. client bundle 的模块 id 必须等于包名 ──────────────────────────
    const clientRel = typeof pkg.exports?.['./client'] === 'string'
      ? pkg.exports['./client']
      : pkg.exports?.['./client']?.default
    if (typeof clientRel !== 'string') {
      bad('声明了 ./client 导出')
    } else {
      const clientPath = join(pkgDir, clientRel)
      if (!existsSync(clientPath)) {
        bad('client bundle 存在', clientPath)
      } else {
        const src = readFileSync(clientPath, 'utf8')
        const m = /__ModuleLoader__\s*\.\s*load\(\s*\{[\s\S]{0,200}?id:\s*['"]([^'"]+)['"]/.exec(src)
        if (m === null) bad('client bundle 注册了 ModuleLoader', '找不到 load({ id: ... })')
        else if (m[1] !== pkg.name) bad('client bundle 的 id 等于包名', `注册的是 ${m[1]}，包名是 ${pkg.name}`)
        else ok('client bundle 的 id 等于包名', m[1])
      }
    }
  }

  // ── 6. 通知后端 ────────────────────────────────────────────────────────
  const ps1 = join(pkgDir, 'alert.ps1')
  if (!existsSync(ps1)) {
    bad('alert.ps1 存在', ps1)
  } else {
    const bytes = readFileSync(ps1)
    const nonAscii = bytes.reduce((n, b) => n + (b > 127 ? 1 : 0), 0)
    if (nonAscii === 0) ok('alert.ps1 是纯 ASCII（PS 5.1 无 BOM 时的前提）')
    else bad('alert.ps1 是纯 ASCII', `有 ${nonAscii} 个非 ASCII 字节，会被 ANSI 代码页解码成乱码`)
  }
}

// ── 报告 ─────────────────────────────────────────────────────────────────
console.log('')
for (const c of checks) {
  const tag = c.skipped === true ? 'SKIP' : c.pass ? ' OK ' : 'FAIL'
  console.log(`[${tag}] ${c.name}${c.detail !== '' ? '  —  ' + c.detail : ''}`)
}

const failed = checks.filter((c) => !c.pass)
const skipped = checks.filter((c) => c.skipped === true)
console.log('')
if (failed.length === 0) {
  console.log(`全部通过（${checks.length - skipped.length} 项${skipped.length > 0 ? `，跳过 ${skipped.length} 项` : ''}）。`)
  console.log('重启 DSH 后，用 /ctxalert status 与聊天区横幅确认运行时行为。')
} else {
  console.log(`${failed.length} 项失败。`)
  process.exit(1)
}
