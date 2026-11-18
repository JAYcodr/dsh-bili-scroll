// node --test test/persona-memory.test.mjs
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PERSONA_PRESETS,
  resolveOwnerPersonaText,
  deriveMoodContext,
  loadNovaMemoryHints,
  compileDutyPersona,
  compileDmPersona,
} from '../lib/persona.mjs'
import {
  extractBigrams,
  textSimilarity,
  extractDmFeedbackSignals,
  createMemoryStore,
} from '../lib/memory.mjs'

const root = mkdtempSync(join(tmpdir(), 'bili-v3-pm-'))
after(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

function makeTempDir(prefix) {
  return mkdtempSync(join(root, prefix))
}

test('PERSONA_PRESETS 包含全部四档且结构完整', () => {
  assert.deepEqual(Object.keys(PERSONA_PRESETS).sort(), ['buddy', 'chill_geek', 'curious_night', 'custom'])
  for (const key of ['buddy', 'chill_geek', 'curious_night', 'custom']) {
    const preset = PERSONA_PRESETS[key]
    assert.equal(preset.id, key)
    assert.ok(typeof preset.label === 'string' && preset.label.length > 0)
    assert.ok(typeof preset.summary === 'string' && preset.summary.length > 0)
    assert.ok(Array.isArray(preset.traits) && preset.traits.length > 0)
    assert.ok(Array.isArray(preset.speechRules) && preset.speechRules.length > 0)
    assert.ok(Array.isArray(preset.bannedPatterns) && preset.bannedPatterns.length > 0)
  }
})

test('resolveOwnerPersonaText：支持直填文本、~/ 路径、目录 AGENTS.md、工作区兜底与 40000 字截断', () => {
  // 1. 直填普通文字
  const inline = resolveOwnerPersonaText({ personaPrompt: '  别装可爱，直接说结论  ' })
  assert.deepEqual(inline, { text: '别装可爱，直接说结论', source: 'config' })

  // 2. 多行文本即使首行以 / 开头也不应误判为路径
  const multi = resolveOwnerPersonaText({ personaPrompt: '/第一行说明\n第二行风格' })
  assert.deepEqual(multi, { text: '/第一行说明\n第二行风格', source: 'config' })

  // 3. 绝对路径文件
  const dir = makeTempDir('persona-')
  const customFile = join(dir, 'my-persona.md')
  writeFileSync(customFile, '说话短一点，少用感叹号', 'utf8')
  const fromAbs = resolveOwnerPersonaText({ personaPrompt: customFile })
  assert.deepEqual(fromAbs, { text: '说话短一点，少用感叹号', source: customFile })

  // 4. 目录路径自动读 AGENTS.md
  const dirWs = makeTempDir('persona-dir-')
  const agentsInDir = join(dirWs, 'AGENTS.md')
  writeFileSync(agentsInDir, '目录里的 AGENTS 人设', 'utf8')
  const fromDir = resolveOwnerPersonaText({ personaPrompt: dirWs })
  assert.deepEqual(fromDir, { text: '目录里的 AGENTS 人设', source: agentsInDir })

  // 5. ~/ 路径展开（分别测试 HOME 与 USERPROFILE 兜底）
  const fakeHome = makeTempDir('fake-home-')
  const homePersona = join(fakeHome, 'custom.md')
  writeFileSync(homePersona, '来自 ~/custom.md 的人设', 'utf8')
  const oldHome = process.env.HOME
  const oldUserProfile = process.env.USERPROFILE
  try {
    process.env.HOME = fakeHome
    delete process.env.USERPROFILE
    const fromTildeHome = resolveOwnerPersonaText({ personaPrompt: '~/custom.md' })
    assert.deepEqual(fromTildeHome, { text: '来自 ~/custom.md 的人设', source: homePersona })

    delete process.env.HOME
    process.env.USERPROFILE = fakeHome
    const fromTildeProfile = resolveOwnerPersonaText({ personaPrompt: '~/custom.md' })
    assert.deepEqual(fromTildeProfile, { text: '来自 ~/custom.md 的人设', source: homePersona })
  } finally {
    if (oldHome === undefined) delete process.env.HOME
    else process.env.HOME = oldHome
    if (oldUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = oldUserProfile
  }

  // 6. workspace/AGENTS.md 兜底
  const wsOnly = makeTempDir('ws-only-')
  const wsAgents = join(wsOnly, 'AGENTS.md')
  writeFileSync(wsAgents, '工作区 AGENTS 人设', 'utf8')
  assert.deepEqual(resolveOwnerPersonaText({ workspace: wsOnly }), {
    text: '工作区 AGENTS 人设',
    source: wsAgents,
  })

  // 7. 都不存在时返回空且不抛错
  const warnings = []
  assert.deepEqual(
    resolveOwnerPersonaText({ personaPrompt: 'C:\\not-exists\\AGENTS.md' }, (m) => warnings.push(m)),
    { text: '', source: '' },
  )
  assert.ok(warnings.some((w) => w.includes('不可读') || w.includes('不存在')))

  // 8. 超过 40000 字符截断并输出日志警告
  const longWarnings = []
  const huge = '字'.repeat(40500)
  const truncInline = resolveOwnerPersonaText({ personaPrompt: huge }, (m) => longWarnings.push(m))
  assert.equal(truncInline.text.length, 40000)
  assert.equal(truncInline.source, 'config')
  assert.ok(longWarnings.some((w) => w.includes('40000')))

  const hugeFile = join(dir, 'huge.md')
  writeFileSync(hugeFile, 'a'.repeat(41000), 'utf8')
  const fileWarnings = []
  const truncFile = resolveOwnerPersonaText({ personaPrompt: hugeFile }, (m) => fileWarnings.push(m))
  assert.equal(truncFile.text.length, 40000)
  assert.equal(truncFile.source, hugeFile)
  assert.ok(fileWarnings.some((w) => w.includes('40000')))
})

test('deriveMoodContext：严格按北京时间（UTC+8）划分时段并结合命中统计', () => {
  // 2026-11-18 是周三
  const bj = (y, m, d, hh, mm) => new Date(Date.UTC(y, m - 1, d, hh - 8, mm))

  assert.equal(deriveMoodContext(bj(2026, 11, 18, 6, 0)).slot, 'morning')
  assert.equal(deriveMoodContext(bj(2026, 11, 18, 11, 59)).slot, 'morning')
  assert.equal(deriveMoodContext(bj(2026, 11, 18, 12, 0)).slot, 'noon')
  assert.equal(deriveMoodContext(bj(2026, 11, 18, 13, 59)).slot, 'noon')
  assert.equal(deriveMoodContext(bj(2026, 11, 18, 14, 0)).slot, 'afternoon')
  assert.equal(deriveMoodContext(bj(2026, 11, 18, 17, 59)).slot, 'afternoon')
  assert.equal(deriveMoodContext(bj(2026, 11, 18, 18, 0)).slot, 'evening')
  assert.equal(deriveMoodContext(bj(2026, 11, 18, 22, 59)).slot, 'evening')
  assert.equal(deriveMoodContext(bj(2026, 11, 18, 23, 0)).slot, 'late_night')
  assert.equal(deriveMoodContext(bj(2026, 11, 19, 5, 59)).slot, 'late_night')

  // 2026-11-21 周六、2026-11-22 周日（跨零点测试）
  assert.equal(deriveMoodContext(bj(2026, 11, 21, 0, 0)).slot, 'weekend')
  assert.equal(deriveMoodContext(bj(2026, 11, 22, 23, 59)).slot, 'weekend')
  assert.equal(deriveMoodContext(bj(2026, 11, 23, 0, 0)).slot, 'late_night')

  // 近期连续跳过无挑中 ⇒ 挑剔提示；连中 ⇒ 正向手感
  const picky = deriveMoodContext(bj(2026, 11, 18, 12, 30), { recentSkips: 6, recentPicks: 0 })
  assert.equal(picky.slot, 'noon')
  assert.match(picky.moodHint, /挑剔|水视频|宁缺毋滥/)

  const hot = deriveMoodContext(bj(2026, 11, 18, 20, 0), { streakPicks: 3 })
  assert.equal(hot.slot, 'evening')
  assert.match(hot.moodHint, /手感|合胃口/)
})

test('loadNovaMemoryHints：缺失目录静默返回空，正确过滤归档/损坏文件并按时间与重要度排序', () => {
  assert.deepEqual(loadNovaMemoryHints(join(root, 'no-such-dsh')), [])

  const dshHome = makeTempDir('nova-dsh-')
  const factsDir = join(dshHome, 'storages', 'nova_memory', 'facts')
  mkdirSync(join(factsDir, 'subdir'), { recursive: true })

  writeFileSync(join(factsDir, '.hidden.json'), JSON.stringify({
    kind: 'preference', title: '隐藏文件', content: '不应被读取',
  }))
  writeFileSync(join(factsDir, 'corrupt.json'), '{bad json')
  writeFileSync(join(factsDir, 'archived.json'), JSON.stringify({
    kind: 'preference', title: '旧偏好', content: '已归档', archived: true, updatedAt: '2026-11-18T10:00:00Z',
  }))
  writeFileSync(join(factsDir, 'low_fact.json'), JSON.stringify({
    kind: 'fact', importance: 1, title: '普通事实', content: 'B站视频', updatedAt: '2026-11-18T10:00:00Z',
  }))
  writeFileSync(join(factsDir, 'irrelevant_high.json'), JSON.stringify({
    kind: 'fact', importance: 3, title: '天气', content: '今天下雨', updatedAt: '2026-11-18T10:00:00Z',
  }))
  writeFileSync(join(factsDir, 'pref_old.json'), JSON.stringify({
    kind: 'preference', importance: 1, title: '技术口味', content: '偏爱底层源码分析', updatedAt: '2026-11-01T10:00:00Z',
  }))
  writeFileSync(join(factsDir, 'person_new.json'), JSON.stringify({
    kind: 'person', importance: 2, title: '称呼偏好', content: '叫他老张即可', updatedAt: '2026-11-18T08:00:00Z',
  }))
  writeFileSync(join(factsDir, 'bili_high.json'), JSON.stringify({
    kind: 'note', importance: 2, title: 'B站习惯', content: '周末喜欢看长视频测评', updatedAt: '2026-11-17T08:00:00Z',
  }))

  const hints = loadNovaMemoryHints(dshHome, 2)
  assert.equal(hints.length, 2)
  assert.equal(hints[0], '- 称呼偏好: 叫他老张即可')
  assert.equal(hints[1], '- B站习惯: 周末喜欢看长视频测评')

  const allHints = loadNovaMemoryHints(dshHome, 6)
  assert.equal(allHints.length, 3)
  assert.equal(allHints[2], '- 技术口味: 偏爱底层源码分析')
})

test('compileDutyPersona 与 compileDmPersona：支持预设切换、custom 覆盖、路径人设、严格度与近期记忆注入', () => {
  const dir = makeTempDir('compile-')
  const personaFile = join(dir, 'owner.md')
  writeFileSync(personaFile, '叫我老板，少用感叹号，优先关注硬件极客内容', 'utf8')

  const dutyGeek = compileDutyPersona(
    {
      personaPreset: 'chill_geek',
      personaPrompt: personaFile,
      antiAiStrictness: 'strict',
      aiSelfMock: false,
    },
    {
      now: new Date(Date.UTC(2026, 10, 18, 12, 0)), // 20:00 BJ
      recentComments: ['这期拆主板供电讲得真细', '代码里那个锁确实容易踩坑'],
      recentDms: ['昨晚推的那个芯片视频还行'],
      moodStats: { recentSkips: 6, recentPicks: 0 },
      memoryContext: '尽量避开（已屏蔽）：UP：标题党老王',
      novaHints: ['- 硬件偏爱: 喜欢嵌入式与电源拆解'],
    },
  )

  assert.match(dutyGeek, /摸鱼技术宅/)
  assert.match(dutyGeek, /叫我老板，少用感叹号/)
  assert.match(dutyGeek, /strict/)
  assert.match(dutyGeek, /AI 自嘲梗关闭/)
  assert.match(dutyGeek, /这期拆主板供电讲得真细/)
  assert.match(dutyGeek, /昨晚推的那个芯片视频还行/)
  assert.match(dutyGeek, /标题党老王/)
  assert.match(dutyGeek, /喜欢嵌入式与电源拆解/)
  assert.match(dutyGeek, /挑剔|水视频/)

  // custom 且存在主人文本时，不强加预设腔调，但保留去 AI 纪律
  const dutyCustom = compileDutyPersona(
    {
      personaPreset: 'custom',
      personaPrompt: personaFile,
      antiAiStrictness: 'balanced',
      aiSelfMock: true,
    },
    { now: new Date(Date.UTC(2026, 10, 18, 5, 0)) },
  )
  assert.doesNotMatch(dutyCustom, /基础说话人设：/)
  assert.match(dutyCustom, /叫我老板/)
  assert.match(dutyCustom, /AI 自嘲梗开关：允许极克制地偶发/)

  // DM 编译也必须能解析路径型 personaPrompt，并注入今日推荐与纯文本规则
  const dmPrompt = compileDmPersona(
    {
      personaPreset: 'curious_night',
      personaPrompt: personaFile,
      antiAiStrictness: 'strict',
    },
    {
      now: new Date(Date.UTC(2026, 10, 18, 15, 30)), // 23:30 BJ late_night
      todayPicks: [
        { bvid: 'BV1abc123456', title: '手搓 RISC-V 模拟器', up: '极客阿明', reason: '单文件实现太干净了' },
      ],
      memoryContext: '待跟进话题：最近想看开源硬件',
      recentDms: ['今天那个挺有意思'],
    },
  )
  assert.match(dmPrompt, /深夜好奇党/)
  assert.match(dmPrompt, /叫我老板，少用感叹号/)
  assert.match(dmPrompt, /BV1abc123456/)
  assert.match(dmPrompt, /手搓 RISC-V 模拟器/)
  assert.match(dmPrompt, /待跟进话题：最近想看开源硬件/)
  assert.match(dmPrompt, /禁用任何 Markdown/)
})

test('extractBigrams 与 textSimilarity：确定性切分与相似度边界', () => {
  const b1 = extractBigrams('B站 Rust 异步运行时')
  assert.ok(b1.has('b'))
  assert.ok(b1.has('rust'))
  assert.ok(b1.has('异步'))
  assert.ok(b1.has('步运'))
  assert.ok(b1.has('运行'))
  assert.ok(b1.has('行时'))

  assert.equal(textSimilarity('', 'abc'), 0)
  assert.equal(textSimilarity('Rust 异步', 'rust 异步'), 1)
  const simClose = textSimilarity('手写 Rust 异步运行时', '从零手写 Rust 异步引擎')
  const simFar = textSimilarity('手写 Rust 异步运行时', '周末家常红烧肉教程')
  assert.ok(simClose > simFar && simClose >= 0.3)
  assert.equal(simFar, 0)
})

test('extractDmFeedbackSignals：正负向识别、否定词免疫与主题/跟进线索提取', () => {
  const neg = extractDmFeedbackSignals('太水了，别推这种标题党营销号，不感兴趣，以后屏蔽掉')
  assert.equal(neg.sentiment, 'negative')

  const negDislike = extractDmFeedbackSignals('这个不好看，我也不喜欢这类内容')
  assert.equal(negDislike.sentiment, 'negative')

  const pos = extractDmFeedbackSignals('这个UP可以，讲得有点东西，收藏了，多推点硬件拆解！')
  assert.equal(pos.sentiment, 'positive')
  assert.ok(pos.topics.includes('硬件拆解'))

  const req = extractDmFeedbackSignals('最近想看点开源硬件和具身智能，顺便帮我盯着 Claude Code 和 MCP 的新视频')
  assert.equal(req.sentiment, 'neutral')
  assert.ok(req.threadHint.includes('最近想看'))
  assert.ok(req.topics.includes('开源硬件'))
  assert.ok(req.topics.includes('具身智能'))
  assert.ok(req.topics.includes('Claude Code'))
  assert.ok(req.topics.includes('MCP'))

  const wafu = extractDmFeedbackSignals('多关注和风美食探店')
  assert.ok(wafu.topics.includes('和风美食探店'))
})

test('createMemoryStore：原子持久化、反馈更新、时间衰减、轮次幂等、话题闭环与容错恢复', () => {
  const stateDir = makeTempDir('mem-store-')
  const store = createMemoryStore(stateDir, { halfLifeDays: 21 })
  const day0 = new Date('2026-10-01T12:00:00.000Z')

  // 1. 初始空读取不写入磁盘也不报错
  const initial = store.loadTaste(day0)
  assert.equal(initial.version, 1)
  assert.deepEqual(initial.topics, {})
  const emptyRecall = store.recallContext({ maxChars: 500, now: day0 })
  assert.equal(emptyRecall.text, '')

  // 2. recordFeedback（like / dislike / mute_up / boost_up / note）
  store.recordFeedback({
    source: 'ui',
    action: 'like',
    bvid: 'BV1good000001',
    title: 'Rust 异步原理解析',
    up: '极客阿明',
    tags: ['Rust', '系统编程'],
    note: '讲解扎实',
    now: day0,
  })
  store.recordFeedback({
    source: 'dm',
    action: 'mute_up',
    up: '标题党老王',
    tags: ['标题党'],
    note: '纯营销号',
    now: day0,
  })
  store.recordFeedback({
    source: 'ui',
    action: 'note',
    note: '尽量少推超过一小时的录播切片',
    now: day0,
  })

  // 确保无残留 .tmp 文件
  const memFiles = readdirSync(store.memoryDir)
  assert.equal(memFiles.some((f) => f.includes('.tmp.')), false)
  assert.ok(memFiles.includes('taste_profile.json'))
  assert.ok(memFiles.includes('episodic_memory.jsonl'))
  assert.ok(memFiles.includes('feedback_events.jsonl'))

  const t0 = store.loadTaste(day0)
  assert.ok(Math.abs(t0.topics.Rust.score - 1.2) < 1e-6)
  assert.equal(t0.ups['标题党老王'].muted, true)
  assert.ok(t0.ups['标题党老王'].affinity <= -2)
  assert.deepEqual(t0.ups['极客阿明'].notes, ['讲解扎实'])
  assert.ok(t0.styleNotes.includes('尽量少推超过一小时的录播切片'))

  // 3. 指数时间衰减（21 天半衰期，且不修改磁盘原值）
  const day21 = new Date('2026-10-22T12:00:00.000Z')
  const t21 = store.loadTaste(day21)
  assert.ok(Math.abs(t21.topics.Rust.score - 0.6) < 1e-6)
  assert.equal(t21.topics.Rust.rawScore, 1.2)
  assert.equal(t21.ups['标题党老王'].muted, true)

  const day42 = new Date('2026-11-12T12:00:00.000Z')
  const t42 = store.loadTaste(day42)
  assert.ok(Math.abs(t42.topics.Rust.score - 0.3) < 1e-6)

  // boost_up 可以解除屏蔽并加好感
  store.recordFeedback({
    source: 'ui',
    action: 'boost_up',
    up: '新锐极客',
    tags: ['开源硬件'],
    now: day21,
  })
  const afterBoost = store.loadTaste(day21)
  assert.equal(afterBoost.ups['新锐极客'].muted, false)
  assert.ok(Math.abs(afterBoost.ups['新锐极客'].affinity - 1.5) < 1e-6)

  // 4. evolveFromRound 幂等性与轻度演化
  const roundDay = '2026-10-22'
  const evo1 = store.evolveFromRound({
    day: roundDay,
    picks: [{ bvid: 'BV1round00001', title: 'ESP32 开源手表', up: '极客阿明', tags: ['开源硬件'], reason: '复现完整' }],
    skips: [{ bvid: 'BV1skip000001', title: '某水视频1', up: '水王', tags: ['带货'], reason: '太水' }],
    notes: ['午休轮次节奏不错'],
    now: day21,
  })
  assert.equal(evo1.addedPicks, 1)
  assert.equal(evo1.addedSkips, 1)
  assert.equal(evo1.addedNotes, 1)

  const hwScoreAfter1 = evo1.profile.topics['开源硬件'].score
  // 0.8 (from boost_up) + 0.35 (from pick) = 1.15
  assert.ok(Math.abs(hwScoreAfter1 - 1.15) < 1e-6)

  // 同一天同一批 BV 重复执行 evolveFromRound 必须幂等
  const evo2 = store.evolveFromRound({
    day: roundDay,
    picks: [{ bvid: 'BV1round00001', title: 'ESP32 开源手表', up: '极客阿明', tags: ['开源硬件'], reason: '复现完整' }],
    skips: [{ bvid: 'BV1skip000001', title: '某水视频1', up: '水王', tags: ['带货'], reason: '太水' }],
    notes: ['午休轮次节奏不错'],
    now: day21,
  })
  assert.equal(evo2.addedPicks, 0)
  assert.equal(evo2.addedSkips, 0)
  assert.equal(evo2.addedNotes, 0)
  assert.ok(Math.abs(evo2.profile.topics['开源硬件'].score - hwScoreAfter1) < 1e-6)

  // 第二次跳过同一主题/UP（不同 BV）才会轻度降权
  const evo3 = store.evolveFromRound({
    day: roundDay,
    skips: [{ bvid: 'BV1skip000002', title: '某水视频2', up: '水王', tags: ['带货'], reason: '太水' }],
    now: day21,
  })
  assert.equal(evo3.addedSkips, 1)
  assert.ok(evo3.profile.topics['带货'].score < 0)
  assert.ok(evo3.profile.ups['水王'].affinity < 0)

  // 5. open_thread 添加与 resolveThread 完结
  store.addEpisode({
    kind: 'open_thread',
    summary: '帮我盯着具身智能开源机械臂进展',
    tags: ['具身智能', '开源硬件'],
    day: roundDay,
    now: day21,
  })
  const recalledBefore = store.recallContext({
    queryText: '具身智能',
    candidateUps: ['标题党老王', '极客阿明'],
    maxChars: 1400,
    now: day21,
  })
  assert.equal(recalledBefore.openThreads.length, 1)
  assert.ok(recalledBefore.upsMuted.some((u) => u.name === '标题党老王'))
  assert.ok(!recalledBefore.upsTop.some((u) => u.name === '标题党老王'))
  assert.match(recalledBefore.text, /尽量避开.*标题党老王/)
  assert.match(recalledBefore.text, /待跟进话题.*具身智能/)
  assert.ok(recalledBefore.text.length <= 1400)

  // 严格校验极小 maxChars 边界
  const tinyRecall = store.recallContext({ maxChars: 24, now: day21 })
  assert.ok(tinyRecall.text.length <= 24)
  assert.equal(store.recallContext({ maxChars: 0, now: day21 }).text, '')

  // 解决 open_thread 后不再出现在未完结列表中
  const resolved = store.resolveThread('具身智能')
  assert.equal(resolved.resolvedCount, 1)
  const recalledAfter = store.recallContext({ maxChars: 1400, now: day21 })
  assert.equal(recalledAfter.openThreads.length, 0)

  // 6. getSummaryStats 与 listRecentEpisodes
  const stats = store.getSummaryStats(day21)
  assert.ok(stats.counts.topics >= 3)
  assert.ok(stats.counts.mutedUps === 1)
  assert.ok(stats.topTopics.length <= 8)
  assert.ok(stats.topUps.length <= 8)
  assert.ok(stats.recentEpisodes.length <= 10)
  assert.ok(store.listRecentEpisodes(3).length === 3)

  // 7. 损坏 JSON 与损坏 JSONL 行恢复测试
  const brokenDir = makeTempDir('broken-mem-')
  const brokenStore = createMemoryStore(brokenDir)
  mkdirSync(brokenStore.memoryDir, { recursive: true })
  writeFileSync(join(brokenStore.memoryDir, 'taste_profile.json'), '{broken json!!!', 'utf8')
  writeFileSync(
    join(brokenStore.memoryDir, 'episodic_memory.jsonl'),
    `${JSON.stringify({ kind: 'pick', bvid: 'BV1ok0000001', summary: '正常行', day: '2026-11-18' })}\n{bad-line\n`,
    'utf8',
  )
  const recovered = brokenStore.loadTaste()
  assert.equal(recovered.version, 1)
  assert.deepEqual(recovered.topics, {})
  const eps = brokenStore.listRecentEpisodes(10)
  assert.equal(eps.length, 1)
  assert.equal(eps[0].bvid, 'BV1ok0000001')
  assert.ok(readFileSync(join(brokenStore.memoryDir, 'taste_profile.json'), 'utf8').includes('broken'))
})

test('边界补充：非法反馈动作、主题拉黑恢复、相似度关闭话题与 relaxed/空推荐分支', () => {
  const stateDir = makeTempDir('edge-mem-')
  const store = createMemoryStore(stateDir)
  const t0 = new Date('2026-11-18T10:00:00.000Z')

  assert.throws(() => store.recordFeedback({ action: 'invalid_action', now: t0 }), /不支持的反馈动作/)

  // 连续三次 dislike 把主题压入 mutedTopics，之后连续 like 恢复
  for (let i = 0; i < 3; i += 1) {
    store.recordFeedback({ action: 'dislike', tags: ['带货直播'], now: t0 })
  }
  let taste = store.loadTaste(t0)
  assert.ok(taste.mutedTopics.includes('带货直播'))
  const mutedRecall = store.recallContext({ maxChars: 600, now: t0 })
  assert.match(mutedRecall.text, /尽量避开.*带货直播/)

  for (let i = 0; i < 3; i += 1) {
    store.recordFeedback({ action: 'like', tags: ['带货直播'], now: t0 })
  }
  taste = store.loadTaste(t0)
  assert.equal(taste.mutedTopics.includes('带货直播'), false)

  // 相似度关闭 open_thread & 空匹配 no-op
  store.addEpisode({
    kind: 'open_thread',
    summary: '多关注本地大模型量化部署实测',
    tags: ['本地大模型'],
    now: t0,
  })
  assert.equal(store.resolveThread('').resolvedCount, 0)
  const simResolved = store.resolveThread('本地大模型量化部署')
  assert.equal(simResolved.resolvedCount, 1)

  // custom 无文本回退 + relaxed 档 + DM 无今日推荐
  const customEmpty = compileDutyPersona({ personaPreset: 'custom', antiAiStrictness: 'relaxed' }, { now: t0 })
  assert.match(customEmpty, /完全自定义/)
  assert.match(customEmpty, /relaxed/)

  const dmEmpty = compileDmPersona({ personaPreset: 'buddy' }, { now: t0, todayPicks: [] })
  assert.match(dmEmpty, /还没有挑中推给他的视频/)
})
