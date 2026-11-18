/**
 * lib/rhythm.mjs —— 浏览与互动节律引擎（v3.0）
 * ============================================================================
 * 负责把原本"整点准时开刷、固定关键词全扫、逢视频必评"的机械行为，拆成接近真人习惯的节律：
 *   1. 窗口内随机抖动唤醒（planWindowWakeup）：支持跨零点夜间窗口锚定与窗口尾段 20 分钟保底；
 *   2. 混合发现与分轮配额（buildBrowsePlan）：推荐流 / 动态流 / 轮换关键词 / 高好感 UP 回访 / 相关顺藤摸瓜；
 *   3. 克制互动概率闸门（shouldCommentRoll）：按概率与热评风险决定是否发言，避免 AI 扎堆。
 * ============================================================================
 */
import { dayKey } from './state.mjs'

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000
const MINUTES_PER_DAY = 24 * 60
const MIN_WINDOW_REMAINING_MIN = 20

const pad2 = (value) => String(value).padStart(2, '0')

function safeDateOf(now) {
  if (now instanceof Date && !Number.isNaN(now.getTime())) return now
  const parsed = new Date(now ?? Date.now())
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed
}

function clampUnit(value) {
  const num = Number(value)
  if (!Number.isFinite(num)) return 0
  return Math.max(0, Math.min(1, num))
}

function minutesOf(hhmm) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim())
  if (!match) return null
  const hours = Number(match[1])
  const mins = Number(match[2])
  if (hours < 0 || hours > 23 || mins < 0 || mins > 59) return null
  return hours * 60 + mins
}

function shiftBjtDay(dayKeyBjt, deltaDays) {
  const [year, month, day] = String(dayKeyBjt).split('-').map(Number)
  const shifted = new Date(Date.UTC(year, month - 1, day + deltaDays))
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`
}

function extractPlannedMin(entry) {
  if (typeof entry === 'number' && Number.isFinite(entry)) return entry
  if (entry && typeof entry === 'object' && typeof entry.targetMin === 'number' && Number.isFinite(entry.targetMin)) {
    return entry.targetMin
  }
  return null
}

function pruneWindowSchedule(existingSchedule, currentDayBjt) {
  const cutoffDay = shiftBjtDay(currentDayBjt, -2)
  const kept = {}
  if (!existingSchedule || typeof existingSchedule !== 'object') return kept
  for (const [key, val] of Object.entries(existingSchedule)) {
    const dayPrefix = key.slice(0, 10)
    if (/^\d{4}-\d{2}-\d{2}$/.test(dayPrefix) && dayPrefix < cutoffDay) continue
    kept[key] = val
  }
  return kept
}

/**
 * 换算北京时间（固定 UTC+8，不依赖宿主 Intl 时区库，避免跨时区部署或精简运行时错位）。
 *
 * @param {Date|number|string} [now]
 * @returns {{ minutes: number, weekday: number, isWeekend: boolean, dayKeyBjt: string }}
 */
export function beijingTimeInfo(now = new Date()) {
  const dateObj = safeDateOf(now)
  const shifted = new Date(dateObj.getTime() + BEIJING_OFFSET_MS)
  const minutes = shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
  const weekday = shifted.getUTCDay()
  const isWeekend = weekday === 0 || weekday === 6
  const dayKeyBjt =
    `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`
  return { minutes, weekday, isWeekend, dayKeyBjt }
}

/**
 * 计算当前谷时窗口的抖动唤醒计划。
 *
 * 跨零点窗口（如 18:00-09:00）在 00:00-08:59 期间仍锚定到前一天的日期键，
 * 防止午夜跨日后重新随机抖动导致同一晚重复触发。
 *
 * @param {Date|number|string} now
 * @param {string} windowKey
 * @param {{ label?: string, start: string, end: string }} win
 * @param {object} [state]
 * @param {object} [cfg]
 * @param {() => number} [rng]
 * @returns {{
 *   ready: boolean,
 *   inWindow: boolean,
 *   targetMin: number | null,
 *   scheduleKey: string,
 *   schedulePatch: { windowSchedule: Record<string, number> } | null,
 *   waitMinutes: number
 * }}
 */
export function planWindowWakeup(now, windowKey, win, state = {}, cfg = {}, rng = Math.random) {
  const start = minutesOf(win?.start)
  const end = minutesOf(win?.end)
  if (start === null || end === null) {
    return { ready: false, inWindow: false, targetMin: null, scheduleKey: '', schedulePatch: null, waitMinutes: 0 }
  }

  const bjt = beijingTimeInfo(now)
  const wraps = start > end
  const weekdayInside = wraps
    ? (bjt.minutes >= start || bjt.minutes < end)
    : (bjt.minutes >= start && bjt.minutes < end)
  if (!bjt.isWeekend && !weekdayInside) {
    return { ready: false, inWindow: false, targetMin: null, scheduleKey: '', schedulePatch: null, waitMinutes: 0 }
  }

  // 跨零点夜间窗口在凌晨阶段锚定到窗口开始的日期，保证 23:30 与 01:15 共用同一 scheduleKey
  const inAfterMidnightTail = wraps && bjt.minutes < end
  const anchorDay = inAfterMidnightTail ? shiftBjtDay(bjt.dayKeyBjt, -1) : bjt.dayKeyBjt
  const curAnchored = inAfterMidnightTail ? bjt.minutes + MINUTES_PER_DAY : bjt.minutes
  const scheduleKey = `${anchorDay}:${String(windowKey || 'window')}`

  const rawMaxJitter = cfg?.windowJitterMaxMin ?? 45
  const maxJitter = Number.isFinite(Number(rawMaxJitter)) ? Number(rawMaxJitter) : 45
  if (!cfg?.jitterEnabled || maxJitter <= 0) {
    return {
      ready: true,
      inWindow: true,
      targetMin: bjt.minutes,
      scheduleKey,
      schedulePatch: null,
      waitMinutes: 0,
    }
  }

  // 周末全天都是谷时，结束边界顺延到下周一 09:00（避免周末白天被错误当成快到 14:00 截断）
  let endAnchored
  if (bjt.isWeekend) {
    const daysToMonday = bjt.weekday === 6 ? 2 : 1
    const baseOffset = inAfterMidnightTail ? MINUTES_PER_DAY : 0
    endAnchored = baseOffset + daysToMonday * MINUTES_PER_DAY + 9 * 60
  } else {
    endAnchored = wraps ? MINUTES_PER_DAY + end : end
  }

  const savedEntry = state?.windowSchedule?.[scheduleKey]
  const existingTarget = extractPlannedMin(savedEntry)
  if (existingTarget !== null) {
    const normalizedTarget = wraps && existingTarget < end ? existingTarget + MINUTES_PER_DAY : existingTarget
    const waitMinutes = Math.max(0, normalizedTarget - curAnchored)
    return {
      ready: curAnchored >= normalizedTarget,
      inWindow: true,
      targetMin: normalizedTarget,
      scheduleKey,
      schedulePatch: null,
      waitMinutes,
    }
  }

  const remaining = endAnchored - curAnchored
  let targetMin
  if (remaining < MIN_WINDOW_REMAINING_MIN) {
    targetMin = curAnchored
  } else {
    const baseMin = bjt.isWeekend ? curAnchored : Math.max(start, curAnchored)
    const effectiveMaxJitter = Math.max(0, Math.min(Math.floor(maxJitter), remaining - MIN_WINDOW_REMAINING_MIN))
    const sample = clampUnit(typeof rng === 'function' ? rng() : Math.random())
    const offset = Math.min(effectiveMaxJitter, Math.floor(sample * (effectiveMaxJitter + 1)))
    targetMin = baseMin + offset
  }

  const nextSchedule = pruneWindowSchedule(state?.windowSchedule, bjt.dayKeyBjt)
  nextSchedule[scheduleKey] = targetMin
  const waitMinutes = Math.max(0, targetMin - curAnchored)

  return {
    ready: curAnchored >= targetMin,
    inWindow: true,
    targetMin,
    scheduleKey,
    schedulePatch: { windowSchedule: nextSchedule },
    waitMinutes,
  }
}

function normalizeKeywords(rawKeywords) {
  if (!Array.isArray(rawKeywords)) return []
  const seen = new Set()
  const cleaned = []
  for (const item of rawKeywords) {
    const word = String(item ?? '').trim()
    if (!word || seen.has(word)) continue
    seen.add(word)
    cleaned.push(word)
  }
  return cleaned
}

function extractEligibleUps(tasteProfile) {
  const rawUps = tasteProfile?.ups
  const candidates = []
  if (Array.isArray(rawUps)) {
    for (const entry of rawUps) {
      if (!entry || typeof entry !== 'object') continue
      const key = String(entry.mid ?? entry.uid ?? entry.name ?? '').trim()
      if (!key) continue
      const affinity = Number(entry.affinity ?? 0)
      const muted = Boolean(entry.muted)
      if (!muted && affinity > 0) {
        candidates.push({
          key,
          mid: entry.mid ?? entry.uid ?? null,
          name: String(entry.name || key),
          affinity,
        })
      }
    }
  } else if (rawUps && typeof rawUps === 'object') {
    for (const [entryKey, entryVal] of Object.entries(rawUps)) {
      if (typeof entryVal === 'number') {
        if (entryVal > 0) candidates.push({ key: entryKey, mid: null, name: entryKey, affinity: entryVal })
        continue
      }
      if (!entryVal || typeof entryVal !== 'object') continue
      const affinity = Number(entryVal.affinity ?? 0)
      const muted = Boolean(entryVal.muted)
      if (!muted && affinity > 0) {
        candidates.push({
          key: entryKey,
          mid: entryVal.mid ?? entryVal.uid ?? null,
          name: String(entryVal.name || entryKey),
          affinity,
        })
      }
    }
  }
  return candidates.sort((a, b) => b.affinity - a.affinity)
}

function sampleTopUps(eligibleUps, rng) {
  if (!eligibleUps.length) return []
  const pool = eligibleUps.slice(0, Math.min(5, eligibleUps.length))
  const wantCount = pool.length >= 2 && clampUnit(rng()) < 0.6 ? 2 : 1
  const remaining = [...pool]
  const picked = []
  while (picked.length < wantCount && remaining.length > 0) {
    // 加权抽样保留高好感倾向，同时允许排位靠前的 UP 轮流出现
    const totalWeight = remaining.reduce((sum, item) => sum + Math.max(0.1, item.affinity), 0)
    let cursor = clampUnit(rng()) * totalWeight
    let chosenIdx = remaining.length - 1
    for (let idx = 0; idx < remaining.length; idx++) {
      cursor -= Math.max(0.1, remaining[idx].affinity)
      if (cursor <= 0) {
        chosenIdx = idx
        break
      }
    }
    picked.push(remaining.splice(chosenIdx, 1)[0])
  }
  return picked
}

function selectRotatedKeywords(keywords, state, rng) {
  if (!keywords.length) return []
  if (keywords.length === 1) return [keywords[0]]
  const count = clampUnit(rng()) < 0.55 ? 2 : 1
  const rawCursor = state?.keywordCursor ?? state?.count
  const startIdx = Number.isFinite(Number(rawCursor))
    ? Math.abs(Math.floor(Number(rawCursor))) % keywords.length
    : Math.floor(clampUnit(rng()) * keywords.length) % keywords.length
  const selected = []
  for (let offset = 0; offset < count; offset++) {
    selected.push(keywords[(startIdx + offset) % keywords.length])
  }
  return selected
}

function computeInteractionBudgets(cfg, state, todayKey, rng) {
  const daily = state?.dailyActions && typeof state.dailyActions === 'object' ? state.dailyActions : {}
  const activeDay = daily.day !== undefined ? String(daily.day) : String(state?.day || '')
  const sameDay = activeDay === todayKey

  const usedLikes = sameDay ? Math.max(0, Number(daily.likes ?? daily.like ?? 0) || 0) : 0
  const usedWatchLater = sameDay ? Math.max(0, Number(daily.watchLater ?? daily.watch_later ?? 0) || 0) : 0
  const usedCoins = sameDay ? Math.max(0, Number(daily.coins ?? daily.coin ?? 0) || 0) : 0
  const usedComments = sameDay ? Math.max(0, Number(daily.comments ?? daily.comment ?? 0) || 0) : 0

  const likePerRound = cfg?.likePerRound !== undefined ? Math.max(0, Number(cfg.likePerRound) || 0) : 2
  const likePerDay = cfg?.likePerDay !== undefined ? Math.max(0, Number(cfg.likePerDay) || 0) : 10
  const likesLeft = cfg?.autoLike ? Math.max(0, Math.min(likePerRound, likePerDay - usedLikes)) : 0

  const watchLaterPerRound =
    cfg?.watchLaterPerRound !== undefined ? Math.max(0, Number(cfg.watchLaterPerRound) || 0) : 2
  const watchLaterPerDay = cfg?.watchLaterPerDay !== undefined ? Math.max(0, Number(cfg.watchLaterPerDay) || 0) : 5
  const watchLaterLeft = cfg?.autoWatchLater
    ? Math.max(0, Math.min(watchLaterPerRound, watchLaterPerDay - usedWatchLater))
    : 0

  const coinPerDay = cfg?.coinPerDay !== undefined ? Math.max(0, Number(cfg.coinPerDay) || 0) : 2
  const coinPerRound = cfg?.coinPerRound !== undefined ? Math.max(0, Number(cfg.coinPerRound) || 0) : coinPerDay
  const coinsLeft = cfg?.autoCoin ? Math.max(0, Math.min(coinPerRound, coinPerDay - usedCoins)) : 0

  const dmMode = String(cfg?.dmMode ?? 'off').trim()
  const mentionName = String(cfg?.mentionName ?? '').trim()
  const commentEligible = Boolean(cfg?.autoComment) && dmMode !== 'only' && Boolean(mentionName)
  const commentPerRound = cfg?.commentPerRound !== undefined
    ? Math.max(0, Math.min(20, Math.floor(Number(cfg.commentPerRound) || 0)))
    : 1
  const rawChance = cfg?.commentChance !== undefined && cfg?.commentChance !== null ? Number(cfg.commentChance) : 65
  const commentChance = Number.isFinite(rawChance) ? Math.max(0, Math.min(100, rawChance)) : 65
  const commentDayCap = cfg?.commentPerDay !== undefined
    ? Math.max(0, Math.floor(Number(cfg.commentPerDay) || 0) - usedComments)
    : commentPerRound

  let commentBudget = 0
  if (commentEligible && commentPerRound > 0 && commentDayCap > 0 && commentChance > 0) {
    const slots = Math.min(commentPerRound, commentDayCap)
    if (commentChance >= 100) {
      commentBudget = slots
    } else {
      for (let slot = 0; slot < slots; slot++) {
        if (clampUnit(rng()) <= commentChance / 100) commentBudget++
      }
    }
  }

  return {
    likesLeft,
    watchLaterLeft,
    coinsLeft,
    commentBudget,
    commentChance,
  }
}

/**
 * 为本轮浏览生成自然节律与发现策略计划。
 *
 * @param {object} [cfg]
 * @param {object} [tasteProfile]
 * @param {object} [state]
 * @param {Date|number|string} [now]
 * @param {() => number} [rng]
 * @returns {{
 *   targetPicks: number,
 *   remainingQuota: number,
 *   sources: string[],
 *   selectedKeywords: string[],
 *   revisitUps: Array<{ key: string, mid: string | number | null, name: string, affinity: number }>,
 *   interactionBudgets: {
 *     likesLeft: number,
 *     watchLaterLeft: number,
 *     coinsLeft: number,
 *     commentBudget: number,
 *     commentChance: number
 *   },
 *   styleNote: string
 * }}
 */
export function buildBrowsePlan(cfg = {}, tasteProfile = {}, state = {}, now = new Date(), rng = Math.random) {
  const dateObj = safeDateOf(now)
  const todayKey = dayKey(dateObj)
  const safeRng = typeof rng === 'function' ? rng : Math.random

  const perDay = cfg?.perDay !== undefined && cfg?.perDay !== null ? Math.max(0, Number(cfg.perDay) || 0) : 5
  const sameStateDay = !state?.day || String(state.day) === todayKey
  let usedAuto = 0
  if (sameStateDay) {
    if (typeof state?.autoPickedToday === 'number' && Number.isFinite(state.autoPickedToday)) {
      usedAuto = Math.max(0, state.autoPickedToday)
    } else {
      const picked = Math.max(0, Number(state?.picked || 0))
      const manualExtra = Math.max(0, Number(state?.manualExtra || 0))
      usedAuto = Math.max(0, picked - manualExtra)
    }
  }

  const remainingQuota = Math.max(0, perDay - usedAuto)
  const isManual = Boolean(cfg?.isManual || state?.isManual)
  let targetPicks
  if (isManual) {
    targetPicks = Math.max(1, Number(cfg?.manualMax) || 3)
  } else if (remainingQuota <= 0) {
    targetPicks = 0
  } else if (cfg?.splitDailyRounds !== false) {
    const roundCap = Math.max(1, Number(cfg?.roundMaxPicks) || 3)
    targetPicks = Math.min(remainingQuota, roundCap)
  } else {
    targetPicks = remainingQuota
  }

  const keywords = normalizeKeywords(cfg?.keywords)
  const eligibleUps = extractEligibleUps(tasteProfile)
  const loggedIn = Boolean(cfg?.loggedIn ?? state?.loggedIn ?? state?.hasCredential)
  const browseMix = String(cfg?.browseMix || 'auto').trim()

  const sources = []
  let selectedKeywords = []
  let revisitUps = []

  if (targetPicks > 0) {
    const addSource = (src) => { if (!sources.includes(src)) sources.push(src) }

    if (browseMix === 'search_only' || browseMix === 'keywords') {
      if (keywords.length > 0) {
        addSource('search')
        selectedKeywords = selectRotatedKeywords(keywords, state, safeRng)
      } else {
        addSource('recommend')
      }
    } else if (browseMix === 'recommend_only' || browseMix === 'recommend') {
      addSource('recommend')
    } else if (browseMix === 'dynamic' || browseMix === 'following') {
      if (loggedIn) addSource('following_dynamic')
      addSource('recommend')
    } else if (keywords.length > 0) {
      // 有关键词时每轮只轮换 1~2 个词，避免一次把全列表轰炸一遍
      addSource('search')
      selectedKeywords = selectRotatedKeywords(keywords, state, safeRng)
      if (targetPicks >= 2 || clampUnit(safeRng()) < 0.7) addSource('recommend')
      if (eligibleUps.length > 0 && clampUnit(safeRng()) < 0.55) {
        addSource('up_revisit')
        revisitUps = sampleTopUps(eligibleUps, safeRng)
      }
    } else {
      addSource('recommend')
      if (loggedIn) addSource('following_dynamic')
      if (eligibleUps.length > 0) {
        addSource('up_revisit')
        revisitUps = sampleTopUps(eligibleUps, safeRng)
      }
      if (clampUnit(safeRng()) < 0.45) addSource('related_rabbit_hole')
    }
  }

  const interactionBudgets = computeInteractionBudgets(cfg, state, todayKey, safeRng)

  const sourceLabels = {
    search: selectedKeywords.length ? `关键词轮换（${selectedKeywords.join('、')}）` : '关键词搜索',
    recommend: '首页推荐流',
    following_dynamic: '关注动态流',
    up_revisit: revisitUps.length ? `老朋友 UP 回访（${revisitUps.map((u) => u.name).join('、')}）` : 'UP 回访',
    related_rabbit_hole: '相关推荐顺藤摸瓜',
  }

  const styleNote = targetPicks === 0
    ? '今日自动挑选配额已满，本轮不再额外新挑。'
    : `本轮计划挑 ${targetPicks} 条${isManual ? '（手动加餐，不扣自动配额）' : `（今日剩余自动配额 ${remainingQuota} 条）`}；`
      + `浏览路线：${sources.map((s) => sourceLabels[s] || s).join(' + ')}；`
      + `互动保持克制（点赞≤${interactionBudgets.likesLeft}、稍后再看≤${interactionBudgets.watchLaterLeft}`
      + `、投币≤${interactionBudgets.coinsLeft}、评论预算=${interactionBudgets.commentBudget}）。`

  return {
    targetPicks,
    remainingQuota,
    sources,
    selectedKeywords,
    revisitUps,
    interactionBudgets,
    styleNote,
  }
}

/**
 * 判断本条视频是否按自然节律执行评论（避免机械逢视频必评或 AI 扎堆）。
 *
 * @param {object} [options]
 * @param {number} [options.chance]
 * @param {number} [options.commentsAlreadyPlanned]
 * @param {number} [options.maxPerRound]
 * @param {number} [options.videoHotCommentCount]
 * @param {boolean} [options.existingAiSuspicion]
 * @param {() => number} [rng]
 * @returns {{ allow: boolean, reason: string }}
 */
export function shouldCommentRoll(options = {}, rng = Math.random) {
  const {
    chance = 65,
    commentsAlreadyPlanned = 0,
    maxPerRound = 1,
    videoHotCommentCount = 0,
    existingAiSuspicion = false,
  } = options || {}
  const cap = Number(maxPerRound)
  const planned = Number(commentsAlreadyPlanned)
  if (!Number.isFinite(cap) || cap <= 0 || planned >= cap) {
    return { allow: false, reason: `已达本轮评论上限（${planned}/${Math.max(0, cap || 0)}）` }
  }

  if (existingAiSuspicion) {
    return { allow: false, reason: '评论区已有疑似 AI 同款留言，跳过避免扎堆' }
  }

  const rawChance = chance === undefined || chance === null ? 65 : Number(chance)
  const clampedChance = Number.isFinite(rawChance) ? Math.max(0, Math.min(100, rawChance)) : 65
  if (clampedChance <= 0) {
    return { allow: false, reason: '评论触发概率为 0，本条跳过' }
  }
  if (clampedChance >= 100) {
    return {
      allow: true,
      reason: `概率 100% 直接放行（热评参考数 ${Math.max(0, Number(videoHotCommentCount) || 0)}）`,
    }
  }

  const safeRng = typeof rng === 'function' ? rng : Math.random
  const roll = clampUnit(safeRng())
  if (roll > clampedChance / 100) {
    return { allow: false, reason: `随机节律抽样跳过（${roll.toFixed(2)} > ${(clampedChance / 100).toFixed(2)}）` }
  }

  return {
    allow: true,
    reason: `通过随机节律抽样（热评参考数 ${Math.max(0, Number(videoHotCommentCount) || 0)}）`,
  }
}
