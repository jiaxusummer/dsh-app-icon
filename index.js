import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { parseIco, validateIco, generatePackFromImage, matchPack, sha256 } from './lib/icon.js'

/**
 * dsh-app-icon 的宿主半边。
 *
 * 它只做三件事：
 *  1. 看：读出 exe 里现在的图标、和内置的默认图标比对，告诉面板“现在用的是哪套”；
 *  2. 备：点「换」之后，把图标和参数放进暂存目录，拉起后台的 apply.ps1；
 *  3. 报：后台改完 / 失败 / 还原的经过写进 result.json，下次开面板时如实说。
 *
 * 为什么不能在这里直接改：图标嵌在正在运行的 exe 里，Windows 锁着它。
 * DSH 桌面版也没有给插件“退出整个应用”的能力，所以流程是：
 * 面板先说清楚 → 你自己从托盘退出 → 后台趁 DSH 关着改 → 自动把 DSH 打开。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ASSETS = path.join(HERE, 'assets')
const HELPER = path.join(ASSETS, 'helper', 'apply.ps1')
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const execFileAsync = promisify(execFile)
const INSPECT_TTL_MS = 30_000
const MAX_IMAGE_BYTES = 12 * 1024 * 1024
const PACK_DEFS = [
  {
    id: 'default',
    title: '默认图标',
    subtitle: 'DeepSeek Harness 原本的小鲸鱼',
    note: 'DSH 升级后也会回到这个',
    dir: path.join(ASSETS, 'default'),
  },
]

function log(...args) {
  try {
    console.log('[dsh-app-icon]', ...args)
  } catch {}
}

function json(res, status, value, headers = {}) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(body)
}

function fail(res, status, message, code) {
  json(res, status, { ok: false, error: message, code })
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error(`请求太大（超过 ${Math.round(limit / 1024 / 1024)} MB）`), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJsonBody(req, limit = 1024 * 1024) {
  const raw = await readBody(req, limit)
  if (!raw.length) return {}
  try {
    const value = JSON.parse(raw.toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
    return value
  } catch {
    throw Object.assign(new Error('请求不是有效的 JSON'), { status: 400 })
  }
}

function isLocalRequest(req) {
  const host = String(req.headers.host || '').toLowerCase()
  const name = host.replace(/:\d+$/, '')
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(name)) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  return true
}

function readState(file) {
  try {
    const value = parseJson(fs.readFileSync(file, 'utf8'))
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

// PowerShell 5.1 的 Set-Content -Encoding UTF8 会带 BOM；JSON.parse 不认它。
function parseJson(text) {
  return JSON.parse(String(text).replace(/^\uFEFF/, ''))
}

async function writeJsonAtomic(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await fsp.rename(tmp, file)
}

function tailLines(file, count = 120) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    const lines = text.split(/\r?\n/).filter(Boolean)
    return lines.slice(-count)
  } catch {
    return []
  }
}

function safeStat(file) {
  try {
    const stat = fs.statSync(file)
    return { size: stat.size, mtime: stat.mtime.toISOString() }
  } catch {
    return null
  }
}

function hashFile(file) {
  try {
    return sha256(fs.readFileSync(file))
  } catch {
    return null
  }
}

export const inject = ['webServer']

export function apply(ctx, config = {}) {
  const webServer = ctx.webServer
  if (!webServer) {
    log('没有 webServer，插件不启动')
    return
  }

  const installDir = path.dirname(process.execPath)
  const exePath = process.execPath
  const resourcesDir = path.join(installDir, 'resources')
  const dataDir = path.resolve(config.dataDir || path.join(DSH_HOME, 'dsh-app-icon'))
  const stateFile = path.join(dataDir, 'state.json')
  const logsDir = path.join(dataDir, 'logs')
  const stagingDir = path.join(dataDir, 'staging')
  const snapshotDir = path.join(dataDir, 'backups', 'icons')
  const customDir = path.join(dataDir, 'packs', 'custom')
  fs.mkdirSync(logsDir, { recursive: true })
  fs.mkdirSync(stagingDir, { recursive: true })
  fs.mkdirSync(snapshotDir, { recursive: true })

  const isWin = process.platform === 'win32'
  const looksDesktop = isWin && /deepseek harness\.exe$/i.test(path.basename(exePath)) && fs.existsSync(resourcesDir)
  const powershell = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe'

  const state = readState(stateFile)
  if (!state.last || typeof state.last !== 'object') state.last = null
  if (!state.pending || typeof state.pending !== 'object') state.pending = null

  let appVersion = null
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(resourcesDir, 'app.asar', 'package.json'), 'utf8'))
    appVersion = typeof pkg.version === 'string' ? pkg.version : null
  } catch {}

  let inspectCache = { at: 0, value: null, error: null }
  let inspectPromise = null

  // 暂存目录只留最近几份，别让几十次点击堆成山。
  function cleanupStaging() {
    try {
      const active = state.pending?.requestPath ? path.resolve(path.dirname(state.pending.requestPath)) : null
      const entries = fs
        .readdirSync(stagingDir)
        .map((name) => {
          const full = path.join(stagingDir, name)
          let mtime = 0
          try {
            mtime = fs.statSync(full).mtimeMs
          } catch {}
          return { name, full, mtime }
        })
        .sort((a, b) => b.mtime - a.mtime)
      entries.forEach((entry, index) => {
        if (active && path.resolve(entry.full) === active) return
        if (index >= 6 || Date.now() - entry.mtime > 3 * 86400_000) fs.rmSync(entry.full, { recursive: true, force: true })
      })
    } catch {}
  }

  function cleanupSnapshots() {
    try {
      const base = path.join(dataDir, 'backups', 'icons')
      const entries = fs
        .readdirSync(base)
        .map((name) => {
          const full = path.join(base, name)
          let mtime = 0
          try {
            mtime = fs.statSync(full).mtimeMs
          } catch {}
          return { name, full, mtime }
        })
        .sort((a, b) => b.mtime - a.mtime)
      entries.slice(10).forEach((entry) => fs.rmSync(entry.full, { recursive: true, force: true }))
    } catch {}
  }

  cleanupStaging()
  cleanupSnapshots()

  function appStartedAt() {
    // 父进程就是桌面端的 Electron 主进程；给后台一个 pid 守候。
    return process.ppid
  }

  function packFacts(def) {
    const ico = fs.readFileSync(path.join(def.dir, 'icon.ico'))
    const facts = validateIco(ico, { label: def.title })
    const png = path.join(def.dir, 'icon.png')
    const tray = path.join(def.dir, 'tray.ico')
    if (!fs.existsSync(png)) throw new Error(`${def.title}缺 icon.png`)
    if (!fs.existsSync(tray)) throw new Error(`${def.title}缺 tray.ico`)
    const trayFacts = validateIco(fs.readFileSync(tray), { label: `${def.title}托盘图标`, required: [16, 32] })
    return {
      ...def,
      iconIco: path.join(def.dir, 'icon.ico'),
      entries: facts.entries.map((e) => ({ width: e.width, height: e.height, bytes: e.bytes, sha: e.sha })),
      count: facts.count,
      sizes: facts.sizes,
      icoBytes: facts.bytes,
      traySizes: trayFacts.sizes,
      iconPng: png,
      trayIco: tray,
      iconSha: hashFile(png),
      traySha: hashFile(tray),
      previewFile: path.join(def.dir, 'preview.png'),
    }
  }

  function customPack() {
    const ico = path.join(customDir, 'icon.ico')
    const png = path.join(customDir, 'icon.png')
    const tray = path.join(customDir, 'tray.ico')
    if (!fs.existsSync(ico) || !fs.existsSync(png) || !fs.existsSync(tray)) return null
    try {
      const facts = validateIco(fs.readFileSync(ico), { label: '自定义图标' })
      const trayFacts = validateIco(fs.readFileSync(tray), { label: '自定义托盘图标', required: [16, 32] })
      let title = '自定义'
      let savedAt = null
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(customDir, 'meta.json'), 'utf8'))
        if (meta.title) title = String(meta.title).slice(0, 24)
        savedAt = meta.at || null
      } catch {}
      return {
        id: 'custom',
        title,
        subtitle: '你自己传的图片',
        note: '再传一次可以覆盖',
        dir: customDir,
        iconIco: ico,
        entries: facts.entries.map((e) => ({ width: e.width, height: e.height, bytes: e.bytes, sha: e.sha })),
        count: facts.count,
        sizes: facts.sizes,
        icoBytes: facts.bytes,
        traySizes: trayFacts.sizes,
        iconPng: png,
        trayIco: tray,
        iconSha: hashFile(png),
        traySha: hashFile(tray),
        previewFile: path.join(customDir, 'preview.png'),
        savedAt,
      }
    } catch (error) {
      log('自定义图标不能用了：', error.message)
      return null
    }
  }

  function historyPack() {
    const base = path.join(dataDir, 'backups', 'icons')
    let names = []
    try {
      names = fs.readdirSync(base)
    } catch {
      return null
    }
    const snaps = names
      .map((name) => {
        const dir = path.join(base, name)
        try {
          const stat = fs.statSync(dir)
          return stat.isDirectory() ? { name, dir, mtime: stat.mtimeMs } : null
        } catch {
          return null
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime)
    for (const snap of snaps) {
      const iconIco = path.join(snap.dir, 'current.ico')
      const png = path.join(snap.dir, 'icon.png')
      const tray = path.join(snap.dir, 'tray.ico')
      if (!fs.existsSync(iconIco) || !fs.existsSync(png) || !fs.existsSync(tray)) continue
      try {
        const facts = validateIco(fs.readFileSync(iconIco), { label: '历史图标' })
        const trayFacts = validateIco(fs.readFileSync(tray), { label: '上次托盘图标', required: [16, 32] })
        let at = null
        let applied = null
        try {
          const meta = parseJson(fs.readFileSync(path.join(snap.dir, 'meta.json'), 'utf8'))
          at = meta.at || null
          applied = meta.pack || null
        } catch {}
        return {
          id: 'history',
          title: '历史图标',
          subtitle: '换之前的那一套',
          note: at || snap.name,
          dir: snap.dir,
          iconIco,
          iconPng: png,
          trayIco: tray,
          entries: facts.entries.map((e) => ({ width: e.width, height: e.height, bytes: e.bytes, sha: e.sha })),
          count: facts.count,
          sizes: facts.sizes,
          icoBytes: facts.bytes,
          traySizes: trayFacts.sizes,
          iconSha: hashFile(png),
          traySha: hashFile(tray),
          previewFile: png,
          savedAt: at || new Date(snap.mtime).toISOString(),
          appliedPack: applied,
        }
      } catch (error) {
        log('上一套图标读不出来：', error.message)
      }
    }
    return null
  }

  const builtinPacks = []
  for (const def of PACK_DEFS) {
    try {
      builtinPacks.push(packFacts(def))
    } catch (error) {
      log(`内置图标 ${def.id} 有问题：`, error.message)
    }
  }

  function allPacks() {
    const list = [...builtinPacks]
    const custom = customPack()
    if (custom) list.push(custom)
    const history = historyPack()
    if (history) list.push(history)
    return list
  }

  function inspectRequestFile() {
    return path.join(stagingDir, `inspect-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.json`)
  }

  async function runInspect() {
    if (!looksDesktop) return { ok: false, error: '只支持 DSH 桌面版（现在跑的不是 DeepSeek Harness.exe）' }
    const inspectOut = path.join(dataDir, `inspect-${Date.now()}.json`)
    const request = {
      mode: 'inspect',
      exe: exePath,
      resources: resourcesDir,
      appPid: 0,
      waitSeconds: 5,
      pack: {},
      dataDir,
      logFile: path.join(logsDir, 'inspect.log'),
      resultFile: path.join(dataDir, 'inspect-result.json'),
      snapshotDir,
      inspectOut,
      currentPreview: path.join(dataDir, 'current.png'),
    }
    const requestPath = inspectRequestFile()
    await writeJsonAtomic(requestPath, request)
    try {
      await execFileAsync(
        powershell,
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', HELPER, '-Request', requestPath],
        { timeout: 30_000, windowsHide: true, cwd: dataDir },
      )
    } catch (error) {
      // inspect 失败时 helper 会把原因写进 inspectOut；只有文件也没有才抛。
      if (!fs.existsSync(inspectOut)) {
        log('inspect 进程失败：', error.message)
      }
    } finally {
      try {
        fs.rmSync(requestPath, { force: true })
      } catch {}
    }
    if (!fs.existsSync(inspectOut)) throw new Error('读取 exe 图标超时，没拿到结果')
    const value = parseJson(await fsp.readFile(inspectOut, 'utf8'))
    try {
      fs.rmSync(inspectOut, { force: true })
    } catch {}
    if (!value || value.ok !== true) throw new Error(value?.error || 'exe 里没有读出图标')
    return value
  }

  async function inspect(force = false) {
    if (!force && inspectCache.value && Date.now() - inspectCache.at < INSPECT_TTL_MS) return inspectCache.value
    if (inspectPromise) return inspectPromise
    inspectPromise = (async () => {
      try {
        const value = await runInspect()
        inspectCache = { at: Date.now(), value, error: null }
        return value
      } catch (error) {
        inspectCache = { at: Date.now(), value: null, error: error.message }
        return null
      } finally {
        inspectPromise = null
      }
    })()
    return inspectPromise
  }

  function finalizePending(result, reason) {
    if (!state.pending) return
    const pending = state.pending
    const record = {
      phase: result?.phase || 'failed',
      ok: result?.ok === true,
      message: result?.message || reason || '后台没有留下结果',
      pack: result?.pack || pending.pack,
      at: result?.at || new Date().toISOString(),
      log: result?.log || pending.logFile,
    }
    state.last = record
    state.pending = null
    try {
      state.updatedAt = new Date().toISOString()
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8')
    } catch (error) {
      log('写 state.json 失败：', error.message)
    }
    inspectCache = { at: 0, value: null, error: null }
    void inspect(true)
    log('本次结果：', record.phase, record.message)
  }

  const FINAL_PHASES = ['done', 'cancelled', 'timeout', 'failed', 'rolled-back']

  function readPendingResult() {
    if (!state.pending) return null
    try {
      const value = parseJson(fs.readFileSync(state.pending.resultFile, 'utf8'))
      return value && typeof value === 'object' ? value : null
    } catch {
      return null
    }
  }

  function pendingView() {
    if (!state.pending) return null
    const pending = state.pending
    const result = readPendingResult()
    if (result && FINAL_PHASES.includes(result.phase)) {
      finalizePending(result)
      return null
    }
    const age = Date.now() - new Date(pending.startedAt).getTime()
    if (!result && age > 25_000) {
      // wscript 跳板拉起后 25 秒还没收到第一份回执：后台多半没起来。
      finalizePending({ phase: 'failed', ok: false, message: '后台没起来（没收到第一步回执）。图标没动。', pack: pending.pack }, null)
      return null
    }
    let dead = false
    if (result && result.pid) {
      pending.helperPid = result.pid
      try {
        process.kill(result.pid, 0)
      } catch {
        dead = true
      }
    }
    if (dead && !FINAL_PHASES.includes(result.phase)) {
      finalizePending({ ...result, phase: 'failed', ok: false, message: '后台进程不在了，也没留下结果。图标没动。' }, null)
      return null
    }
    if (age > (pending.waitSeconds + 180) * 1000) {
      finalizePending({ phase: 'timeout', ok: false, message: '等太久了，DSH 一直没退出。图标没动。', pack: pending.pack }, null)
      return null
    }
    return {
      id: pending.id,
      pack: pending.pack,
      startedAt: pending.startedAt,
      waitSeconds: pending.waitSeconds,
      helperPid: pending.helperPid || null,
      phase: result?.phase || 'launching',
      message: result?.message || '正在拉起后台…',
      canCancel: !result || result.phase === 'waiting',
      cancelRequested: pending.cancelRequested === true,
      logFile: pending.logFile,
    }
  }

  function currentOf(facts, packs) {
    if (!facts) return { pack: 'unknown', label: '检测中', resources: {} }
    const actual = facts.entries.map((e) => ({ width: e.width, sha: e.sha256 }))
    for (const pack of packs) {
      if (matchPack(actual, pack.entries)) {
        const windowMatch = hashFile(path.join(resourcesDir, 'icon.png')) === pack.iconSha
        const trayMatch = hashFile(path.join(resourcesDir, 'tray.ico')) === pack.traySha
        return {
          pack: pack.id,
          label: pack.title,
          iconCount: facts.count,
          entries: facts.entries,
          resources: { window: windowMatch, tray: trayMatch },
        }
      }
    }
    return {
      pack: 'unknown',
      label: '其他图标',
      iconCount: facts.count,
      entries: facts.entries,
      resources: {
        window: hashFile(path.join(resourcesDir, 'icon.png')) !== null,
        tray: hashFile(path.join(resourcesDir, 'tray.ico')) !== null,
      },
    }
  }

  function backupInfo() {
    const file = path.join(dataDir, 'backup', 'exe-last-good.exe')
    const stat = safeStat(file)
    return stat ? { path: file, size: stat.size, mtime: stat.mtime } : null
  }

  async function buildStatus(forceInspect = false) {
    const pending = pendingView()
    const packs = allPacks()
    const history = packs.find((pack) => pack.id === 'history') || null
    const visiblePacks = packs.filter((pack) => pack.id !== 'history')
    const facts = await inspect(forceInspect)
    const current = currentOf(facts, visiblePacks)
    const packViews = visiblePacks.map((pack) => ({
      id: pack.id,
      title: pack.title,
      subtitle: pack.subtitle,
      note: pack.note,
      count: pack.count,
      sizes: pack.sizes,
      traySizes: pack.traySizes,
      preview: `/dsh-icon/preview?pack=${encodeURIComponent(pack.id)}`,
      active: current.pack === pack.id,
      savedAt: pack.savedAt || null,
    }))
    const currentPreview = safeStat(path.join(dataDir, 'current.png'))
    const fallbackPreview = packViews.find((pack) => pack.active)?.preview || packViews[0]?.preview || null
    return {
      ok: true,
      supported: looksDesktop,
      platform: process.platform,
      desktop: looksDesktop,
      app: {
        name: path.basename(exePath),
        version: appVersion,
        exePath,
        installDir,
        resourcesDir,
        size: safeStat(exePath)?.size || null,
        mtime: safeStat(exePath)?.mtime || null,
        appPid: appStartedAt(),
        dataDir,
      },
      current: {
        ...current,
        preview: currentPreview ? `/dsh-icon/current?t=${encodeURIComponent(currentPreview.mtime)}` : fallbackPreview,
        checkedAt: inspectCache.at ? new Date(inspectCache.at).toISOString() : null,
        error: inspectCache.error,
      },
      packs: packViews,
      history: history
        ? {
            exists: true,
            preview: `/dsh-icon/preview?pack=history&t=${encodeURIComponent(history.savedAt || '')}`,
            savedAt: history.savedAt || null,
            appliedPack: history.appliedPack || null,
          }
        : { exists: false },
      pending,
      last: state.last,
      backup: backupInfo(),
      helper: { script: HELPER, exists: fs.existsSync(HELPER) },
      notice: looksDesktop ? null : '这个插件只对 Windows 桌面版有效：现在跑的进程不是 DeepSeek Harness.exe，改不了它的图标。',
    }
  }

  function stagePack(pack) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dir = path.join(stagingDir, stamp)
    fs.mkdirSync(dir, { recursive: true })
    const icon = path.join(dir, 'icon.ico')
    const tray = path.join(dir, 'tray.ico')
    const png = path.join(dir, 'icon.png')
    fs.copyFileSync(pack.iconIco, icon)
    fs.copyFileSync(pack.trayIco, tray)
    fs.copyFileSync(pack.iconPng, png)
    return { dir, icon, tray, png }
  }

  function spawnHelper(requestPath, dir) {
    // 不能直接 spawn powershell：detached 的 DETACHED_PROCESS 会让 powershell 秒退，
    // 不 detached 又可能跟着控制台/作业一起被收走。用 wscript 当跳板：
    // GUI 进程、没有控制台，脚本里再以隐藏窗口拉起 powershell，DSH 退出后它还在。
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', HELPER, '-Request', requestPath]
    const commandLine = `"${powershell}" ` + args.map((part) => `"${part}"`).join(' ')
    const vbs = 'Set sh = CreateObject("WScript.Shell")\r\n' + 'sh.Run "' + commandLine.replace(/"/g, '""') + '", 0, False\r\n'
    const launcher = path.join(dir, 'launch.vbs')
    fs.writeFileSync(launcher, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(vbs, 'utf16le')]))
    const child = spawn('C:\\Windows\\System32\\wscript.exe', [launcher], { stdio: 'ignore', windowsHide: true, cwd: dataDir })
    child.unref()
    return { child, launcher }
  }

  async function applyPack(id) {
    const pending = pendingView()
    if (pending) throw Object.assign(new Error('上一次还没结束：' + pending.message), { status: 409 })
    if (!looksDesktop) throw Object.assign(new Error('只支持 Windows 桌面版'), { status: 409 })
    const pack = allPacks().find((item) => item.id === id)
    if (!pack) throw Object.assign(new Error('没有这套图标'), { status: 404 })
    validateIco(fs.readFileSync(pack.iconIco), { label: pack.title })
    validateIco(fs.readFileSync(pack.trayIco), { label: `${pack.title}托盘图标`, required: [16, 32] })

    const staged = stagePack(pack)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const id_ = randomUUID()
    const logFile = path.join(logsDir, `${stamp}-${pack.id}.log`)
    const resultFile = path.join(staged.dir, 'result.json')
    const cancelFlag = path.join(staged.dir, 'cancel.flag')
    const requestPath = path.join(staged.dir, 'request.json')
    const waitSeconds = Number.isFinite(config.waitSeconds) ? Math.max(120, Math.min(21600, config.waitSeconds)) : 3600
    const request = {
      mode: 'apply',
      exe: exePath,
      resources: resourcesDir,
      appPid: appStartedAt(),
      waitSeconds,
      pack: { name: pack.id, icon: staged.icon, tray: staged.tray, png: staged.png },
      dataDir,
      logFile,
      resultFile,
      snapshotDir,
      cancelFlag,
      fullBackup: config.fullExeBackup !== false,
      removeStale: true,
      noLaunch: false,
    }
    await writeJsonAtomic(requestPath, request)
    const launched = spawnHelper(requestPath, staged.dir)
    if (!launched.child.pid) throw Object.assign(new Error('没拉起来后台进程'), { status: 500 })
    state.pending = {
      id: id_,
      pack: pack.id,
      startedAt: new Date().toISOString(),
      helperPid: null,
      launcherPid: launched.child.pid,
      launcher: launched.launcher,
      waitSeconds,
      requestPath,
      resultFile,
      logFile,
      cancelFlag,
      appPid: request.appPid,
      cancelRequested: false,
    }
    state.last = state.last || null
    await writeJsonAtomic(stateFile, state)
    log(`已排好 ${pack.id}：等你退出 DSH（pid=${request.appPid}）`)
    return { ok: true, pending: pendingView() }
  }

  async function cancelPending() {
    const pending = pendingView()
    if (!pending) throw Object.assign(new Error('没有正在等的事'), { status: 404 })
    if (!pending.canCancel) throw Object.assign(new Error('已经在改了，这一步取消不了'), { status: 409 })
    fs.writeFileSync(state.pending.cancelFlag, '1', 'utf8')
    state.pending.cancelRequested = true
    await writeJsonAtomic(stateFile, state)
    return { ok: true, message: '已告诉后台取消；它会在半秒内停手。' }
  }

  async function clearBackup() {
    const file = path.join(dataDir, 'backup', 'exe-last-good.exe')
    if (!fs.existsSync(file)) return { ok: true, removed: false }
    fs.rmSync(file, { force: true })
    return { ok: true, removed: true }
  }

  function decodeImageDataUrl(dataUrl) {
    if (typeof dataUrl !== 'string') throw new Error('没有收到图片')
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([a-z0-9+/=\s]+)$/i.exec(dataUrl)
    if (!match) throw new Error('只收 PNG / JPEG / WebP 图片')
    const buffer = Buffer.from(match[2].replace(/\s+/g, ''), 'base64')
    if (buffer.length > MAX_IMAGE_BYTES) throw new Error(`图片太大（${(buffer.length / 1024 / 1024).toFixed(1)} MB），上限 12 MB`)
    if (buffer.length < 64) throw new Error('图片内容太小')
    return buffer
  }

  async function saveCustom(dataUrl, name) {
    const pending = pendingView()
    if (pending) throw Object.assign(new Error('上一次还没结束，等它完了再传'), { status: 409 })
    const input = decodeImageDataUrl(dataUrl)
    const generated = await generatePackFromImage(input)
    validateIco(generated.ico, { label: '生成好的图标' })
    const tmpDir = path.join(stagingDir, `custom-${Date.now()}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'icon.ico'), generated.ico)
    fs.writeFileSync(path.join(tmpDir, 'tray.ico'), generated.trayIco)
    fs.writeFileSync(path.join(tmpDir, 'icon.png'), generated.iconPng)
    fs.writeFileSync(path.join(tmpDir, 'preview.png'), generated.preview)
    fs.writeFileSync(
      path.join(tmpDir, 'meta.json'),
      JSON.stringify({ at: new Date().toISOString(), source: String(name || '').slice(0, 120), sizes: generated.sizes }, null, 2),
      'utf8',
    )
    fs.mkdirSync(customDir, { recursive: true })
    for (const file of ['icon.ico', 'tray.ico', 'icon.png', 'preview.png', 'meta.json']) {
      fs.copyFileSync(path.join(tmpDir, file), path.join(customDir, file))
    }
    fs.rmSync(tmpDir, { recursive: true, force: true })
    const pack = customPack()
    log('自定义图标已生成：', generated.sizes.join('/'))
    return {
      ok: true,
      pack: pack && { id: 'custom', title: pack.title, count: pack.count, sizes: pack.sizes, preview: '/dsh-icon/preview?pack=custom' },
      sizes: generated.sizes,
    }
  }

  async function refreshCache(restartExplorer) {
    const steps = []
    const run = async (file, args, label) => {
      try {
        await execFileAsync(file, args, { timeout: 20_000, windowsHide: true })
        steps.push(`${label}：好`)
        return true
      } catch (error) {
        steps.push(`${label}：没成（${error.code || error.message}）`)
        return false
      }
    }
    await run('ie4uinit.exe', ['-show'], '刷新图标缓存')
    if (restartExplorer) {
      const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
      const dir = path.join(local, 'Microsoft', 'Windows', 'Explorer')
      await run('taskkill.exe', ['/F', '/IM', 'explorer.exe'], '重启资源管理器')
      await new Promise((resolve) => setTimeout(resolve, 1200))
      let removed = 0
      for (const folder of [dir, local]) {
        let names = []
        try {
          names = fs.readdirSync(folder).filter((name) => /^iconcache.*\.db$/i.test(name) || name === 'IconCache.db')
        } catch {}
        for (const name of names) {
          try {
            fs.rmSync(path.join(folder, name), { force: true })
            removed += 1
          } catch {}
        }
      }
      steps.push(`清缓存文件：删掉 ${removed} 个`)
      try {
        spawn('explorer.exe', [], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 1800))
      await run('ie4uinit.exe', ['-show'], '再刷一次')
    }
    return { ok: true, steps }
  }

  async function servePreview(res, reqUrl) {
    const url = new URL(reqUrl, 'http://localhost')
    const id = url.searchParams.get('pack') || ''
    const pack = allPacks().find((item) => item.id === id)
    if (!pack || !fs.existsSync(pack.previewFile)) return fail(res, 404, '没有这张预览图')
    const data = fs.readFileSync(pack.previewFile)
    res.writeHead(200, {
      'content-type': 'image/png',
      'content-length': String(data.length),
      'cache-control': 'no-store',
    })
    res.end(data)
  }

  function serveCurrent(res) {
    const file = path.join(dataDir, 'current.png')
    if (!fs.existsSync(file)) return fail(res, 404, '还没有当前图标的预览')
    const data = fs.readFileSync(file)
    res.writeHead(200, {
      'content-type': 'image/png',
      'content-length': String(data.length),
      'cache-control': 'no-store',
    })
    res.end(data)
  }

  function logView() {
    const pending = state.pending
    const file = pending?.logFile || state.last?.log || null
    const lines = file ? tailLines(file, 160) : []
    return { ok: true, file, lines, result: state.last }
  }

  async function handle(req, res) {
    if (!isLocalRequest(req)) return fail(res, 403, '只接受本机页面')
    const url = new URL(req.url || '/', 'http://localhost')
    const sub = url.pathname.replace(/^\/dsh-icon\/?/, '')
    const method = req.method || 'GET'

    if (method === 'GET' && (sub === 'status' || sub === '')) {
      return json(res, 200, await buildStatus(url.searchParams.get('force') === '1'))
    }
    if (method === 'GET' && sub === 'preview') return servePreview(res, req.url)
    if (method === 'GET' && sub === 'current') return serveCurrent(res)
    if (method === 'GET' && sub === 'log') return json(res, 200, logView())

    if (method !== 'POST') return fail(res, 405, '只支持 GET/POST', 'method')
    if (req.headers['x-dsh-icon'] !== '1') return fail(res, 403, '缺少本插件的请求头')

    if (sub === 'apply') {
      const body = await readJsonBody(req)
      const id = String(body.pack || '')
      if (!id) return fail(res, 400, '没说换哪套')
      return json(res, 200, await applyPack(id))
    }
    if (sub === 'cancel') {
      return json(res, 200, await cancelPending())
    }
    if (sub === 'custom') {
      const body = await readJsonBody(req, MAX_IMAGE_BYTES * 1.5)
      return json(res, 200, await saveCustom(body.dataUrl, body.name))
    }
    if (sub === 'cache') {
      const body = await readJsonBody(req)
      return json(res, 200, await refreshCache(body.restartExplorer === true))
    }
    if (sub === 'backup') {
      const body = await readJsonBody(req)
      if (body.clear === true) return json(res, 200, await clearBackup())
      return fail(res, 400, '没说要做什么')
    }
    return fail(res, 404, '没有这个接口')
  }

  ctx.effect(
    () =>
      webServer.register({
        kind: 'prefix',
        path: '/dsh-icon',
        handler: async (req, res) => {
          try {
            await handle(req, res)
          } catch (error) {
            const status = Number.isInteger(error.status) ? error.status : 500
            log('接口出错：', error.stack || error.message)
            if (!res.headersSent) fail(res, status, error.message || '内部错误')
            else res.end()
          }
        },
      }),
    'dsh-app-icon routes',
  )

  // 预热一次：面板打开时不用干等 PowerShell 编译。
  if (looksDesktop) void inspect(true)
  log(`已加载，数据在 ${dataDir}`)
}
