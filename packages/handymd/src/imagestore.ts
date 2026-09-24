/**
 * 本地图片存储：没有后端时替代 data: URL 内联。
 *
 * upload 把文件存进 IndexedDB（不可用时退化为内存），返回一个相对路径
 * `assets/<name>-<hash>.<ext>` 写进 Markdown；resolve 在渲染时把这个路径
 * 换回 blob: URL。源码保持短小、可读，导出到真实目录时路径也照样成立。
 *
 *   const images = createLocalImageStore()
 *   createEditor({ mount, uploadImage: images.upload, resolveImage: images.resolve })
 */

import type { ImageResolver, ImageUploader } from './image'

export interface LocalImageStoreOptions {
  /** 写进 Markdown 的路径前缀，默认 `assets/` */
  prefix?: string
  /** IndexedDB 库名，默认 `handymd-images`；传 null 只存内存 */
  dbName?: string | null
}

export interface LocalImageStore {
  upload: ImageUploader
  resolve: ImageResolver
  /** 取回原始文件（导出 / 另存为时把图片一起写出） */
  get(path: string): Promise<Blob | null>
}

const STORE = 'files'

function openDB(name: string): Promise<IDBDatabase> | null {
  if (typeof indexedDB === 'undefined') return null
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function idb<T>(db: IDBDatabase, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = run(db.transaction(STORE, mode).objectStore(STORE))
    req.onsuccess = () => resolve(req.result as T)
    req.onerror = () => reject(req.error)
  })
}

async function contentHash(file: Blob): Promise<string> {
  try {
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
    return Array.from(new Uint8Array(digest).slice(0, 5), (b) => b.toString(16).padStart(2, '0')).join('')
  } catch {
    return Math.random().toString(16).slice(2, 12)
  }
}

const EXT_BY_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
}

function fileSlug(file: File): { base: string; ext: string } {
  const m = file.name.match(/^(.*?)(?:\.([A-Za-z0-9]+))?$/)
  const base = (m?.[1] ?? '')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  const ext = (m?.[2] ?? EXT_BY_TYPE[file.type] ?? 'png').toLowerCase()
  return { base: base || 'image', ext }
}

export function createLocalImageStore(options: LocalImageStoreOptions = {}): LocalImageStore {
  const prefix = options.prefix ?? 'assets/'
  const dbName = options.dbName === undefined ? 'handymd-images' : options.dbName
  const blobs = new Map<string, Blob>()
  const urls = new Map<string, string>()
  let dbPromise: Promise<IDBDatabase | null> | null = null

  const db = (): Promise<IDBDatabase | null> => {
    if (!dbPromise) dbPromise = (dbName ? openDB(dbName) : null)?.catch(() => null) ?? Promise.resolve(null)
    return dbPromise
  }

  const get = async (path: string): Promise<Blob | null> => {
    const hit = blobs.get(path)
    if (hit) return hit
    const d = await db()
    if (!d) return null
    const blob = await idb<Blob | undefined>(d, 'readonly', (s) => s.get(path)).catch(() => undefined)
    if (blob) blobs.set(path, blob)
    return blob ?? null
  }

  const urlFor = (path: string, blob: Blob): string => {
    let url = urls.get(path)
    if (!url) {
      url = URL.createObjectURL(blob)
      urls.set(path, url)
    }
    return url
  }

  return {
    async upload(file) {
      const { base, ext } = fileSlug(file)
      const path = `${prefix}${base}-${await contentHash(file)}.${ext}`
      blobs.set(path, file)
      const d = await db()
      if (d) await idb(d, 'readwrite', (s) => s.put(file, path)).catch(() => {})
      return path
    },
    resolve(src) {
      if (!src.startsWith(prefix)) return src
      let path = src
      try {
        path = decodeURI(src)
      } catch {
        // 非法转义：按原样查
      }
      const hit = blobs.get(path)
      if (hit) return urlFor(path, hit)
      return get(path).then((blob) => (blob ? urlFor(path, blob) : src))
    },
    get,
  }
}
