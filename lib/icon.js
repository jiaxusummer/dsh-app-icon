/**
 * ico 读写、校验，以及「一张图 → 一整套图标」的生成。
 *
 * 这里刻意不假设必须 10 个尺寸：官方 exe 里是 7 个（16/24/32/48/64/128/256），
 * 另一套自制图标是 10 个。真正要保证的是 group 里引用的图标数、RT_ICON 数和文件里的
 * 图片字节逐个对得上——helper 打完会逐张比对，对不上就还原。
 */
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** 常见尺寸；生成时用这一套，校验时只要求覆盖小/中/大。 */
export const STANDARD_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
/** 一套图标至少要有这些尺寸，Windows 在各处才不会只拿一张硬缩。 */
export const REQUIRED_SIZES = [16, 32, 48, 256]
const MAX_ICO_BYTES = 8 * 1024 * 1024
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * 解析 .ico 容器（只读头与目录，不判断像素格式是否真能解码）。
 * @returns {{count:number, entries:Array<{width:number,height:number,bpp:number,bytes:number,offset:number,format:'png'|'dib'|'unknown',sha:string}>}}
 */
export function parseIco(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('图标文件太小，不像 .ico')
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) throw new Error('不是 .ico 文件（头不对）')
  const count = buf.readUInt16LE(4)
  if (count < 1 || count > 64) throw new Error(`图标数不对（${count}）`)
  if (6 + count * 16 > buf.length) throw new Error('图标目录被截断')
  const entries = []
  for (let i = 0; i < count; i += 1) {
    const o = 6 + i * 16
    const width = buf[o] === 0 ? 256 : buf[o]
    const height = buf[o + 1] === 0 ? 256 : buf[o + 1]
    const bpp = buf.readUInt16LE(o + 6)
    const bytes = buf.readUInt32LE(o + 8)
    const offset = buf.readUInt32LE(o + 12)
    if (bytes === 0 || offset + bytes > buf.length) throw new Error(`第 ${i + 1} 张图标的数据越界`)
    const image = buf.subarray(offset, offset + bytes)
    const format = image.subarray(0, 8).equals(PNG_MAGIC)
      ? 'png'
      : image.length >= 40 && (image.readUInt32LE(0) === 40 || image.readUInt32LE(0) === 108 || image.readUInt32LE(0) === 124)
        ? 'dib'
        : 'unknown'
    entries.push({ width, height, bpp, bytes, offset, format, sha: sha256(image) })
  }
  return { count, entries }
}

/**
 * 校验一套要写进 exe 的图标。
 * @param {Buffer} buf
 * @param {{label?:string}} [options]
 */
export function validateIco(buf, options = {}) {
  const label = options.label || '图标'
  const required = Array.isArray(options.required) ? options.required : REQUIRED_SIZES
  if (!Buffer.isBuffer(buf)) throw new Error(`${label}读不出来`)
  if (buf.length > MAX_ICO_BYTES) throw new Error(`${label}太大（${(buf.length / 1024 / 1024).toFixed(1)} MB），超过 8 MB`)
  const { count, entries } = parseIco(buf)
  const sizes = [...new Set(entries.map((e) => e.width))].sort((a, b) => a - b)
  const missing = required.filter((s) => !sizes.includes(s))
  if (missing.length) throw new Error(`${label}缺少尺寸 ${missing.join('/')}；现有 ${sizes.join('/')}`)
  for (const e of entries) {
    if (e.format === 'unknown') throw new Error(`${label}里 ${e.width}×${e.height} 那张不是 DIB/BMP，也不是 PNG，Windows 不认`)
    if (e.width !== e.height) throw new Error(`${label}里 ${e.width}×${e.height} 不是正方形`)
  }
  // 注：官方 exe 的图标从 16 到 256 全是 PNG 压缩的，Win11 的 Explorer 能正常显示；
  // 兮兮这套 exe 图标是 DIB。两种都收。插件自己生成的图一律用 DIB，兼容面最宽。
  return { count, entries, sizes, bytes: buf.length }
}

/** 一张图 → 全套图标；需要 DSH 自带的 sharp。 */
export async function generatePackFromImage(input, options = {}) {
  const sharp = await loadSharp()
  const limit = options.maxPixels || 4096
  const meta = await sharp(input, { limitInputPixels: limit * limit }).metadata()
  if (!meta.width || !meta.height) throw new Error('这张图读不出宽高')
  if (meta.width < 32 || meta.height < 32) throw new Error('图太小了，至少 32×32')
  if (meta.width > limit || meta.height > limit) throw new Error(`图太大（${meta.width}×${meta.height}），上限 ${limit}×${limit}`)
  // 先把方向摆正，再居中裁成正方形：不拉伸，边角多出来的裁掉。
  const square = await sharp(input, { limitInputPixels: limit * limit }).rotate().resize(1024, 1024, { fit: 'cover', position: 'centre' }).png().toBuffer()
  const sizes = options.sizes || STANDARD_SIZES
  const entries = []
  const images = []
  for (const size of sizes) {
    const { data } = await sharp(square).resize(size, size, { fit: 'fill', kernel: 'lanczos3' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const dib = dibFromRgba(size, data)
    images.push(dib)
  }
  const ico = buildIco(images.map((image, i) => ({ width: sizes[i], height: sizes[i], bpp: 32, image })))
  const trayIco = ico
  const iconPng = await sharp(square).resize(512, 512, { fit: 'fill' }).png({ compressionLevel: 9 }).toBuffer()
  const preview = await sharp(square).resize(160, 160, { fit: 'fill' }).png().toBuffer()
  return { ico, trayIco, iconPng, preview, sizes, source: { width: meta.width, height: meta.height, format: meta.format } }
}

/** 32bpp DIB（BITMAPINFOHEADER + 自底向上 BGRA + 全零 AND 掩码）。 */
function dibFromRgba(size, rgba) {
  if (rgba.length !== size * size * 4) throw new Error('sharp 回传的像素长度不对')
  const maskRow = Math.ceil(size / 32) * 4
  const xorBytes = size * size * 4
  const andBytes = maskRow * size
  const out = Buffer.alloc(40 + xorBytes + andBytes)
  out.writeUInt32LE(40, 0)
  out.writeInt32LE(size, 4)
  out.writeInt32LE(size * 2, 8)
  out.writeUInt16LE(1, 12)
  out.writeUInt16LE(32, 14)
  out.writeUInt32LE(0, 16)
  out.writeUInt32LE(xorBytes + andBytes, 20)
  for (let y = 0; y < size; y += 1) {
    const srcRow = (size - 1 - y) * size * 4
    const dst = 40 + y * size * 4
    for (let x = 0; x < size; x += 1) {
      const s = srcRow + x * 4
      const d = dst + x * 4
      out[d] = rgba[s + 2]
      out[d + 1] = rgba[s + 1]
      out[d + 2] = rgba[s]
      out[d + 3] = rgba[s + 3]
    }
  }
  // AND 掩码保持全 0：透明度交给 alpha 通道，Windows 自 Vista 起按 alpha 混合。
  return out
}

/** 把一组 {width,height,bpp,image} 装进 .ico 容器。 */
export function buildIco(items) {
  if (!items.length) throw new Error('没有图标可打包')
  const header = 6 + items.length * 16
  const total = items.reduce((sum, item) => sum + item.image.length, header)
  const out = Buffer.alloc(total)
  out.writeUInt16LE(0, 0)
  out.writeUInt16LE(1, 2)
  out.writeUInt16LE(items.length, 4)
  let offset = header
  items.forEach((item, i) => {
    const o = 6 + i * 16
    out[o] = item.width >= 256 ? 0 : item.width
    out[o + 1] = item.height >= 256 ? 0 : item.height
    out[o + 2] = 0
    out[o + 3] = 0
    out.writeUInt16LE(item.bpp || 32, o + 4)
    out.writeUInt16LE(item.bpp || 32, o + 6)
    out.writeUInt32LE(item.image.length, o + 8)
    out.writeUInt32LE(offset, o + 12)
    item.image.copy(out, offset)
    offset += item.image.length
  })
  return out
}

let sharpPromise
async function loadSharp() {
  if (!sharpPromise) {
    sharpPromise = (async () => {
      // sharp 是 DSH 自带的，不在 profile 里；从运行时目录解析。
      // Desktop 的 Host 命令行是：electron --expose-internals <entry> <runtimeDir> ...
      const candidates = []
      const add = (candidate) => {
        if (candidate) candidates.push(candidate)
      }
      if (process.env.DSH_INSTALL_DIR) add(path.join(process.env.DSH_INSTALL_DIR, 'package.json'))
      const runtimeDir = process.argv && process.argv[2] ? process.argv[2] : null
      if (runtimeDir) {
        add(path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
        add(path.join(runtimeDir, 'package.json'))
      }
      const entry = process.argv && process.argv[1] ? process.argv[1] : ''
      const marker = `${path.sep}node_modules${path.sep}`
      const cut = entry.indexOf(marker)
      if (cut > 0) {
        const root = entry.slice(0, cut)
        add(path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
        add(path.join(root, 'package.json'))
      }
      add(path.join(path.dirname(process.execPath), 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
      add(path.join(path.dirname(process.execPath), 'resources', 'app.asar', 'dsh', 'package.json'))
      add(import.meta.url)
      let resolved = null
      const tried = []
      for (const base of candidates) {
        try {
          resolved = createRequire(base).resolve('sharp')
          break
        } catch (error) {
          tried.push(base)
        }
      }
      if (!resolved) {
        throw new Error(`这个 DSH 里找不到 sharp，自定义图片暂时生成不了（内置两套不受影响）。找过：${tried.join(' ; ')}`)
      }
      const mod = await import(pathToFileURL(resolved).href)
      return mod.default || mod
    })()
  }
  return sharpPromise
}

/** 由一批「当前 exe 图标摘要」和一套包，判断现在用的是哪套。 */
export function matchPack(currentEntries, packEntries) {
  if (!Array.isArray(currentEntries) || !Array.isArray(packEntries)) return false
  if (currentEntries.length !== packEntries.length) return false
  const bySize = new Map(packEntries.map((e) => [e.width, e.sha256 || e.sha]))
  return currentEntries.every((e) => {
    const sha = e.sha256 || e.sha
    return bySize.get(e.width) === sha
  })
}
