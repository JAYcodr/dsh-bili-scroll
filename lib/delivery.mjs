/**
 * lib/delivery.mjs —— 朋友式日报解析、边车合并与私信安全投递（v3.0）
 * ============================================================================
 * 1. 同时兼容经典日报格式（### BV号 + **档位** · **为什么值得**）与朋友口吻格式
 *    （### [标题](链接) / ### 标题 (BV号) + <!-- bili-pick: BV... | tier=... | up=... -->）；
 * 2. 与 <stateDir>/picks/<day>.jsonl 结构化边车合并，保障配额与卡片元数据准确；
 * 3. 私信清洗（sanitizeDmText）与安全分段（splitDmMessages <=460 字，防 code 21007）；
 * 4. 私信历史与近期开场白去重（dm-history.jsonl），以及朋友风格提示词拼装。
 * ============================================================================
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dayKey } from './state.mjs'

const BV_RE = /(?<![0-9A-Za-z])(BV[0-9A-Za-z]{10})(?![0-9A-Za-z])/
const BV_GLOBAL_RE = /(?<![0-9A-Za-z])(BV[0-9A-Za-z]{10})(?![0-9A-Za-z])/g
const ANCHOR_RE = /<!--\s*bili-pick\s*:\s*(BV[0-9A-Za-z]{10})(?![0-9A-Za-z])(?:\s*\|([\s\S]*?))?-->/gi
const HEADING_RE = /^(#{1,6})[ \t]+(.+)$/
const URL_SPAN_RE = /https?:\/\/[^\s<>()*`~，。！？；：（）【】「」、]+/g

function stripFencedCodeBlocks(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
  const kept = []
  let inFence = false
  let fenceChar = ''
  let fenceLen = 0

  for (const line of lines) {
    if (!inFence) {
      const open = /^\s*(`{3,}|~{3,})(.*)$/.exec(line)
      if (open) {
        const marker = open[1]
        const rest = open[2] || ''
        // 单行内直接闭合的围栏（如 ```BV1...```）直接整行跳过，不留进状态机
        const sameLineClose = new RegExp(`${marker[0]}{${marker.length},}\\s*$`)
        if (rest.trim() && sameLineClose.test(rest)) continue
        inFence = true
        fenceChar = marker[0]
        fenceLen = marker.length
        continue
      }
      kept.push(line)
      continue
    }

    const close = new RegExp(`^\\s*${fenceChar}{${fenceLen},}\\s*$`)
    if (close.test(line)) {
      inFence = false
      fenceChar = ''
      fenceLen = 0
    }
  }

  return kept.join('\n')
}

function normalizeAnchorComments(text) {
  return text.replace(ANCHOR_RE, (full) => full.replace(/\s*\n\s*/g, ' '))
}

function parseAnchorAttrs(rawAttrs) {
  const attrs = { tier: '', up: '', title: '', why: '' }
  if (!rawAttrs) return attrs
  for (const segment of String(rawAttrs).split('|')) {
    const eqIdx = segment.indexOf('=')
    if (eqIdx <= 0) continue
    const key = segment.slice(0, eqIdx).trim().toLowerCase()
    const val = segment.slice(eqIdx + 1).trim()
    if (!val) continue
    if (key === 'tier' || key === '档位') attrs.tier = val
    else if (key === 'up' || key === 'author' || key === 'up主') attrs.up = val
    else if (key === 'title' || key === '标题') attrs.title = val
    else if (key === 'why' || key === 'reason' || key === '理由') attrs.why = val
  }
  return attrs
}

function extractTitleFromHeading(headingBody, bvid) {
  const mdLink = /\[([^\]]+)\]\([^)]*BV[0-9A-Za-z]{10}[^)]*\)/.exec(headingBody)
  if (mdLink) {
    const label = mdLink[1].trim()
    return label === bvid ? '' : label
  }
  let stripped = headingBody
    .replace(/^\d+[.)、]\s*/, '')
    .replace(new RegExp(`[（(\\[]?\\s*${bvid}\\s*[）)\\]]?`, 'g'), '')
    .replace(/https?:\/\/[^\s)]+/g, '')
    .replace(/^[\s\-—·:：|]+|[\s\-—·:：|]+$/g, '')
    .trim()
  if (stripped === bvid) stripped = ''
  return stripped
}

function cleanBodyText(raw) {
  return String(raw || '')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

function finalizeSectionMeta(section) {
  const rawBody = section.bodyLines.join('\n')

  if (!section.title) {
    const titleMatch = /^(?:[-*]\s*)?(?:\*\*)?标题(?:\*\*)?\s*[：:]\s*(.+)$/m.exec(rawBody)
    if (titleMatch) {
      const candidate = cleanBodyText(titleMatch[1])
      if (candidate && candidate !== section.bvid) section.title = candidate
    }
  }

  if (!section.up) {
    const upMatch = /^(?:[-*]\s*)?(?:\*\*)?(?:UP主?|作者|Author)(?:\*\*)?\s*[：:]\s*(.+)$/im.exec(rawBody)
    if (upMatch) section.up = cleanBodyText(upMatch[1])
  }

  if (!section.tier) {
    const tierMatch = /(?:\*\*)?档位(?:\*\*)?\s*[：:]\s*(值得看|可以看|不值当)/.exec(rawBody)
    if (tierMatch) section.tier = tierMatch[1]
  }

  if (!section.why) {
    const whyMatch = /(?:\*\*)?为什么值得(?:\*\*)?\s*[：:]\s*([\s\S]*?)(?=\n\s*(?:\*\*|#{1,3}\s)|$)/.exec(rawBody)
    if (whyMatch) {
      section.why = cleanBodyText(whyMatch[1]).slice(0, 240)
    } else {
      const proseLines = []
      for (const rawLine of section.bodyLines) {
        const trimmed = rawLine.trim()
        if (!trimmed) continue
        if (/^---+$/.test(trimmed)) continue
        if (/^(?:[-*]\s*)?(?:\*\*)?(?:标题|UP主?|作者|Author|链接|播放量|档位|为什么值得|我自己的一句话)(?:\*\*)?\s*[：:]/i.test(trimmed)) {
          continue
        }
        if (/^(?:因无字幕跳过|排除词跳过|已私信|本轮总结|小结[：:])/.test(trimmed)) continue
        proseLines.push(trimmed)
      }
      if (proseLines.length > 0) {
        section.why = cleanBodyText(proseLines.join(' ')).slice(0, 240)
      }
    }
  }

  return {
    tier: section.tier || '',
    why: section.why || '',
    title: section.title || '',
    up: section.up || '',
  }
}

/**
 * 从日报 Markdown 文本中提取挑中的 BV 号列表（去重且保序）。
 * 同时支持老格式 `### BV...`、朋友格式 `### [标题](链接)` / `### 标题 (BV...)` 与隐藏锚点注释 `<!-- bili-pick: ... -->`，
 * 并忽略代码围栏内的内容。
 *
 * @param {string} text
 * @returns {string[]}
 */
export function extractPicksFromReport(text) {
  if (typeof text !== 'string' || !text.trim()) return []
  const cleaned = normalizeAnchorComments(stripFencedCodeBlocks(text))
  const hits = []

  const headingScan = /^#{2,3}[ \t]+([^\n]+)/gm
  let headingMatch
  while ((headingMatch = headingScan.exec(cleaned)) !== null) {
    const bvMatch = BV_RE.exec(headingMatch[1])
    if (bvMatch) hits.push({ index: headingMatch.index, bvid: bvMatch[1] })
  }

  const anchorScan = new RegExp(ANCHOR_RE.source, 'gi')
  let anchorMatch
  while ((anchorMatch = anchorScan.exec(cleaned)) !== null) {
    hits.push({ index: anchorMatch.index, bvid: anchorMatch[1] })
  }

  hits.sort((a, b) => a.index - b.index)
  const seen = new Set()
  const ordered = []
  for (const hit of hits) {
    if (seen.has(hit.bvid)) continue
    seen.add(hit.bvid)
    ordered.push(hit.bvid)
  }
  return ordered
}

/**
 * 解析日报中每条挑中视频的元数据：`Map<bvid, { tier, why, title, up }>`。
 *
 * @param {string} text
 * @returns {Map<string, { tier: string, why: string, title: string, up: string }>}
 */
export function parseReportMeta(text) {
  const result = new Map()
  if (typeof text !== 'string' || !text.trim()) return result

  const cleaned = normalizeAnchorComments(stripFencedCodeBlocks(text))
  const lines = cleaned.split('\n')
  let current = null

  const flush = () => {
    if (!current) return
    const meta = finalizeSectionMeta(current)
    const prev = result.get(current.bvid)
    if (prev) {
      result.set(current.bvid, {
        tier: prev.tier || meta.tier,
        why: prev.why || meta.why,
        title: prev.title || meta.title,
        up: prev.up || meta.up,
      })
    } else {
      result.set(current.bvid, meta)
    }
    current = null
  }

  for (const line of lines) {
    const headingMatch = HEADING_RE.exec(line)
    if (headingMatch) {
      const level = headingMatch[1].length
      const body = headingMatch[2].trim()
      const bvMatch = (level === 2 || level === 3) ? BV_RE.exec(body) : null
      flush()
      if (bvMatch) {
        const bvid = bvMatch[1]
        current = {
          bvid,
          title: extractTitleFromHeading(body, bvid),
          up: '',
          tier: '',
          why: '',
          bodyLines: [],
        }
      }
      continue
    }

    const anchorScan = new RegExp(ANCHOR_RE.source, 'gi')
    const anchorMatch = anchorScan.exec(line)
    if (anchorMatch) {
      const bvid = anchorMatch[1]
      const attrs = parseAnchorAttrs(anchorMatch[2] || '')
      if (!current || current.bvid !== bvid) {
        flush()
        current = {
          bvid,
          title: attrs.title,
          up: attrs.up,
          tier: attrs.tier,
          why: attrs.why,
          bodyLines: [],
        }
      } else {
        if (!current.title && attrs.title) current.title = attrs.title
        if (!current.up && attrs.up) current.up = attrs.up
        if (!current.tier && attrs.tier) current.tier = attrs.tier
        if (!current.why && attrs.why) current.why = attrs.why
      }
      const remainder = line.replace(new RegExp(ANCHOR_RE.source, 'gi'), '').trim()
      if (remainder) current.bodyLines.push(remainder)
      continue
    }

    if (current) {
      current.bodyLines.push(line)
    }
  }

  flush()
  return result
}

/**
 * 读取 `<stateDir>/picks/<day>.jsonl` 结构化边车（文件缺失或损坏行时安全跳过）。
 *
 * @param {string} stateDir
 * @param {string} day
 * @returns {Array<{ bvid: string, title: string, up: string, tier: string, why: string, url: string }>}
 */
export function readPicksSidecar(stateDir, day) {
  if (!stateDir || !day) return []
  const file = join(String(stateDir), 'picks', `${String(day)}.jsonl`)
  let raw = ''
  try {
    if (!existsSync(file)) return []
    raw = readFileSync(file, 'utf8')
  } catch {
    return []
  }

  const byBvid = new Map()
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object') continue
    const bvid = String(parsed.bvid || parsed.bv || '').trim()
    if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) continue

    const entry = {
      ...parsed,
      bvid,
      title: String(parsed.title || '').trim(),
      up: String(parsed.up || parsed.author || '').trim(),
      tier: String(parsed.tier || '').trim(),
      why: String(parsed.why || parsed.reason || '').trim(),
      tags: Array.isArray(parsed.tags)
        ? parsed.tags.map((t) => String(t || '').trim()).filter(Boolean)
        : [],
      url: String(parsed.url || `https://www.bilibili.com/video/${bvid}`).trim(),
    }

    const prev = byBvid.get(bvid)
    if (prev) {
      byBvid.set(bvid, {
        ...prev,
        ...entry,
        title: entry.title || prev.title,
        up: entry.up || prev.up,
        tier: entry.tier || prev.tier,
        why: entry.why || prev.why,
        tags: entry.tags.length ? entry.tags : (prev.tags || []),
        url: entry.url || prev.url,
      })
    } else {
      byBvid.set(bvid, entry)
    }
  }

  return [...byBvid.values()]
}

/**
 * 合并 `<stateDir>/out/<day>.md` 与 `<stateDir>/picks/<day>.jsonl`，按 `bvid` 去重。
 * 当报告缺少结构化字段时由边车补全，保证配额计数与卡片墙元数据准确。
 *
 * @param {string} stateDir
 * @param {string} day
 * @returns {{
 *   bvids: string[],
 *   metaMap: Map<string, { tier: string, why: string, title: string, up: string }>,
 *   items: Array<{ bvid: string, title: string, up: string, tier: string, why: string, url: string }>
 * }}
 */
export function mergePicksWithReport(stateDir, day) {
  if (!stateDir || !day) return { bvids: [], metaMap: new Map(), items: [] }

  const reportFile = join(String(stateDir), 'out', `${String(day)}.md`)
  let reportText = ''
  try {
    if (existsSync(reportFile)) reportText = readFileSync(reportFile, 'utf8')
  } catch {
    reportText = ''
  }

  const reportBvids = extractPicksFromReport(reportText)
  const reportMeta = parseReportMeta(reportText)
  const sidecarItems = readPicksSidecar(stateDir, day)
  const sidecarByBvid = new Map(sidecarItems.map((item) => [item.bvid, item]))

  const orderedBvids = []
  const seen = new Set()
  for (const bv of reportBvids) {
    if (!seen.has(bv)) {
      seen.add(bv)
      orderedBvids.push(bv)
    }
  }
  for (const item of sidecarItems) {
    if (!seen.has(item.bvid)) {
      seen.add(item.bvid)
      orderedBvids.push(item.bvid)
    }
  }

  const metaMap = new Map()
  const items = []

  for (const bvid of orderedBvids) {
    const rMeta = reportMeta.get(bvid) || { tier: '', why: '', title: '', up: '' }
    const sItem = sidecarByBvid.get(bvid) || {}
    const mergedMeta = {
      tier: rMeta.tier || sItem.tier || '',
      why: rMeta.why || sItem.why || '',
      title: rMeta.title || sItem.title || '',
      up: rMeta.up || sItem.up || '',
      tags: Array.isArray(sItem.tags) ? sItem.tags : [],
    }
    metaMap.set(bvid, mergedMeta)
    items.push({
      bvid,
      ...mergedMeta,
      url: sItem.url || `https://www.bilibili.com/video/${bvid}`,
    })
  }

  return { bvids: orderedBvids, metaMap, items }
}

/**
 * 清洗 B 站私信正文：
 * - `[标题](https://...)` -> `标题 https://...`（标题与链接相同时仅保留链接）
 * - 剥离 `**加粗**`、`__加粗__`、行内代码、Markdown 标题 `# `、列表前缀 `- `
 * - 压缩 `@ 昵称` -> `@昵称`
 * - 移除机器人尾巴（如 `(28字，可继续发送)`）及 HTML 锚点注释
 *
 * @param {string} text
 * @returns {string}
 */
export function sanitizeDmText(text) {
  if (text === null || text === undefined) return ''
  let out = String(text).replace(/\0/g, '').replace(/\r\n?/g, '\n')
  if (!out.trim()) return ''

  // 移除 HTML 注释与锚点，避免泄露到私信里
  out = out.replace(/<!--[\s\S]*?-->/g, '')

  // 用占位符保护 URL，避免 URL 内部的下划线、星号或井号被 Markdown 清洗误伤
  const savedUrls = []
  const stashUrl = (url) => {
    const token = `\x00URL${savedUrls.length}\x00`
    savedUrls.push(url)
    return token
  }

  // 转换 Markdown 图片/链接：[标题](url) -> 标题 url
  out = out.replace(/!?\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label, url) => {
    const cleanLabel = String(label || '').trim()
    const cleanUrl = String(url || '').trim()
    const token = stashUrl(cleanUrl)
    if (!cleanLabel || cleanLabel === cleanUrl) return token
    return `${cleanLabel} ${token}`
  })
  out = out.replace(/<(https?:\/\/[^\s>]+)>/g, (_m, url) => stashUrl(String(url).trim()))

  out = out.replace(URL_SPAN_RE, (rawUrl) => {
    const cleanUrl = rawUrl.replace(/[_.,!?;:]+$/, '')
    const suffix = rawUrl.slice(cleanUrl.length)
    return stashUrl(cleanUrl) + suffix
  })

  // 剥离代码围栏与行内代码
  out = out.replace(/```[a-zA-Z0-9_-]*\n?/g, '').replace(/```/g, '')
  out = out.replace(/`([^`\n]+)`/g, '$1')

  // 剥离加粗、斜体、删除线
  out = out.replace(/\*\*([^*\n]+?)\*\*/g, '$1')
  out = out.replace(/__([^_\n]+?)__/g, '$1')
  out = out.replace(/(^|[^\w*])\*([^*\n]+?)\*(?=[^\w*]|$)/g, '$1$2')
  out = out.replace(/~~([^~\n]+?)~~/g, '$1')

  // 剥离行首 Markdown 标题、引用与列表符号
  out = out.replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
  out = out.replace(/^[ \t]*>[ \t]?/gm, '')
  out = out.replace(/^[ \t]*[-*+][ \t]+/gm, '')

  // 恢复 URL
  out = out.replace(/\x00URL(\d+)\x00/g, (_m, idx) => savedUrls[Number(idx)] || '')

  // 压缩 `@ 昵称` -> `@昵称`（与 mcp_server.py 保持一致）
  out = out.replace(/@[ \t]+/g, '@')

  // 清除机械字数提示和客服套话尾巴
  out = out.replace(/[（(]\s*\d+\s*字(?:\s*[，,、]\s*(?:可继续发送|可发|以内))?\s*[）)]/g, '')
  out = out.replace(
    /(?:^|[，。；,!?\s])(?:如需(?:更详细的信息|了解更多|继续|进一步了解|帮助)[^。\n]*[。！!]?|请随时告诉我[。！!]?)\s*$/gm,
    '',
  )

  // 整理空白与多余空行，保留自然段换行
  out = out
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return out
}

function findUrlSpans(str) {
  const spans = []
  const scan = new RegExp(URL_SPAN_RE.source, 'g')
  let match
  while ((match = scan.exec(str)) !== null) {
    spans.push([match.index, match.index + match[0].length])
  }
  return spans
}

function insideAnySpan(pos, spans) {
  for (const [start, end] of spans) {
    if (pos > start && pos < end) return true
  }
  return false
}

function findSplitIndex(str, limit) {
  const spans = findUrlSpans(str)
  const minPreferred = Math.max(1, Math.floor(limit * 0.25))

  const searchRange = (minIdx, predicate) => {
    for (let pos = limit; pos >= minIdx; pos--) {
      if (insideAnySpan(pos, spans)) continue
      if (predicate(pos)) return pos
    }
    return -1
  }

  for (const minIdx of [minPreferred, 1]) {
    // 1. 段落边界（\n\n）
    const paraPos = searchRange(minIdx, (pos) => pos >= 2 && str.slice(pos - 2, pos) === '\n\n')
    if (paraPos > 0) return paraPos

    // 2. 换行边界（\n）
    const linePos = searchRange(minIdx, (pos) => str[pos - 1] === '\n')
    if (linePos > 0) return linePos

    // 3. 中文句末标点或英文句末+空白
    const sentPos = searchRange(minIdx, (pos) => {
      const ch = str[pos - 1]
      if (ch === '。' || ch === '！' || ch === '？' || ch === '；') return true
      if ((ch === '.' || ch === '!' || ch === '?') && (pos === str.length || /\s/.test(str[pos]))) return true
      return false
    })
    if (sentPos > 0) return sentPos

    // 4. 分句逗号或空格
    const clausePos = searchRange(minIdx, (pos) => {
      const ch = str[pos - 1]
      return ch === '，' || ch === '、' || ch === ',' || ch === ' '
    })
    if (clausePos > 0) return clausePos
  }

  // 5. 若 limit 落在某条 URL 内部且 URL 起点大于 0，把整条 URL 挪到下一段
  for (const [start, end] of spans) {
    if (limit > start && limit < end && start > 0) {
      return start
    }
  }

  // 6. 单条不可拆超长 token 兜底硬切
  return limit
}

function appendEllipsisWithinLimit(part, limit) {
  const trimmed = part.trimEnd()
  if (trimmed.length + 1 <= limit) return `${trimmed}…`
  const budget = Math.max(0, limit - 1)
  let cut = trimmed.slice(0, budget)
  const spans = findUrlSpans(trimmed)
  for (const [start, end] of spans) {
    if (budget > start && budget < end && start > 0) {
      cut = trimmed.slice(0, start)
      break
    }
  }
  return `${cut.trimEnd()}…`
}

/**
 * 清洗并按自然边界切分私信，避免触发 B 站 500 字上限（code 21007）。
 *
 * @param {string} text
 * @param {number} [maxLen=460]
 * @param {number} [maxParts=3]
 * @returns {string[]}
 */
export function splitDmMessages(text, maxLen = 460, maxParts = 3) {
  const cleaned = sanitizeDmText(text)
  if (!cleaned) return []

  const limit = Math.max(10, Math.floor(Number(maxLen) || 460))
  const capParts = Math.max(1, Math.floor(Number(maxParts) || 3))
  if (cleaned.length <= limit) return [cleaned]

  const parts = []
  let remaining = cleaned

  while (remaining.length > limit) {
    const splitAt = findSplitIndex(remaining, limit)
    const step = Math.max(1, splitAt)
    const head = remaining.slice(0, step).trim()
    remaining = remaining.slice(step).trim()
    if (head) parts.push(head)
  }
  if (remaining) parts.push(remaining)

  if (parts.length <= capParts) return parts

  const capped = parts.slice(0, capParts)
  capped[capParts - 1] = appendEllipsisWithinLimit(capped[capParts - 1], limit)
  return capped
}

/**
 * 向 `<stateDir>/dm-history.jsonl` 追加一条私信记录。
 *
 * @param {string} stateDir
 * @param {object} entry
 * @returns {{ at: string, day: string, uid: number, direction: string, text: string, bvids: string[] } | null}
 */
export function recordDmHistory(stateDir, entry = {}) {
  if (!stateDir) return null
  const text = String(entry?.text ?? '').trim()
  const extractedBvids = Array.isArray(entry?.bvids)
    ? entry.bvids.filter((bv) => typeof bv === 'string' && /^BV[0-9A-Za-z]{10}$/.test(bv))
    : [...new Set([...text.matchAll(BV_GLOBAL_RE)].map((m) => m[1]))]

  const record = {
    at: String(entry?.at || new Date().toISOString()),
    day: String(entry?.day || dayKey()),
    uid: Number(entry?.uid) || 0,
    direction: String(entry?.direction || 'out'),
    text: text.slice(0, 1000),
    bvids: extractedBvids,
  }

  try {
    mkdirSync(String(stateDir), { recursive: true })
    appendFileSync(join(String(stateDir), 'dm-history.jsonl'), JSON.stringify(record) + '\n', 'utf8')
    return record
  } catch {
    return null
  }
}

/**
 * 安全读取最近若干条私信历史（文件不存在或损坏行时跳过）。
 *
 * @param {string} stateDir
 * @param {number} [limit=8]
 * @returns {Array<{ at: string, day: string, uid: number, direction: string, text: string, bvids: string[] }>}
 */
export function recentDmHistory(stateDir, limit = 8) {
  if (!stateDir) return []
  const cap = limit === undefined || limit === null ? 8 : Math.max(0, Math.floor(Number(limit) || 0))
  if (cap === 0) return []

  const file = join(String(stateDir), 'dm-history.jsonl')
  let raw = ''
  try {
    if (!existsSync(file)) return []
    raw = readFileSync(file, 'utf8')
  } catch {
    return []
  }

  const entries = []
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object') entries.push(parsed)
    } catch {
      // 跳过损坏行，避免一条脏数据拖垮后续历史读取
    }
  }

  return entries.slice(-cap)
}

/**
 * 提取近期发出私信的开场白（首行前 ~25 字），避免连续几天重复同一套开场词。
 *
 * @param {string} stateDir
 * @param {number} [limit=5]
 * @returns {string[]}
 */
export function recentDmOpeners(stateDir, limit = 5) {
  const cap = limit === undefined || limit === null ? 5 : Math.max(0, Math.floor(Number(limit) || 0))
  if (!stateDir || cap === 0) return []

  const history = recentDmHistory(stateDir, Math.max(cap * 4, 40))
  const seen = new Set()
  const openers = []

  for (const entry of history) {
    const dir = String(entry?.direction || 'out').toLowerCase()
    if (dir === 'in' || dir === 'incoming') continue
    const firstLine = String(entry?.text || '')
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean)
    if (!firstLine) continue
    const opener = firstLine.replace(/\s+/g, ' ').slice(0, 25).trim()
    if (!opener || seen.has(opener)) continue
    seen.add(opener)
    openers.push(opener)
  }

  return openers.slice(-cap)
}

/**
 * 生成高品味、可被宿主精确解析的日报写法指令。
 *
 * @param {object} [cfg]
 * @returns {string}
 */
export function formatFriendReportInstruction(cfg = {}) {
  const reportLevel = String(cfg?.reportLevel || 'full').trim()
  if (reportLevel === 'off') {
    return '当前设置为「不写日报」：不要往 out/ 写报告文件，但仍需调用 duty_pick_record / duty_seen_append 做好记录。'
  }

  const reportStyle = String(cfg?.reportStyle || 'friend').trim()
  const briefHint = reportLevel === 'brief' ? '每条控制在一两句以内，只留核心判断。' : '写清楚视频里真正有料的部分，别凑字数。'

  if (reportStyle === 'structured') {
    return [
      '日报格式（结构化）：每条挑中的视频以 `### BV号` 顶格开头，紧接写标题、UP、链接、`**档位**：值得看 | 可以看 | 不值当`、`**为什么值得**：...`。',
      '同时把挑中条目通过 `duty_pick_record` 写入结构化记录；末尾附上「因无字幕跳过 N 条」。',
      briefHint,
    ].join('\n')
  }

  return [
    '日报写法（朋友分享口吻）：像跟熟人安利刚看完的好视频，别套「标题：/ 播放量：/ **为什么值得**：」这种交作业表格。',
    '每条挑中的视频用 `### [视频标题](https://www.bilibili.com/video/BVxxxxxxxxx)` 开头，下一行放不可见锚点：',
    '`<!-- bili-pick: BVxxxxxxxxx | tier=值得看 | up=作者名 -->`（档位仅限 `值得看` / `可以看` / `不值当`，写 `值得看` 前必须先读过字幕或看过画面）。',
    '紧接着用一两段自然人话讲清它为什么值得点开；同步调用 `duty_pick_record` 记录元数据；文末顺带记一行「因无字幕跳过 N 条」。',
    briefHint,
  ].join('\n')
}

/**
 * 生成朋友口吻或精简清单式的私信投递指令。
 *
 * @param {object} [cfg]
 * @param {{
 *   recentOpeners?: string[],
 *   todayPicks?: Array<string|{ bvid: string, title?: string, tier?: string }>
 * }} [context]
 * @returns {string}
 */
export function formatFriendDmInstruction(cfg = {}, { recentOpeners = [], todayPicks = [] } = {}) {
  const dmStyle = String(cfg?.dmStyle || 'friend').trim()
  const splitEnabled = cfg?.dmSplitMessages !== false
  const skipEmpty = Boolean(cfg?.dmSkipEmpty)

  const lines = []
  if (dmStyle === 'digest') {
    lines.push('私信写法（精简清单）：按「标题 + 完整链接 + 一句话理由」排列，条目之间空行隔开。')
  } else {
    lines.push('私信写法（朋友聊天口吻）：直接跟账号主人聊今天刷到的东西，语气自然、别像机器人汇报工作。')
  }

  lines.push(
    '硬性格式：私信只发纯文本——禁止 `**加粗**`、`###` 标题、`[字](链接)`'
      + '（请直接写 `标题 https://www.bilibili.com/video/BV...`）、'
      + '禁止字数尾巴和 `dmMode`/`token`/`判重表`/`复核` 等内部术语，也不要在私信里 @ 任何人。',
  )

  if (splitEnabled) {
    lines.push('分段投递：单条严格 ≤460 字（防止触发 B 站 500 字 code 21007 拒收）；内容较多时可拆成 2～3 条自然短消息发送，不要把长段硬塞在一起。')
  } else {
    lines.push('单条合并：本轮只发 1 条私信，严格控制在 460 字以内，宁可精简理由或少放一条也别超时超长被拒。')
  }

  if (skipEmpty) {
    lines.push('空轮静默：若本轮没有值得推荐的新视频，直接跳过发私信，不要发「今天没挑到」之类打扰消息。')
  } else {
    lines.push('若本轮没有合适的新视频，可按需只发一句轻简人话说明即可。')
  }

  const openers = Array.isArray(recentOpeners) ? recentOpeners.filter(Boolean) : []
  if (openers.length > 0) {
    lines.push(`避开最近用过的开场白（换个自然起头）：${openers.map((o) => `「${o}」`).join('、')}。`)
  }

  const picks = Array.isArray(todayPicks) ? todayPicks : []
  if (picks.length > 0) {
    const formatted = picks
      .map((item) => {
        if (typeof item === 'string') return item
        if (item && typeof item === 'object' && item.bvid) {
          return item.title ? `${item.bvid}（${item.title}）` : item.bvid
        }
        return ''
      })
      .filter(Boolean)
    if (formatted.length > 0) {
      lines.push(`本轮已挑视频参考：${formatted.join('；')}。`)
    }
  }

  return lines.join('\n')
}
