/**
 * lib/memory.mjs —— 长期品味画像、情景记忆与反馈演化引擎（v3.0）
 * ============================================================================
 * 职责：
 *   1. 纯 JS 零依赖文本切分与相似度（CJK 2-gram + ASCII 词元）
 *   2. 零 LLM 开销的私信反馈信号提取（正/负向情绪、主题、待跟进话题）
 *   3. 基于 $DSH_HOME/bili-duty/memory/ 的持久化记忆仓库：
 *      - taste_profile.json（临时文件 + renameSync 原子写，带 21 天半衰期指数衰减）
 *      - episodic_memory.jsonl（推荐 / 跳过 / 反馈 / 待跟进 open_thread）
 *      - feedback_events.jsonl（UI 卡片墙与私信显式反馈流水）
 *   4. 每轮幂等演化（evolveFromRound）、相关记忆召回（recallContext）与面板摘要统计
 * ============================================================================
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dayKey } from './state.mjs'

const MS_PER_DAY = 86_400_000
const DEFAULT_HALF_LIFE_DAYS = 21
const VALID_ACTIONS = new Set(['like', 'dislike', 'mute_up', 'boost_up', 'note'])

const NEGATIVE_PATTERNS = [
  /别再?推/g,
  /不要再?推/g,
  /少推点?/g,
  /少发点?/g,
  /别发这种/g,
  /太水了?/g,
  /有点水/g,
  /水视频/g,
  /不感兴趣/g,
  /不喜欢/g,
  /不好看/g,
  /不太行/g,
  /不想看/g,
  /拉黑/g,
  /屏蔽/g,
  /标题党/g,
  /营销号/g,
  /没营养/g,
  /没意思/g,
  /太尬了?/g,
  /好无聊/g,
  /踩雷/g,
  /劝退/g,
  /取关/g,
  /纯恰饭/g,
]

const POSITIVE_PATTERNS = [
  /(?<![不没别])不错/g,
  /(?<![不没别])(?:很|挺|超|蛮|真)?喜欢/g,
  /收藏了/g,
  /三连/g,
  /多推点?/g,
  /多来点/g,
  /(?<![不没别])(?:很|挺)?[对合]胃口/g,
  /有点东西/g,
  /真有东西/g,
  /这个\s*up\s*(?:可以|不错|挺好|能处)/gi,
  /想看更多/g,
  /宝藏/g,
  /爱看/g,
  /挺好的/g,
  /戳中了/g,
  /干货足/g,
]

const THREAD_REQUEST_RE = /(?:最近比较?想看|最近想看|想看更多|想看点|多关注|多盯着|帮我盯着|帮我留意|留意一下|帮我找点|多找点|关注一下|想了解)([^\n，。！？；,!?;]{1,40})/g
const NEG_TOPIC_RE = /(?:别再?推|不要再?推|少推点?|屏蔽掉?|拉黑|不想看|不感兴趣)([^\n，。！？；,!?;]{1,36})/g
const POS_TOPIC_RE = /(?:多推点?|多来点|多推些|喜欢看)([^\n，。！？；,!?;]{1,36})/g
const ABOUT_TOPIC_RE = /(?:关于|讲|聊|涉及)([^\n，。！？；,!?;]{2,22}?)(?:的视频|的内容|方面|题材)/g
const HASHTAG_RE = /#([^#\n]{2,24})#/g

const TOPIC_STOPWORDS = new Set([
  '这种', '那种', '这个', '那个', '这些', '那些', '类似', '相关',
  '视频', '内容', '东西', '更多', '一点', '一些', '一下', '什么',
])

/**
 * 提取文本的 CJK 2-gram 与小写 ASCII 词元，返回 Set<string>。
 * 确定性实现，零外部依赖。
 */
export function extractBigrams(text) {
  const raw = String(text ?? '').trim().toLowerCase()
  const tokens = new Set()
  if (!raw) return tokens

  const cjkRuns = raw.match(/[\u4e00-\u9fff\u3400-\u4dbf]+/g) || []
  for (const run of cjkRuns) {
    if (run.length < 2) continue
    for (let i = 0; i < run.length - 1; i += 1) {
      tokens.add(run.slice(i, i + 2))
    }
  }

  const asciiWords = raw.match(/[a-z0-9]+/g) || []
  for (const word of asciiWords) {
    tokens.add(word)
  }

  return tokens
}

/**
 * 基于 extractBigrams 计算两段文本的 Jaccard 相似度（0~1）。
 */
export function textSimilarity(a, b) {
  const normA = String(a ?? '').trim().toLowerCase()
  const normB = String(b ?? '').trim().toLowerCase()
  if (!normA || !normB) return 0
  if (normA === normB) return 1

  const setA = extractBigrams(normA)
  const setB = extractBigrams(normB)
  if (setA.size === 0 || setB.size === 0) return 0

  let intersection = 0
  for (const token of setA) {
    if (setB.has(token)) intersection += 1
  }
  const union = setA.size + setB.size - intersection
  return union > 0 ? intersection / union : 0
}

function cleanTopicChunk(chunk) {
  let s = String(chunk || '').trim()
  s = s.replace(/^(?:一下|一点点|一点|一些|关于|有关|这个|那个|这种|那种|这类|类似|相关|点|些|的)+\s*/, '')
  s = s.replace(/\s*(?:的)?(?:新视频|视频|内容|消息|动态|东西|方面|相关|吧|呀|啊|了|呢)+$/g, '')
  return s.trim()
}

function splitTopicsFromPhrase(phrase, targetSet) {
  const cleaned = cleanTopicChunk(phrase)
  if (!cleaned) return
  const parts = cleaned.split(
    /[、，,\/|&]|(?:\s*(?:以及|还有)\s*)|(?<=[\u4e00-\u9fffa-z0-9])\s*(?:和|跟)\s*(?=[\u4e00-\u9fffa-z0-9])/i,
  )
  for (const part of parts) {
    const token = cleanTopicChunk(part)
    if (token.length < 2 || token.length > 24) continue
    if (TOPIC_STOPWORDS.has(token)) continue
    targetSet.add(token)
  }
}

function countPatternHits(text, patterns) {
  let total = 0
  for (const re of patterns) {
    re.lastIndex = 0
    const matches = text.match(re)
    if (matches) total += matches.length
  }
  return total
}

/**
 * 轻量确定性私信反馈解析（零 LLM 开销）。
 * 返回 { sentiment: 'positive'|'negative'|'neutral', topics: string[], threadHint: string }。
 */
export function extractDmFeedbackSignals(text) {
  const raw = String(text ?? '').trim()
  if (!raw) return { sentiment: 'neutral', topics: [], threadHint: '' }

  // 先识别明确的负向词组并计数，同时把命中的负向片段掩掉，防止「不喜欢」「不感兴趣」被正向词二次命中
  const negHits = countPatternHits(raw, NEGATIVE_PATTERNS)
  let maskedForPos = raw
  for (const re of NEGATIVE_PATTERNS) {
    re.lastIndex = 0
    maskedForPos = maskedForPos.replace(re, ' ')
  }
  const posHits = countPatternHits(maskedForPos, POSITIVE_PATTERNS)

  let sentiment = 'neutral'
  if (negHits > posHits) sentiment = 'negative'
  else if (posHits > negHits) sentiment = 'positive'

  const topicSet = new Set()
  let threadHint = ''

  THREAD_REQUEST_RE.lastIndex = 0
  let m
  while ((m = THREAD_REQUEST_RE.exec(raw)) !== null) {
    if (!threadHint) threadHint = m[0].trim()
    splitTopicsFromPhrase(m[1], topicSet)
  }

  for (const re of [NEG_TOPIC_RE, POS_TOPIC_RE, ABOUT_TOPIC_RE, HASHTAG_RE]) {
    re.lastIndex = 0
    while ((m = re.exec(raw)) !== null) {
      splitTopicsFromPhrase(m[1], topicSet)
    }
  }

  return {
    sentiment,
    topics: Array.from(topicSet).slice(0, 8),
    threadHint,
  }
}

function normalizeDate(now) {
  if (now instanceof Date && !Number.isNaN(now.getTime())) return now
  if (now !== undefined && now !== null) {
    const parsed = new Date(now)
    if (!Number.isNaN(parsed.getTime())) return parsed
  }
  return new Date()
}

function decayFactor(updatedAt, nowDate, halfLifeDays, fallbackUpdatedAt = '') {
  const ref = String(updatedAt || fallbackUpdatedAt || '').trim()
  if (!ref) return 1
  const refMs = Date.parse(ref)
  if (!Number.isFinite(refMs)) return 1
  const ageDays = Math.max(0, (nowDate.getTime() - refMs) / MS_PER_DAY)
  return 0.5 ** (ageDays / halfLifeDays)
}

function emptyRawProfile() {
  return {
    version: 1,
    updatedAt: '',
    topics: {},
    ups: {},
    mutedTopics: [],
    preferredDurations: {},
    styleNotes: [],
  }
}

function normalizeTags(tags) {
  if (typeof tags === 'string') {
    return Array.from(new Set(tags.split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean)))
  }
  if (!Array.isArray(tags)) return []
  return Array.from(new Set(tags.map((t) => String(t || '').trim()).filter(Boolean)))
}

function atomicWriteJson(filePath, value, log) {
  mkdirSync(dirname(filePath), { recursive: true })
  const rand = Math.random().toString(36).slice(2, 10)
  const tmpPath = `${filePath}.tmp.${process.pid}.${rand}`
  try {
    writeFileSync(tmpPath, JSON.stringify(value, null, 2) + '\n', 'utf8')
    renameSync(tmpPath, filePath)
  } catch (err) {
    try { rmSync(tmpPath, { force: true }) } catch { /* ignore */ }
    log(`⚠️ 原子写入 ${filePath} 失败：${err?.message ?? err}`)
    throw err
  }
}

function atomicWriteLines(filePath, records, log) {
  mkdirSync(dirname(filePath), { recursive: true })
  const rand = Math.random().toString(36).slice(2, 10)
  const tmpPath = `${filePath}.tmp.${process.pid}.${rand}`
  const content = records.length ? records.map((r) => JSON.stringify(r)).join('\n') + '\n' : ''
  try {
    writeFileSync(tmpPath, content, 'utf8')
    renameSync(tmpPath, filePath)
  } catch (err) {
    try { rmSync(tmpPath, { force: true }) } catch { /* ignore */ }
    log(`⚠️ 原子重写 ${filePath} 失败：${err?.message ?? err}`)
    throw err
  }
}

function safeAppendJsonl(filePath, record, log) {
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf8')
    return true
  } catch (err) {
    log(`⚠️ 追加 ${filePath} 失败：${err?.message ?? err}`)
    return false
  }
}

function readJsonlSafe(filePath, log) {
  if (!existsSync(filePath)) return []
  try {
    const raw = readFileSync(filePath, 'utf8')
    const out = []
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed)
        if (parsed && typeof parsed === 'object') {
          if (!parsed.summary && (parsed.subject || parsed.content)) {
            parsed.summary = [parsed.subject, parsed.content].map((x) => String(x || '').trim()).filter(Boolean).join('：')
          }
          if (!parsed.ts && parsed.at) parsed.ts = String(parsed.at)
          if (!parsed.title && parsed.subject) parsed.title = String(parsed.subject)
          out.push(parsed)
        }
      } catch {
        // 跳过损坏的单行，保证其余记忆不丢
      }
    }
    return out
  } catch (err) {
    log(`⚠️ 读取 ${filePath} 失败：${err?.message ?? err}`)
    return []
  }
}

function normalizeStoredTopic(rawTopic, fallbackUpdatedAt) {
  if (typeof rawTopic === 'number' && Number.isFinite(rawTopic)) {
    return { score: rawTopic, likes: 0, dislikes: 0, picks: 0, skips: 0, muted: false, updatedAt: fallbackUpdatedAt }
  }
  const obj = rawTopic && typeof rawTopic === 'object' ? rawTopic : {}
  return {
    score: Number(obj.score ?? obj.weight) || 0,
    likes: Math.max(0, Number(obj.likes) || 0),
    dislikes: Math.max(0, Number(obj.dislikes) || 0),
    picks: Math.max(0, Number(obj.picks) || 0),
    skips: Math.max(0, Number(obj.skips) || 0),
    muted: Boolean(obj.muted),
    updatedAt: String(obj.updatedAt || fallbackUpdatedAt || ''),
  }
}

function normalizeStoredUp(rawUp, fallbackUpdatedAt) {
  const obj = rawUp && typeof rawUp === 'object' ? rawUp : {}
  return {
    affinity: Number(obj.affinity) || 0,
    muted: Boolean(obj.muted),
    likes: Math.max(0, Number(obj.likes) || 0),
    dislikes: Math.max(0, Number(obj.dislikes) || 0),
    picks: Math.max(0, Number(obj.picks) || 0),
    skips: Math.max(0, Number(obj.skips) || 0),
    notes: Array.isArray(obj.notes) ? obj.notes.map((n) => String(n || '').trim()).filter(Boolean) : [],
    updatedAt: String(obj.updatedAt || fallbackUpdatedAt || ''),
  }
}

function addUniqueCapped(list, item, maxItems) {
  const s = String(item || '').trim()
  if (!s) return list
  const next = list.filter((x) => x !== s)
  next.push(s)
  return next.length > maxItems ? next.slice(-maxItems) : next
}

/**
 * 创建绑定到 `$DSH_HOME/bili-duty/memory/` 的长期记忆仓库实例。
 */
export function createMemoryStore(stateDir, options = {}) {
  const safeLog = typeof options?.log === 'function' ? options.log : () => {}
  const rawHalfLife = Number(options?.halfLifeDays)
  const halfLifeDays = Number.isFinite(rawHalfLife) && rawHalfLife > 0 ? rawHalfLife : DEFAULT_HALF_LIFE_DAYS

  const memoryDir = join(String(stateDir || '.'), 'memory')
  const tasteFile = join(memoryDir, 'taste_profile.json')
  const episodicFile = join(memoryDir, 'episodic_memory.jsonl')
  const feedbackFile = join(memoryDir, 'feedback_events.jsonl')

  function readRawProfile() {
    const base = emptyRawProfile()
    if (!existsSync(tasteFile)) return base
    let parsed
    try {
      parsed = JSON.parse(readFileSync(tasteFile, 'utf8'))
    } catch (err) {
      safeLog(`⚠️ taste_profile.json 解析失败，已按空档案恢复：${err?.message ?? err}`)
      return base
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return base

    const profileUpdated = String(parsed.updatedAt || '')
    const topics = {}
    if (parsed.topics && typeof parsed.topics === 'object' && !Array.isArray(parsed.topics)) {
      for (const [k, v] of Object.entries(parsed.topics)) {
        const name = String(k || '').trim()
        if (name) topics[name] = normalizeStoredTopic(v, profileUpdated)
      }
    }

    const ups = {}
    if (parsed.ups && typeof parsed.ups === 'object' && !Array.isArray(parsed.ups)) {
      for (const [k, v] of Object.entries(parsed.ups)) {
        const name = String(k || '').trim()
        if (name) ups[name] = normalizeStoredUp(v, profileUpdated)
      }
    }

    const mutedTopicsSet = new Set(
      Array.isArray(parsed.mutedTopics)
        ? parsed.mutedTopics.map((t) => String(t || '').trim()).filter(Boolean)
        : [],
    )
    for (const [tName, tVal] of Object.entries(topics)) {
      if (tVal.muted) mutedTopicsSet.add(tName)
    }
    if (Array.isArray(parsed.mutedUps)) {
      for (const u of parsed.mutedUps) {
        const upName = String(u || '').trim()
        if (!upName) continue
        if (!ups[upName]) ups[upName] = normalizeStoredUp(null, profileUpdated)
        ups[upName].muted = true
      }
    }

    return {
      version: 1,
      updatedAt: profileUpdated,
      topics,
      ups,
      mutedTopics: Array.from(mutedTopicsSet),
      preferredDurations: parsed.preferredDurations && typeof parsed.preferredDurations === 'object' && !Array.isArray(parsed.preferredDurations)
        ? { ...parsed.preferredDurations }
        : {},
      styleNotes: Array.isArray(parsed.styleNotes)
        ? Array.from(new Set(parsed.styleNotes.map((n) => String(n || '').trim()).filter(Boolean)))
        : [],
    }
  }

  /**
   * 仅在内存中按 halfLifeDays 计算衰减后的有效分值，绝不篡改只读磁盘文件。
   */
  function evaluateProfile(raw, nowDate) {
    const topics = {}
    for (const [name, entry] of Object.entries(raw.topics)) {
      const factor = decayFactor(entry.updatedAt, nowDate, halfLifeDays, raw.updatedAt)
      topics[name] = {
        score: entry.score * factor,
        rawScore: entry.score,
        likes: entry.likes,
        dislikes: entry.dislikes,
        picks: entry.picks,
        skips: entry.skips,
        updatedAt: entry.updatedAt,
      }
    }

    const ups = {}
    for (const [name, entry] of Object.entries(raw.ups)) {
      const factor = decayFactor(entry.updatedAt, nowDate, halfLifeDays, raw.updatedAt)
      ups[name] = {
        affinity: entry.affinity * factor,
        rawAffinity: entry.affinity,
        muted: entry.muted,
        likes: entry.likes,
        dislikes: entry.dislikes,
        picks: entry.picks,
        skips: entry.skips,
        notes: [...entry.notes],
        updatedAt: entry.updatedAt,
      }
    }

    return {
      version: 1,
      updatedAt: raw.updatedAt,
      topics,
      ups,
      mutedTopics: [...raw.mutedTopics],
      preferredDurations: { ...raw.preferredDurations },
      styleNotes: [...raw.styleNotes],
    }
  }

  function mutateTopic(raw, topicName, delta, fieldInc, nowDate, nowIso) {
    const existing = raw.topics[topicName] || normalizeStoredTopic(null, nowIso)
    const decayed = existing.score * decayFactor(existing.updatedAt, nowDate, halfLifeDays, raw.updatedAt)
    const nextScore = decayed + delta
    raw.topics[topicName] = {
      score: nextScore,
      likes: existing.likes + (fieldInc === 'likes' ? 1 : 0),
      dislikes: existing.dislikes + (fieldInc === 'dislikes' ? 1 : 0),
      picks: existing.picks + (fieldInc === 'picks' ? 1 : 0),
      skips: existing.skips + (fieldInc === 'skips' ? 1 : 0),
      updatedAt: nowIso,
    }
    if (nextScore <= -3) {
      raw.mutedTopics = addUniqueCapped(raw.mutedTopics, topicName, 50)
    } else if (delta > 0 && nextScore > 0) {
      raw.mutedTopics = raw.mutedTopics.filter((t) => t !== topicName)
    }
  }

  function mutateUp(raw, upName, delta, fieldInc, nowDate, nowIso, opts = {}) {
    const existing = raw.ups[upName] || normalizeStoredUp(null, nowIso)
    const decayed = existing.affinity * decayFactor(existing.updatedAt, nowDate, halfLifeDays, raw.updatedAt)
    let nextAffinity = decayed + delta
    let nextMuted = existing.muted

    if (opts.forceMute) {
      nextMuted = true
      nextAffinity = Math.min(decayed, -2)
    } else if (opts.unmute) {
      nextMuted = false
      nextAffinity = Math.max(0, decayed) + delta
    }

    const nextNotes = opts.note ? addUniqueCapped(existing.notes, opts.note, 10) : existing.notes
    raw.ups[upName] = {
      affinity: nextAffinity,
      muted: nextMuted,
      likes: existing.likes + (fieldInc === 'likes' ? 1 : 0),
      dislikes: existing.dislikes + (fieldInc === 'dislikes' ? 1 : 0),
      picks: existing.picks + (fieldInc === 'picks' ? 1 : 0),
      skips: existing.skips + (fieldInc === 'skips' ? 1 : 0),
      notes: nextNotes,
      updatedAt: nowIso,
    }
  }

  function loadTaste(now = new Date()) {
    const nowDate = normalizeDate(now)
    return evaluateProfile(readRawProfile(), nowDate)
  }

  function addEpisode({
    kind = 'note',
    bvid = '',
    title = '',
    up = '',
    tags = [],
    summary = '',
    sentiment = 'neutral',
    resolved = false,
    day,
    now = new Date(),
  } = {}) {
    const nowDate = normalizeDate(now)
    const ts = nowDate.toISOString()
    const epDay = String(day || dayKey(nowDate)).trim()
    const record = {
      id: `${nowDate.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: String(kind || 'note').trim() || 'note',
      bvid: String(bvid || '').trim(),
      title: String(title || '').trim(),
      up: String(up || '').trim(),
      tags: normalizeTags(tags),
      summary: String(summary || '').trim(),
      sentiment: ['positive', 'negative', 'neutral'].includes(sentiment) ? sentiment : 'neutral',
      resolved: Boolean(resolved),
      day: epDay,
      ts,
    }
    safeAppendJsonl(episodicFile, record, safeLog)
    return record
  }

  function listRecentEpisodes(limit = 30) {
    const cap = Math.max(0, Math.floor(Number(limit) || 0))
    if (cap <= 0) return []
    const all = readJsonlSafe(episodicFile, safeLog)
    return all.slice(-cap).reverse()
  }

  function resolveThread(matchText) {
    const needle = String(matchText || '').trim()
    if (!needle) return { resolvedCount: 0, matched: [] }

    const all = readJsonlSafe(episodicFile, safeLog)
    const needleLower = needle.toLowerCase()
    const matched = []
    const nowIso = new Date().toISOString()

    for (const ep of all) {
      const isThread = ep.kind === 'open_thread' || ep.kind === 'thread'
      if (!isThread || ep.resolved) continue

      const haystack = [ep.summary, ep.title, ep.bvid, Array.isArray(ep.tags) ? ep.tags.join(' ') : '']
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      const hit = ep.id === needle
        || (ep.bvid && ep.bvid.toLowerCase() === needleLower)
        || haystack.includes(needleLower)
        || textSimilarity(ep.summary || ep.title, needle) >= 0.35

      if (hit) {
        ep.resolved = true
        ep.resolvedAt = nowIso
        matched.push({ ...ep })
      }
    }

    if (matched.length > 0) {
      atomicWriteLines(episodicFile, all, safeLog)
    }
    return { resolvedCount: matched.length, matched }
  }

  function recordFeedback({
    source = 'ui',
    action,
    bvid = '',
    title = '',
    up = '',
    tags = [],
    note = '',
    now = new Date(),
  } = {}) {
    const act = String(action || '').trim()
    if (!VALID_ACTIONS.has(act)) {
      throw new Error(`不支持的反馈动作：${act}`)
    }

    const nowDate = normalizeDate(now)
    const nowIso = nowDate.toISOString()
    const cleanDay = dayKey(nowDate)
    const cleanBvid = String(bvid || '').trim()
    const cleanTitle = String(title || '').trim()
    const cleanUp = String(up || '').trim()
    const cleanTags = normalizeTags(tags)
    const cleanNote = String(note || '').trim()

    const raw = readRawProfile()

    if (act === 'like') {
      for (const tag of cleanTags) mutateTopic(raw, tag, 1.2, 'likes', nowDate, nowIso)
      if (cleanUp) mutateUp(raw, cleanUp, 1.2, 'likes', nowDate, nowIso, { note: cleanNote })
    } else if (act === 'boost_up') {
      for (const tag of cleanTags) mutateTopic(raw, tag, 0.8, 'likes', nowDate, nowIso)
      if (cleanUp) mutateUp(raw, cleanUp, 1.5, 'likes', nowDate, nowIso, { unmute: true, note: cleanNote })
    } else if (act === 'dislike') {
      for (const tag of cleanTags) mutateTopic(raw, tag, -1.0, 'dislikes', nowDate, nowIso)
      if (cleanUp) mutateUp(raw, cleanUp, -1.0, 'dislikes', nowDate, nowIso, { note: cleanNote })
    } else if (act === 'mute_up') {
      for (const tag of cleanTags) mutateTopic(raw, tag, -0.5, 'dislikes', nowDate, nowIso)
      if (cleanUp) mutateUp(raw, cleanUp, 0, 'dislikes', nowDate, nowIso, { forceMute: true, note: cleanNote })
    } else if (act === 'note') {
      if (cleanUp && cleanNote) mutateUp(raw, cleanUp, 0, '', nowDate, nowIso, { note: cleanNote })
    }

    if (cleanNote && !cleanUp) {
      raw.styleNotes = addUniqueCapped(raw.styleNotes, cleanNote, 30)
    }

    raw.updatedAt = nowIso
    atomicWriteJson(tasteFile, raw, safeLog)

    const eventRecord = {
      ts: nowIso,
      day: cleanDay,
      source: String(source || 'ui').trim(),
      action: act,
      bvid: cleanBvid,
      title: cleanTitle,
      up: cleanUp,
      tags: cleanTags,
      note: cleanNote,
    }
    safeAppendJsonl(feedbackFile, eventRecord, safeLog)

    const sentiment = (act === 'like' || act === 'boost_up')
      ? 'positive'
      : (act === 'dislike' || act === 'mute_up')
        ? 'negative'
        : 'neutral'
    const summaryLabel = cleanTitle || cleanUp || cleanBvid || cleanNote || act
    addEpisode({
      kind: 'feedback',
      bvid: cleanBvid,
      title: cleanTitle,
      up: cleanUp,
      tags: cleanTags,
      summary: `[${act}] ${summaryLabel}${cleanNote && cleanNote !== summaryLabel ? `：${cleanNote}` : ''}`,
      sentiment,
      day: cleanDay,
      now: nowDate,
    })

    return evaluateProfile(raw, nowDate)
  }

  function evolveFromRound({ day, picks = [], skips = [], notes = [], now = new Date() } = {}) {
    const nowDate = normalizeDate(now)
    const nowIso = nowDate.toISOString()
    const roundDay = String(day || dayKey(nowDate)).trim()

    const existing = readJsonlSafe(episodicFile, safeLog)
    const seenKeys = new Set()
    for (const ep of existing) {
      if (ep.day !== roundDay) continue
      const identity = ep.bvid || (ep.title ? `title:${ep.title}` : `summary:${String(ep.summary || '').slice(0, 40)}`)
      seenKeys.add(`${ep.day}::${identity}::${ep.kind}`)
    }

    const raw = readRawProfile()
    let addedPicks = 0
    let addedSkips = 0
    let addedNotes = 0

    for (const item of Array.isArray(picks) ? picks : []) {
      const obj = typeof item === 'string' ? { bvid: item } : (item || {})
      const bvid = String(obj.bvid || '').trim()
      const title = String(obj.title || '').trim()
      const up = String(obj.up || '').trim()
      const tags = normalizeTags(obj.tags)
      const identity = bvid || (title ? `title:${title}` : '')
      if (!identity) continue
      const key = `${roundDay}::${identity}::pick`
      if (seenKeys.has(key)) continue

      seenKeys.add(key)
      addedPicks += 1
      for (const tag of tags) mutateTopic(raw, tag, 0.35, 'picks', nowDate, nowIso)
      if (up) {
        const upEntry = raw.ups[up]
        const delta = upEntry?.muted ? 0 : 0.35
        mutateUp(raw, up, delta, 'picks', nowDate, nowIso)
      }
      addEpisode({
        kind: 'pick',
        bvid,
        title,
        up,
        tags,
        summary: String(obj.reason || obj.summary || title || bvid).trim(),
        sentiment: 'positive',
        day: roundDay,
        now: nowDate,
      })
    }

    for (const item of Array.isArray(skips) ? skips : []) {
      const obj = typeof item === 'string' ? { bvid: item } : (item || {})
      const bvid = String(obj.bvid || '').trim()
      const title = String(obj.title || '').trim()
      const up = String(obj.up || '').trim()
      const tags = normalizeTags(obj.tags)
      const identity = bvid || (title ? `title:${title}` : '')
      if (!identity) continue
      const key = `${roundDay}::${identity}::skip`
      if (seenKeys.has(key)) continue

      seenKeys.add(key)
      addedSkips += 1
      for (const tag of tags) {
        const priorSkips = raw.topics[tag]?.skips || 0
        // 单次跳过不扣分，同一主题连续/多次跳过才轻度降权
        const delta = priorSkips >= 1 ? -0.15 : 0
        mutateTopic(raw, tag, delta, 'skips', nowDate, nowIso)
      }
      if (up) {
        const priorSkips = raw.ups[up]?.skips || 0
        const delta = (!raw.ups[up]?.muted && priorSkips >= 1) ? -0.15 : 0
        mutateUp(raw, up, delta, 'skips', nowDate, nowIso)
      }
      addEpisode({
        kind: 'skip',
        bvid,
        title,
        up,
        tags,
        summary: String(obj.reason || title || bvid).trim(),
        sentiment: 'neutral',
        day: roundDay,
        now: nowDate,
      })
    }

    for (const noteItem of Array.isArray(notes) ? notes : []) {
      const obj = typeof noteItem === 'string' ? { summary: noteItem } : (noteItem || {})
      const summary = String(obj.summary || obj.note || '').trim()
      const bvid = String(obj.bvid || '').trim()
      if (!summary) continue
      const identity = bvid || `summary:${summary.slice(0, 40)}`
      const key = `${roundDay}::${identity}::round_note`
      if (seenKeys.has(key)) continue

      seenKeys.add(key)
      addedNotes += 1
      addEpisode({
        kind: 'round_note',
        bvid,
        title: String(obj.title || '').trim(),
        up: String(obj.up || '').trim(),
        tags: normalizeTags(obj.tags),
        summary,
        sentiment: 'neutral',
        day: roundDay,
        now: nowDate,
      })
    }

    if (addedPicks > 0 || addedSkips > 0) {
      raw.updatedAt = nowIso
      atomicWriteJson(tasteFile, raw, safeLog)
    }

    return {
      addedPicks,
      addedSkips,
      addedNotes,
      profile: evaluateProfile(raw, nowDate),
    }
  }

  function recallContext({
    queryText = '',
    keywords = [],
    candidateUps = [],
    maxChars = 1400,
    now = new Date(),
  } = {}) {
    const nowDate = normalizeDate(now)
    const profile = loadTaste(nowDate)
    const episodes = readJsonlSafe(episodicFile, safeLog)
    const cap = Math.max(0, Math.floor(Number(maxChars) || 0))

    const queryCombined = [
      String(queryText || '').trim(),
      ...(Array.isArray(keywords) ? keywords.map((k) => String(k || '').trim()) : []),
    ].filter(Boolean).join(' ')
    const queryLower = queryCombined.toLowerCase()
    const candidateUpSet = new Set(
      (Array.isArray(candidateUps) ? candidateUps : []).map((u) => String(u || '').trim().toLowerCase()).filter(Boolean),
    )

    const mutedTopicSet = new Set(profile.mutedTopics)
    const topicsTop = Object.entries(profile.topics)
      .filter(([name, t]) => !mutedTopicSet.has(name) && t.score > 0.05)
      .map(([name, t]) => {
        const hit = queryLower && (queryLower.includes(name.toLowerCase()) || textSimilarity(queryCombined, name) >= 0.25)
        return {
          name,
          score: t.score,
          likes: t.likes,
          picks: t.picks,
          rank: t.score + (hit ? 2.0 : 0),
        }
      })
      .sort((a, b) => b.rank - a.rank)
      .slice(0, 8)
      .map(({ name, score, likes, picks }) => ({ name, score, likes, picks }))

    const upsTop = Object.entries(profile.ups)
      .filter(([, u]) => !u.muted && u.affinity > 0.05)
      .map(([name, u]) => {
        const hit = candidateUpSet.has(name.toLowerCase())
        return {
          name,
          affinity: u.affinity,
          muted: false,
          notes: u.notes,
          rank: u.affinity + (hit ? 3.0 : 0),
        }
      })
      .sort((a, b) => b.rank - a.rank)
      .slice(0, 6)
      .map(({ name, affinity, muted, notes }) => ({ name, affinity, muted, notes }))

    const upsMuted = Object.entries(profile.ups)
      .filter(([, u]) => u.muted)
      .map(([name, u]) => {
        const hit = candidateUpSet.has(name.toLowerCase())
        return {
          name,
          affinity: u.affinity,
          muted: true,
          notes: u.notes,
          rank: (hit ? 10 : 0) - u.affinity,
        }
      })
      .sort((a, b) => b.rank - a.rank)
      .slice(0, 10)
      .map(({ name, affinity, muted, notes }) => ({ name, affinity, muted, notes }))

    const openThreads = episodes
      .filter((ep) => (ep.kind === 'open_thread' || ep.kind === 'thread') && !ep.resolved)
      .slice(-20)
      .reverse()
      .map((ep) => {
        const hit = queryCombined ? textSimilarity(queryCombined, `${ep.summary} ${(ep.tags || []).join(' ')}`) : 0
        return { ep, hit }
      })
      .sort((a, b) => b.hit - a.hit)
      .slice(0, 5)
      .map(({ ep }) => ({
        id: ep.id,
        summary: ep.summary,
        tags: ep.tags || [],
        day: ep.day || '',
      }))

    const recentReactions = episodes
      .filter((ep) => ep.kind === 'feedback' && ep.summary)
      .slice(-5)
      .reverse()
      .map((ep) => ({
        summary: ep.summary,
        sentiment: ep.sentiment,
        up: ep.up || '',
        bvid: ep.bvid || '',
        day: ep.day || '',
      }))

    const lines = []
    if (upsMuted.length || profile.mutedTopics.length) {
      const parts = []
      if (upsMuted.length) parts.push(`UP：${upsMuted.map((u) => u.name).join('、')}`)
      if (profile.mutedTopics.length) parts.push(`主题：${profile.mutedTopics.slice(0, 6).join('、')}`)
      lines.push(`尽量避开（已屏蔽/明确不喜欢）：${parts.join('；')}`)
    }
    if (openThreads.length) {
      lines.push(`待跟进话题：${openThreads.map((t) => t.summary).join('；')}`)
    }
    if (topicsTop.length) {
      lines.push(`偏好主题：${topicsTop.map((t) => `${t.name}(${t.score.toFixed(1)})`).join('、')}`)
    }
    if (upsTop.length) {
      lines.push(`喜欢的 UP：${upsTop.map((u) => `${u.name}(+${u.affinity.toFixed(1)})`).join('、')}`)
    }
    if (recentReactions.length) {
      lines.push(`近期反馈：${recentReactions.slice(0, 3).map((r) => r.summary.slice(0, 50)).join('；')}`)
    }
    if (profile.styleNotes.length) {
      lines.push(`风格备注：${profile.styleNotes.slice(-3).join('；')}`)
    }

    let text = ''
    if (cap > 0 && lines.length > 0) {
      const kept = []
      for (const line of lines) {
        const candidate = kept.length ? `${kept.join('\n')}\n${line}` : line
        if (candidate.length <= cap) {
          kept.push(line)
        } else if (kept.length === 0) {
          kept.push(cap >= 2 ? `${line.slice(0, cap - 1)}…` : line.slice(0, cap))
          break
        } else {
          break
        }
      }
      text = kept.join('\n')
      if (text.length > cap) {
        text = cap >= 2 ? `${text.slice(0, cap - 1)}…` : text.slice(0, cap)
      }
    }

    return {
      text,
      topicsTop,
      upsTop,
      upsMuted,
      openThreads,
      recentReactions,
    }
  }

  function getSummaryStats(now = new Date()) {
    const nowDate = normalizeDate(now)
    const profile = loadTaste(nowDate)
    const allEpisodes = readJsonlSafe(episodicFile, safeLog)
    const feedbackEvents = readJsonlSafe(feedbackFile, safeLog)

    const topicEntries = Object.entries(profile.topics).map(([name, t]) => ({ name, ...t }))
    const topTopics = topicEntries
      .filter((t) => t.score > 0 && !profile.mutedTopics.includes(t.name))
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)

    const upEntries = Object.entries(profile.ups).map(([name, u]) => ({ name, ...u }))
    const topUps = upEntries
      .filter((u) => !u.muted && u.affinity > 0)
      .sort((a, b) => b.affinity - a.affinity)
      .slice(0, 8)

    const mutedUps = upEntries
      .filter((u) => u.muted)
      .sort((a, b) => a.affinity - b.affinity)

    const openThreads = allEpisodes
      .filter((ep) => (ep.kind === 'open_thread' || ep.kind === 'thread') && !ep.resolved)
      .reverse()

    const recentEpisodes = allEpisodes.slice(-10).reverse()

    return {
      updatedAt: profile.updatedAt,
      counts: {
        topics: topicEntries.length,
        ups: upEntries.length,
        mutedUps: mutedUps.length,
        mutedTopics: profile.mutedTopics.length,
        openThreads: openThreads.length,
        episodes: allEpisodes.length,
        feedbackEvents: feedbackEvents.length,
      },
      topTopics,
      topUps,
      mutedUps,
      mutedTopics: profile.mutedTopics,
      openThreads,
      recentEpisodes,
    }
  }

  return {
    memoryDir,
    loadTaste,
    recordFeedback,
    evolveFromRound,
    addEpisode,
    resolveThread,
    listRecentEpisodes,
    recallContext,
    getSummaryStats,
  }
}
