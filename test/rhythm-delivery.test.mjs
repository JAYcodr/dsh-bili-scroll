// node --test test/rhythm-delivery.test.mjs
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { WINDOWS, dayKey } from '../lib/state.mjs'
import {
  beijingTimeInfo,
  planWindowWakeup,
  buildBrowsePlan,
  shouldCommentRoll,
} from '../lib/rhythm.mjs'
import {
  extractPicksFromReport,
  parseReportMeta,
  readPicksSidecar,
  mergePicksWithReport,
  sanitizeDmText,
  splitDmMessages,
  recordDmHistory,
  recentDmHistory,
  recentDmOpeners,
  formatFriendReportInstruction,
  formatFriendDmInstruction,
} from '../lib/delivery.mjs'

const tempRoot = mkdtempSync(join(tmpdir(), 'bili-rhythm-delivery-'))
after(() => {
  rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

/** 按北京时间构造精确 UTC Date，完全不依赖运行机时区 */
function bjtDate(year, month, day, hour, minute) {
  return new Date(Date.UTC(year, month - 1, day, hour - 8, minute, 0))
}

/* ────────────────────── lib/rhythm.mjs 测试 ────────────────────── */

test('beijingTimeInfo：固定 UTC+8 换算跨零点与周末判定', () => {
  // 2026-11-18 为周三，23:30 BJT = 15:30 UTC
  const wedNight = bjtDate(2026, 11, 18, 23, 30)
  assert.deepEqual(beijingTimeInfo(wedNight), {
    minutes: 23 * 60 + 30,
    weekday: 3,
    isWeekend: false,
    dayKeyBjt: '2026-11-18',
  })

  // 2026-11-19 01:15 BJT = 2026-11-18 17:15 UTC
  const thuEarly = bjtDate(2026, 11, 19, 1, 15)
  assert.deepEqual(beijingTimeInfo(thuEarly), {
    minutes: 75,
    weekday: 4,
    isWeekend: false,
    dayKeyBjt: '2026-11-19',
  })

  // 2026-11-21 为周六，2026-11-22 为周日
  assert.equal(beijingTimeInfo(bjtDate(2026, 11, 21, 10, 0)).isWeekend, true)
  assert.equal(beijingTimeInfo(bjtDate(2026, 11, 22, 16, 0)).isWeekend, true)
})

test('planWindowWakeup：午间窗口抖动、关闭抖动与窗口尾段 20 分钟保底', () => {
  // 工作日窗口外（10:30）
  const out = planWindowWakeup(bjtDate(2026, 11, 18, 10, 30), 'noon', WINDOWS.noon, {}, { jitterEnabled: true })
  assert.equal(out.ready, false)
  assert.equal(out.inWindow, false)
  assert.equal(out.schedulePatch, null)

  // 关闭抖动时立刻就绪，不写补丁
  const noJitter = planWindowWakeup(
    bjtDate(2026, 11, 18, 12, 5),
    'noon',
    WINDOWS.noon,
    {},
    { jitterEnabled: false, windowJitterMaxMin: 45 },
  )
  assert.equal(noJitter.ready, true)
  assert.equal(noJitter.targetMin, 12 * 60 + 5)
  assert.equal(noJitter.scheduleKey, '2026-11-18:noon')
  assert.equal(noJitter.schedulePatch, null)

  // windowJitterMaxMin <= 0 同样立刻就绪
  const zeroJitter = planWindowWakeup(
    bjtDate(2026, 11, 18, 12, 5),
    'noon',
    WINDOWS.noon,
    {},
    { jitterEnabled: true, windowJitterMaxMin: 0 },
  )
  assert.equal(zeroJitter.ready, true)
  assert.equal(zeroJitter.schedulePatch, null)

  // 12:00 首次规划，rng=0.5 => offset=23 => targetMin=743 (12:23)
  const firstPlan = planWindowWakeup(
    bjtDate(2026, 11, 18, 12, 0),
    'noon',
    WINDOWS.noon,
    {},
    { jitterEnabled: true, windowJitterMaxMin: 45 },
    () => 0.5,
  )
  assert.equal(firstPlan.ready, false)
  assert.equal(firstPlan.targetMin, 743)
  assert.equal(firstPlan.waitMinutes, 23)
  assert.equal(firstPlan.scheduleKey, '2026-11-18:noon')
  assert.deepEqual(firstPlan.schedulePatch, { windowSchedule: { '2026-11-18:noon': 743 } })

  // 复用持久化计划：12:15 未到点；12:23 到点
  const persistedState = { ...firstPlan.schedulePatch }
  const beforeTarget = planWindowWakeup(
    bjtDate(2026, 11, 18, 12, 15),
    'noon',
    WINDOWS.noon,
    persistedState,
    { jitterEnabled: true, windowJitterMaxMin: 45 },
  )
  assert.equal(beforeTarget.ready, false)
  assert.equal(beforeTarget.waitMinutes, 8)
  assert.equal(beforeTarget.schedulePatch, null)

  const atTarget = planWindowWakeup(
    bjtDate(2026, 11, 18, 12, 23),
    'noon',
    WINDOWS.noon,
    persistedState,
    { jitterEnabled: true, windowJitterMaxMin: 45 },
  )
  assert.equal(atTarget.ready, true)
  assert.equal(atTarget.waitMinutes, 0)
  assert.equal(atTarget.schedulePatch, null)

  // 13:30（距离 14:00 剩 30 分钟），最大抖动只能取到 13:40（820），确保留足 20 分钟
  const clamped = planWindowWakeup(
    bjtDate(2026, 11, 18, 13, 30),
    'noon',
    WINDOWS.noon,
    {},
    { jitterEnabled: true, windowJitterMaxMin: 45 },
    () => 0.999,
  )
  assert.equal(clamped.targetMin, 820)
  assert.equal(840 - clamped.targetMin, 20)

  // 13:45（距离 14:00 仅剩 15 分钟 < 20 分钟），立刻唤醒
  const immediate = planWindowWakeup(
    bjtDate(2026, 11, 18, 13, 45),
    'noon',
    WINDOWS.noon,
    {},
    { jitterEnabled: true, windowJitterMaxMin: 45 },
    () => 0.9,
  )
  assert.equal(immediate.ready, true)
  assert.equal(immediate.targetMin, 13 * 60 + 45)
  assert.equal(immediate.waitMinutes, 0)
})

test('planWindowWakeup：跨零点夜间窗口 23:30 与 01:15 共用锚定键且跨午夜不重随', () => {
  // 23:50 BJT（Nov 18），rng=0.99, maxJitter=45 -> targetMin = 1430 + 45 = 1475（次日 00:35）
  const lateNight = planWindowWakeup(
    bjtDate(2026, 11, 18, 23, 50),
    'night',
    WINDOWS.night,
    {},
    { jitterEnabled: true, windowJitterMaxMin: 45 },
    () => 0.99,
  )
  assert.equal(lateNight.scheduleKey, '2026-11-18:night')
  assert.equal(lateNight.ready, false)
  assert.equal(lateNight.targetMin, 1475)
  assert.equal(lateNight.waitMinutes, 45)

  // Nov 19 00:15 BJT：仍锚定 2026-11-18:night，还要等 20 分钟
  const afterMidnightWait = planWindowWakeup(
    bjtDate(2026, 11, 19, 0, 15),
    'night',
    WINDOWS.night,
    lateNight.schedulePatch,
    { jitterEnabled: true, windowJitterMaxMin: 45 },
  )
  assert.equal(afterMidnightWait.scheduleKey, '2026-11-18:night')
  assert.equal(afterMidnightWait.ready, false)
  assert.equal(afterMidnightWait.waitMinutes, 20)
  assert.equal(afterMidnightWait.schedulePatch, null)

  // Nov 19 01:15 BJT：仍共用 2026-11-18:night 且已过 00:35 -> ready=true
  const earlyMorningReady = planWindowWakeup(
    bjtDate(2026, 11, 19, 1, 15),
    'night',
    WINDOWS.night,
    lateNight.schedulePatch,
    { jitterEnabled: true, windowJitterMaxMin: 45 },
  )
  assert.equal(earlyMorningReady.scheduleKey, '2026-11-18:night')
  assert.equal(earlyMorningReady.ready, true)
  assert.equal(earlyMorningReady.waitMinutes, 0)

  // 周六 13:50 属于全天谷时，不应按 14:00 截断
  const weekendNoon = planWindowWakeup(
    bjtDate(2026, 11, 21, 13, 50),
    'noon',
    WINDOWS.noon,
    {},
    { jitterEnabled: true, windowJitterMaxMin: 45 },
    () => 0.5,
  )
  assert.equal(weekendNoon.inWindow, true)
  assert.equal(weekendNoon.targetMin, 13 * 60 + 50 + 23)
  assert.equal(weekendNoon.ready, false)
})

test('buildBrowsePlan：分轮配额、关键词轮换、屏蔽 UP 过滤、每日互动预算扣减与跨日重置', () => {
  const now = bjtDate(2026, 11, 18, 12, 30)
  const today = dayKey(now)
  const taste = {
    ups: {
      up_muted: { name: '吵闹营销号', mid: 1001, affinity: 99, muted: true },
      up_zero: { name: '无好感', mid: 1002, affinity: 0, muted: false },
      up_rust: { name: 'Rust老王', mid: 1003, affinity: 18, muted: false },
      up_esp: { name: '硬件小李', mid: 1004, affinity: 12, muted: false },
    },
  }

  // 分轮上限与手动轮加餐
  const splitPlan = buildBrowsePlan(
    { perDay: 5, roundMaxPicks: 2, splitDailyRounds: true, keywords: ['Rust', 'ESP32', 'AI', 'Linux'] },
    taste,
    { day: today, picked: 2, manualExtra: 1, count: 0 },
    now,
    () => 0.1,
  )
  // 自动已挑 = 2 - 1 = 1，剩余 = 4，单轮 cap = 2
  assert.equal(splitPlan.remainingQuota, 4)
  assert.equal(splitPlan.targetPicks, 2)
  assert.ok(splitPlan.selectedKeywords.length >= 1 && splitPlan.selectedKeywords.length <= 2)
  assert.deepEqual(splitPlan.selectedKeywords, ['Rust', 'ESP32'])

  // 下一轮 count=2 轮换到后面关键词
  const round2Plan = buildBrowsePlan(
    { perDay: 5, roundMaxPicks: 2, splitDailyRounds: true, keywords: ['Rust', 'ESP32', 'AI', 'Linux'] },
    taste,
    { day: today, picked: 3, manualExtra: 1, count: 2 },
    now,
    () => 0.9,
  )
  assert.deepEqual(round2Plan.selectedKeywords, ['AI'])

  // 关闭分轮时一次性给足剩余配额
  const unsplitPlan = buildBrowsePlan(
    { perDay: 5, splitDailyRounds: false },
    taste,
    { day: today, picked: 1 },
    now,
    () => 0.2,
  )
  assert.equal(unsplitPlan.targetPicks, 4)

  // 手动轮即使自动配额已满，仍遵守 manualMax
  const manualPlan = buildBrowsePlan(
    { perDay: 5, manualMax: 2, isManual: true },
    taste,
    { day: today, picked: 5 },
    now,
    () => 0.2,
  )
  assert.equal(manualPlan.remainingQuota, 0)
  assert.equal(manualPlan.targetPicks, 2)

  // 空关键词 + 已登录：融合 recommend / following_dynamic / up_revisit / 偶发 related_rabbit_hole，且绝不选 muted UP
  const discoveryPlan = buildBrowsePlan(
    { perDay: 5, browseMix: 'auto', loggedIn: true },
    taste,
    { day: today, picked: 0 },
    now,
    () => 0.2,
  )
  assert.ok(discoveryPlan.sources.includes('recommend'))
  assert.ok(discoveryPlan.sources.includes('following_dynamic'))
  assert.ok(discoveryPlan.sources.includes('up_revisit'))
  assert.ok(discoveryPlan.sources.includes('related_rabbit_hole'))
  assert.ok(discoveryPlan.revisitUps.length >= 1 && discoveryPlan.revisitUps.length <= 2)
  for (const up of discoveryPlan.revisitUps) {
    assert.notEqual(up.key, 'up_muted')
    assert.notEqual(up.key, 'up_zero')
  }

  // 未登录时不出现 following_dynamic
  const loggedOutPlan = buildBrowsePlan(
    { perDay: 5, browseMix: 'auto', loggedIn: false },
    taste,
    { day: today, picked: 0 },
    now,
    () => 0.8,
  )
  assert.equal(loggedOutPlan.sources.includes('following_dynamic'), false)
  assert.equal(loggedOutPlan.sources.includes('related_rabbit_hole'), false)

  // 互动预算扣减与跨日重置
  const budgetCfg = {
    perDay: 5,
    autoLike: true,
    likePerRound: 3,
    likePerDay: 5,
    autoWatchLater: true,
    watchLaterPerRound: 2,
    watchLaterPerDay: 3,
    autoCoin: true,
    coinPerDay: 2,
    autoComment: true,
    dmMode: 'both',
    mentionName: '小明',
    commentPerRound: 2,
    commentChance: 100,
  }
  const sameDayBudgets = buildBrowsePlan(
    budgetCfg,
    {},
    {
      day: today,
      dailyActions: { day: today, likes: 4, watchLater: 2, coins: 1 },
    },
    now,
    () => 0.5,
  ).interactionBudgets
  assert.equal(sameDayBudgets.likesLeft, 1)
  assert.equal(sameDayBudgets.watchLaterLeft, 1)
  assert.equal(sameDayBudgets.coinsLeft, 1)
  assert.equal(sameDayBudgets.commentBudget, 2)

  // 昨天记录不占今天额度
  const rolledBudgets = buildBrowsePlan(
    budgetCfg,
    {},
    {
      day: '2020-01-01',
      dailyActions: { day: '2020-01-01', likes: 99, watchLater: 99, coins: 99 },
    },
    now,
    () => 0.5,
  ).interactionBudgets
  assert.equal(rolledBudgets.likesLeft, 3)
  assert.equal(rolledBudgets.watchLaterLeft, 2)
  assert.equal(rolledBudgets.coinsLeft, 2)

  // dmMode === 'only' 或 commentChance === 0 时 commentBudget 为 0
  const dmOnlyBudget = buildBrowsePlan(
    { ...budgetCfg, dmMode: 'only' },
    {},
    {},
    now,
    () => 0,
  ).interactionBudgets
  assert.equal(dmOnlyBudget.commentBudget, 0)

  const zeroChanceBudget = buildBrowsePlan(
    { ...budgetCfg, commentChance: 0 },
    {},
    {},
    now,
    () => 0,
  ).interactionBudgets
  assert.equal(zeroChanceBudget.commentBudget, 0)
})

test('shouldCommentRoll：上限、AI 味扎堆风险与 0/100 概率边界', () => {
  assert.equal(shouldCommentRoll({ commentsAlreadyPlanned: 1, maxPerRound: 1, chance: 100 }).allow, false)
  assert.equal(shouldCommentRoll({ commentsAlreadyPlanned: 0, maxPerRound: 0, chance: 100 }).allow, false)
  assert.equal(shouldCommentRoll({ existingAiSuspicion: true, chance: 100 }).allow, false)
  assert.equal(shouldCommentRoll({ chance: 0 }, () => 0).allow, false)
  assert.equal(shouldCommentRoll({ chance: 100 }, () => 0.9999).allow, true)
  assert.equal(shouldCommentRoll({ chance: 65 }, () => 0.65).allow, true)
  assert.equal(shouldCommentRoll({ chance: 65 }, () => 0.66).allow, false)
})

/* ────────────────────── lib/delivery.mjs 测试 ────────────────────── */

test('extractPicksFromReport & parseReportMeta：兼容老格式、朋友格式、隐藏锚点并跳过代码围栏', () => {
  const report = [
    '# 刷B站日报 2026-11-18',
    '',
    '```markdown',
    '### BV1fake00000',
    '**档位**：值得看',
    '<!-- bili-pick: BV1fake11111 | tier=值得看 | up=围栏里的 -->',
    '```',
    '',
    '~~~',
    '### [围栏标题](https://www.bilibili.com/video/BV1fake22222)',
    '~~~',
    '',
    '### BV1old111111',
    '标题：经典老格式视频',
    'UP：老式作者',
    '**档位**：可以看',
    '**为什么值得**：把核心机制讲得很清楚，虽然节奏稍微慢一点。',
    '',
    '### [超硬核 Rust 编译器拆解](https://www.bilibili.com/video/BV1fri222222?spm_id_from=333.1007)',
    '<!-- bili-pick: BV1fri222222 | tier=值得看 | up=技术老张 -->',
    '',
    '他直接从词法分析写到 MIR 优化，全片无废话而且每一步都跑了基准测试。',
    '',
    '### 另一个好玩的硬件视频 (BV1par333333)',
    'UP：电路小王',
    '手把手焊了一块便携示波器，实操踩坑环节非常真实。',
    '',
    '<!-- bili-pick: BV1anc444444 | tier=值得看 | up=独立开发者 | title=仅锚点推荐 -->',
    '没有写三级标题，只用了自然段聊聊为什么值得点开。',
    '',
    '## 投递',
    '',
    '- 已私信（BV1old111111）',
    '',
    '## 小结',
    '',
    '今天收获不错，因无字幕跳过 2 条。',
  ].join('\n')

  const bvids = extractPicksFromReport(report)
  assert.deepEqual(bvids, ['BV1old111111', 'BV1fri222222', 'BV1par333333', 'BV1anc444444'])

  const meta = parseReportMeta(report)
  assert.deepEqual(meta.get('BV1old111111'), {
    tier: '可以看',
    why: '把核心机制讲得很清楚，虽然节奏稍微慢一点。',
    title: '经典老格式视频',
    up: '老式作者',
  })
  assert.deepEqual(meta.get('BV1fri222222'), {
    tier: '值得看',
    why: '他直接从词法分析写到 MIR 优化，全片无废话而且每一步都跑了基准测试。',
    title: '超硬核 Rust 编译器拆解',
    up: '技术老张',
  })
  assert.deepEqual(meta.get('BV1par333333'), {
    tier: '',
    why: '手把手焊了一块便携示波器，实操踩坑环节非常真实。',
    title: '另一个好玩的硬件视频',
    up: '电路小王',
  })
  assert.deepEqual(meta.get('BV1anc444444'), {
    tier: '值得看',
    why: '没有写三级标题，只用了自然段聊聊为什么值得点开。',
    title: '仅锚点推荐',
    up: '独立开发者',
  })
  assert.equal(meta.has('BV1fake00000'), false)
  assert.equal(meta.has('BV1fake11111'), false)
  assert.equal(meta.has('BV1fake22222'), false)
})

test('readPicksSidecar & mergePicksWithReport：合并边车补全缺失字段、去重并容错损坏行', () => {
  const dir = mkdtempSync(join(tempRoot, 'merge-'))
  const day = '2026-11-18'
  mkdirSync(join(dir, 'out'), { recursive: true })
  mkdirSync(join(dir, 'picks'), { recursive: true })

  // 缺失文件时不崩
  assert.deepEqual(readPicksSidecar(dir, day), [])

  // 日报里 BV1aaa111111 缺少 tier/up，BV1bbb222222 仅在报告里
  writeFileSync(
    join(dir, 'out', `${day}.md`),
    [
      '### 朋友推荐视频 (BV1aaa111111)',
      '',
      '整期拆解得很扎实，值得花十分钟看完。',
      '',
      '### BV1bbb222222',
      '标题：纯报告条目',
      '**档位**：可以看',
      '**为什么值得**：有几个命令很实用。',
    ].join('\n'),
    'utf8',
  )

  // 边车含损坏行、重复行以及报告里漏掉的 BV1ccc333333
  writeFileSync(
    join(dir, 'picks', `${day}.jsonl`),
    [
      '{broken json line',
      JSON.stringify({ bvid: 'NOT_A_BV', title: '无效' }),
      JSON.stringify({ bvid: 'BV1aaa111111', tier: '值得看', up: '老王', title: '旧标题' }),
      JSON.stringify({ bvid: 'BV1aaa111111', tier: '值得看', up: '老王Tech', why: '边车里的理由' }),
      JSON.stringify({ bvid: 'BV1ccc333333', title: '仅边车条目', up: '边车UP', tier: '值得看', why: '边车补充' }),
    ].join('\n') + '\n',
    'utf8',
  )

  const sidecar = readPicksSidecar(dir, day)
  assert.equal(sidecar.length, 2)
  assert.equal(sidecar[0].up, '老王Tech')

  const merged = mergePicksWithReport(dir, day)
  assert.deepEqual(merged.bvids, ['BV1aaa111111', 'BV1bbb222222', 'BV1ccc333333'])
  assert.equal(merged.metaMap.get('BV1aaa111111').tier, '值得看')
  assert.equal(merged.metaMap.get('BV1aaa111111').up, '老王Tech')
  assert.equal(merged.metaMap.get('BV1aaa111111').title, '朋友推荐视频')
  assert.equal(merged.metaMap.get('BV1aaa111111').why, '整期拆解得很扎实，值得花十分钟看完。')
  assert.equal(merged.items.length, 3)
  assert.equal(merged.items[2].url, 'https://www.bilibili.com/video/BV1ccc333333')
})

test('sanitizeDmText：清理 Markdown 语法、保护 URL、压缩 @ 昵称与去除机械尾巴', () => {
  const dirty = [
    '### 今天刷到两条硬货',
    '<!-- bili-pick: BV1aaa111111 | tier=值得看 -->',
    '- **[Rust 零成本抽象](https://www.bilibili.com/video/BV1aaa111111?spm_id=1__2&p=1)**：讲得很通透',
    '- __重点推荐__ [https://www.bilibili.com/video/BV1bbb222222](https://www.bilibili.com/video/BV1bbb222222)'
      + ' 看看 `BV1bbb222222`',
    '@ 小明 快来看看，如需更详细的信息请告诉我。 (28字，可继续发送)',
  ].join('\n')

  const clean = sanitizeDmText(dirty)
  assert.equal(clean.includes('**'), false)
  assert.equal(clean.includes('__重点推荐__'), false)
  assert.ok(clean.includes('重点推荐 https://www.bilibili.com/video/BV1bbb222222 看看 BV1bbb222222'))
  assert.equal(clean.includes('###'), false)
  assert.equal(clean.includes('`'), false)
  assert.equal(clean.includes('bili-pick'), false)
  assert.equal(clean.includes('28字'), false)
  assert.equal(clean.includes('如需更详细的信息'), false)
  assert.ok(clean.includes('Rust 零成本抽象 https://www.bilibili.com/video/BV1aaa111111?spm_id=1__2&p=1'))
  assert.ok(clean.includes('@小明'))
  assert.equal(clean.includes('@ 小明'), false)
})

test('splitDmMessages：短文本不拆、URL 不切断、中文句末边界切分、<=maxLen 且受 maxParts 约束', () => {
  assert.deepEqual(splitDmMessages('   '), [])
  assert.deepEqual(splitDmMessages('**短消息** https://www.bilibili.com/video/BV1aaa111111', 460, 3), [
    '短消息 https://www.bilibili.com/video/BV1aaa111111',
  ])

  // 长消息带中文句末与 URL，切分时不得截断 URL 且每段 <= 120
  const url = 'https://www.bilibili.com/video/BV1aaa111111?vd_source=abcdef123456'
  const longText = [
    '第一条讲透了底层内存布局，动画演示非常清楚。补充一句实操细节在这里。',
    `先看这个 ${url}`,
    '',
    '第二条对比了三种常见方案的性能基准，测试数据全公开。非常适合写库参考。',
    '第三条聊了开源社区最近的新动向，观点挺犀利，值得留十分钟看看。',
  ].join('\n')

  const parts = splitDmMessages(longText, 120, 3)
  assert.ok(parts.length >= 2 && parts.length <= 3)
  for (const part of parts) {
    assert.ok(part.length > 0 && part.length <= 120, `part 超长 (${part.length}): ${part}`)
  }
  assert.ok(parts.some((p) => p.includes(url)), 'URL 必须完整保留在某一段中')

  // 超出 maxParts 时截断并加省略号，且不超出 maxLen
  const overflow = Array.from({ length: 10 }, (_, idx) => `第${idx + 1}段内容用来测试超出分段上限时的截断行为。`).join('\n\n')
  const capped = splitDmMessages(overflow, 60, 2)
  assert.equal(capped.length, 2)
  assert.ok(capped[0].length <= 60)
  assert.ok(capped[1].length <= 60)
  assert.ok(capped[1].endsWith('…'))
})

test('recordDmHistory / recentDmHistory / recentDmOpeners：追加、容错与开场白去重', () => {
  const dir = mkdtempSync(join(tempRoot, 'dmhist-'))
  assert.deepEqual(recentDmHistory(dir), [])
  assert.deepEqual(recentDmOpeners(dir), [])

  recordDmHistory(dir, {
    uid: 12345,
    direction: 'out',
    text: '刚帮你刷了一圈，今天这两个挺有意思\nhttps://www.bilibili.com/video/BV1aaa111111',
  })
  recordDmHistory(dir, {
    uid: 12345,
    direction: 'in',
    text: '收到了谢谢',
  })
  recordDmHistory(dir, {
    uid: 12345,
    direction: 'out',
    text: '午休顺手翻了下，发现一个冷门宝藏教程，超过二十五个字的部分应该被优雅截断掉\n第二行',
  })
  // 人为注入一条损坏行验证读取韧性
  const histFile = join(dir, 'dm-history.jsonl')
  writeFileSync(histFile, readFileSync(histFile, 'utf8') + '{bad-json\n', 'utf8')

  const hist = recentDmHistory(dir, 8)
  assert.equal(hist.length, 3)
  assert.deepEqual(hist[0].bvids, ['BV1aaa111111'])

  const openers = recentDmOpeners(dir, 5)
  assert.equal(openers.length, 2)
  assert.equal(openers[0], '刚帮你刷了一圈，今天这两个挺有意思')
  assert.equal(openers[1].length, 25)
  assert.ok(!openers.includes('收到了谢谢'))
})

test('formatFriendReportInstruction & formatFriendDmInstruction：按配置生成正确指令', () => {
  const friendReport = formatFriendReportInstruction({ reportStyle: 'friend', reportLevel: 'full' })
  assert.ok(friendReport.includes('<!-- bili-pick:'))
  assert.ok(friendReport.includes('duty_pick_record'))

  const structuredReport = formatFriendReportInstruction({ reportStyle: 'structured', reportLevel: 'brief' })
  assert.ok(structuredReport.includes('### BV号'))
  assert.ok(structuredReport.includes('一两句以内'))

  const offReport = formatFriendReportInstruction({ reportLevel: 'off' })
  assert.ok(offReport.includes('不写日报'))

  const friendDm = formatFriendDmInstruction(
    { dmStyle: 'friend', dmSplitMessages: true, dmSkipEmpty: true },
    {
      recentOpeners: ['刚帮你刷了一圈'],
      todayPicks: [{ bvid: 'BV1aaa111111', title: '好视频' }],
    },
  )
  assert.ok(friendDm.includes('朋友聊天口吻'))
  assert.ok(friendDm.includes('460'))
  assert.ok(friendDm.includes('跳过发私信'))
  assert.ok(friendDm.includes('刚帮你刷了一圈'))
  assert.ok(friendDm.includes('BV1aaa111111（好视频）'))

  const digestDm = formatFriendDmInstruction(
    { dmStyle: 'digest', dmSplitMessages: false, dmSkipEmpty: false },
    {},
  )
  assert.ok(digestDm.includes('精简清单'))
  assert.ok(digestDm.includes('只发 1 条'))
})

test('边界补充：数组形式 UP 列表、配额耗尽、仅边车无日报、H2 标题与超长无空白 token 切分', () => {
  const now = bjtDate(2026, 11, 18, 13, 0)
  const today = dayKey(now)

  // 配额已满
  const exhausted = buildBrowsePlan({ perDay: 3 }, {}, { day: today, picked: 3 }, now)
  assert.equal(exhausted.remainingQuota, 0)
  assert.equal(exhausted.targetPicks, 0)
  assert.deepEqual(exhausted.sources, [])

  // 数组形式的 tasteProfile.ups + search_only 模式
  const arrayUpsPlan = buildBrowsePlan(
    { perDay: 5, browseMix: 'auto', loggedIn: false },
    {
      ups: [
        { mid: 201, name: '被屏蔽UP', affinity: 100, muted: true },
        { mid: 202, name: '高好感UP', affinity: 30, muted: false },
      ],
    },
    { day: today, picked: 0 },
    now,
    () => 0.1,
  )
  assert.equal(arrayUpsPlan.revisitUps.length, 1)
  assert.equal(arrayUpsPlan.revisitUps[0].name, '高好感UP')

  const searchOnlyPlan = buildBrowsePlan(
    { perDay: 5, browseMix: 'search_only', keywords: ['  ', 'Go', 'Go', 'Zig'] },
    {},
    { day: today, picked: 0, keywordCursor: 1 },
    now,
    () => 0.9,
  )
  assert.deepEqual(searchOnlyPlan.sources, ['search'])
  assert.deepEqual(searchOnlyPlan.selectedKeywords, ['Zig'])

  // null 入参安全
  assert.equal(shouldCommentRoll(null, () => 0.1).allow, true)

  // H2 标题、链接文字等于 BV 号时回退正文标题、多行锚点注释
  const edgeReport = [
    '## BV1h2a111111',
    '**档位**：值得看',
    '**为什么值得**：二级标题也应正常识别。',
    '',
    '### [BV1lnk222222](https://www.bilibili.com/video/BV1lnk222222)',
    '<!-- bili-pick: BV1lnk222222',
    '  | tier=可以看 | up=分拆作者 -->',
    '标题：正文里的真实标题',
    '',
    '这是自然段总结。',
  ].join('\n')

  assert.deepEqual(extractPicksFromReport(edgeReport), ['BV1h2a111111', 'BV1lnk222222'])
  const edgeMeta = parseReportMeta(edgeReport)
  assert.equal(edgeMeta.get('BV1h2a111111').tier, '值得看')
  assert.equal(edgeMeta.get('BV1lnk222222').title, '正文里的真实标题')
  assert.equal(edgeMeta.get('BV1lnk222222').up, '分拆作者')
  assert.equal(edgeMeta.get('BV1lnk222222').tier, '可以看')

  // 无 out/<day>.md，仅 picks/<day>.jsonl 边车存在
  const sidecarOnlyDir = mkdtempSync(join(tempRoot, 'sidecar-only-'))
  mkdirSync(join(sidecarOnlyDir, 'picks'), { recursive: true })
  writeFileSync(
    join(sidecarOnlyDir, 'picks', '2026-11-18.jsonl'),
    JSON.stringify({ bvid: 'BV1sc1111111', title: '仅边车视频', up: '作者甲', tier: '值得看', why: '边车兜底' }) + '\n',
    'utf8',
  )
  const mergedSidecarOnly = mergePicksWithReport(sidecarOnlyDir, '2026-11-18')
  assert.deepEqual(mergedSidecarOnly.bvids, ['BV1sc1111111'])
  assert.equal(mergedSidecarOnly.items[0].title, '仅边车视频')

  // 无空白超长 token 强制切分与 limit 刚好落入 URL 时整条挪段
  const unbroken = 'x'.repeat(95)
  const splitUnbroken = splitDmMessages(unbroken, 40, 2)
  assert.equal(splitUnbroken.length, 2)
  assert.equal(splitUnbroken[0].length, 40)
  assert.equal(splitUnbroken[1].length, 40)
  assert.ok(splitUnbroken[1].endsWith('…'))

  const nearUrl = '前文简短提示 https://www.bilibili.com/video/BV1url111111?vd_source=1234567890'
  const splitUrl = splitDmMessages(nearUrl, 70, 3)
  assert.equal(splitUrl.length, 2)
  assert.equal(splitUrl[0], '前文简短提示')
  assert.equal(splitUrl[1], 'https://www.bilibili.com/video/BV1url111111?vd_source=1234567890')

  const tinyLimit = splitDmMessages(nearUrl, 45, 3)
  assert.ok(tinyLimit.every((p) => p.length > 0 && p.length <= 45))
})
