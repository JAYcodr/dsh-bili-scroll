// node --test test/humanize-v3-integration.test.mjs
// v3.0 宿主级集成测试：测试 index.js 对人格编译、Nova 只读提示、长期记忆 API/演化、
// MCP 白名单/样式门控、dmOwnerUid 与多条未读私信合批 + 忙锁/额度不误标已读、以及 watched 丰富字段。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dayKey } from '../lib/state.mjs'

const root = mkdtempSync(join(tmpdir(), 'bili-v3-int-'))
const realDshHome = process.env.DSH_HOME
process.env.DSH_HOME = join(root, 'import-home')
const { apply } = await import('../index.js').finally(() => {
  if (realDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = realDshHome
})

const fakeDsh = join(root, 'fake-dsh.mjs')
writeFileSync(fakeDsh, `
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const home = process.env.BILI_DUTY_HOME
const day = process.env.BILI_DUTY_RUN_DAY || '${dayKey()}'
const argsPath = join(home || process.cwd(), 'last-spawn-args.json')
writeFileSync(argsPath, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), strictness: process.env.BILI_STYLE_STRICTNESS || '' }), 'utf8')
if (process.env.FAKE_DSH_SLEEP_MS) {
  await new Promise((r) => setTimeout(r, Number(process.env.FAKE_DSH_SLEEP_MS) || 0))
}
if (home && day) {
  const report = join(home, 'out', day + '.md')
  const body = \`### BV1v3int0001
**标题**：测试拟人推荐视频
**UP**：硬件老张
**推荐理由**：讲得很实在，直接给测试数据

---
因无字幕跳过 0 条
\`
  appendFileSync(report, (existsSync(report) ? '' : '# 日报 ' + day + '\\n\\n') + body)
}
`, 'utf8')

const dmQueue = { sessions: [], msgs: [] }
globalThis.fetch = async (url) => {
  const u = String(url)
  if (u.includes('get_sessions')) {
    return new Response(JSON.stringify({ code: 0, data: { session_list: dmQueue.sessions } }))
  }
  if (u.includes('fetch_session_msgs')) {
    // B站接口按时间倒序返回 messages，fetchMsgs 会 slice().reverse()
    return new Response(JSON.stringify({ code: 0, data: { messages: dmQueue.msgs } }))
  }
  throw new Error('unexpected fetch: ' + u)
}

const disposers = []
after(() => {
  for (const d of disposers) { try { d() } catch {} }
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

function startPlugin({ cfg = {}, setupHome } = {}) {
  const home = mkdtempSync(join(root, 'home-'))
  const stateDir = join(home, 'bili-duty')
  mkdirSync(join(stateDir, 'out'), { recursive: true })
  if (typeof setupHome === 'function') setupHome(home, stateDir)
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify({
    dshBin: fakeDsh,
    dmWatch: false,
    manualCooldownMin: 0,
    ...cfg,
  }))
  let handler = null
  const registeredTools = new Map()
  apply({
    get: (k) => (k === 'dshHomePath' ? (...seg) => join(home, ...seg) : undefined),
    effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d) },
    tools: {
      register: (t) => {
        if (t?.name) registeredTools.set(t.name, t)
        return () => {}
      },
    },
    webServer: { register: (r) => { handler = r.handler; return () => {} } },
  }, {})

  const callHttp = (method, path, body) => new Promise((resolve, reject) => {
    const raw = body !== undefined ? JSON.stringify(body) : ''
    const req = {
      method,
      url: path,
      headers: {},
      on: (ev, cb) => {
        if (ev === 'data' && raw) cb(raw)
        if (ev === 'end') cb()
      },
    }
    handler(req, {
      writeHead: () => {},
      end: (s) => resolve(JSON.parse(s)),
    }).catch(reject)
  })

  return { home, stateDir, callHttp, tools: registeredTools }
}

test('v3 prompt、overlay 门控、Nova 记忆注入与跑完后记忆演化闭环', async () => {
  const { stateDir, callHttp, tools } = startPlugin({
    cfg: {
      personaPreset: 'chill_geek',
      antiAiStrictness: 'strict',
      autoLike: true,
      autoCoin: false,
      skipWatchedHistory: true,
      dmMode: 'only',
      dmUid: 998877,
    },
    setupHome: (home, sDir) => {
      const novaDir = join(home, 'storages', 'nova_memory', 'facts')
      mkdirSync(novaDir, { recursive: true })
      writeFileSync(join(novaDir, 'f1.json'), JSON.stringify({
        kind: 'preference',
        importance: 3,
        title: '偏好主题',
        content: '喜欢看 Rust 工具和极客测评，反感水评测',
        updatedAt: new Date().toISOString(),
      }))
      const today = dayKey()
      mkdirSync(join(sDir, 'picks'), { recursive: true })
      writeFileSync(join(sDir, 'picks', `${today}.jsonl`), JSON.stringify({
        bvid: 'BV1v3int0001',
        title: '测试拟人推荐视频',
        up: '硬件老张',
        tier: '值得看',
        why: '讲得很实在',
        tags: ['Rust', '测评'],
      }) + '\n')
      writeFileSync(join(sDir, 'seen.md'), [
        '| 日期 | BV号 | 标题 | UP主 | 状态 |',
        '|---|---|---|---|---|',
        `| ${today} | BV1v3int0001 | 测试拟人推荐视频 | 硬件老张 | 挑了（值得看） |`,
        `| ${today} | BV1skip00002 | 标题党水片 | 营销号 | 跳过（无字幕） |`,
      ].join('\n'))
    },
  })

  // dmMode=only 时公开评论工具必须硬拦截
  const replyTool = tools.get('bili_reply')
  assert.ok(replyTool)
  const blocked = await replyTool.execute({ bvid: 'BV1v3int0001', text: 'test' }, {})
  assert.equal(blocked.blocked, true)

  const before = existsSync(join(stateDir, 'duty.log'))
    ? readFileSync(join(stateDir, 'duty.log'), 'utf8').split('刷B站结束（').length - 1
    : 0
  const runRes = await callHttp('POST', '/api/bili-duty/run')
  assert.equal(runRes.started, true)

  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const cnt = existsSync(join(stateDir, 'duty.log'))
      ? readFileSync(join(stateDir, 'duty.log'), 'utf8').split('刷B站结束（').length - 1
      : 0
    if (cnt > before && existsSync(join(stateDir, 'last-spawn-args.json'))) break
    await new Promise((r) => setTimeout(r, 25))
  }

  const spawnDump = JSON.parse(readFileSync(join(stateDir, 'last-spawn-args.json'), 'utf8'))
  const promptArg = spawnDump.argv[spawnDump.argv.length - 1]
  assert.match(promptArg, /摸鱼技术宅/)
  assert.match(promptArg, /偏好主题.*Rust 工具/)
  assert.match(promptArg, /bili_history/)
  assert.match(promptArg, /duty_pick_record/)

  const overlay = readFileSync(join(stateDir, 'headless-overlay.yml'), 'utf8')
  assert.match(overlay, /bili_like/)
  assert.doesNotMatch(overlay, /bili_coin/)
  assert.doesNotMatch(overlay, /bili_reply/)
  assert.match(overlay, /BILI_STYLE_STRICTNESS: 'strict'/)

  // 确认 runDuty exit 触发了记忆演化
  const memRes = await callHttp('GET', '/api/bili-duty/memory')
  assert.equal(memRes.ok, true)
  assert.ok(memRes.summary.topUps.some((u) => u.name === '硬件老张'))
  assert.ok(memRes.summary.topTopics.some((t) => t.name === 'Rust'))
})

test('UI 反馈闭环、话题消解与 /watched UP 好感度合并', async () => {
  const { stateDir, callHttp } = startPlugin()
  const today = dayKey()
  writeFileSync(join(stateDir, 'seen.md'), [
    '| 日期 | BV号 | 标题 | UP主 | 状态 |',
    '|---|---|---|---|---|',
    `| ${today} | BV1updemo001 | 示例长视频 | 测试UP甲 | 挑了（值得看） |`,
  ].join('\n'))
  mkdirSync(join(stateDir, 'picks'), { recursive: true })
  writeFileSync(join(stateDir, 'picks', `${today}.jsonl`), JSON.stringify({
    bvid: 'BV1updemo001',
    title: '示例长视频',
    up: '测试UP甲',
    tier: '值得看',
    why: '干货',
    tags: ['开源', 'Linux'],
  }) + '\n')

  const noteRes = await callHttp('POST', '/api/bili-duty/memory/note', {
    kind: 'open_thread',
    summary: '继续追踪 Rust 异步生态后续测评',
    tags: ['Rust'],
  })
  assert.equal(noteRes.ok, true)

  const muteRes = await callHttp('POST', '/api/bili-duty/feedback', {
    action: 'mute_up',
    bvid: 'BV1updemo001',
    title: '示例长视频',
    up: '测试UP甲',
    tags: ['水测评'],
  })
  assert.equal(muteRes.ok, true)
  assert.ok(muteRes.summary.mutedUps.some((u) => u.name === '测试UP甲'))

  const watchedMuted = await callHttp('GET', '/api/bili-duty/watched')
  const rowMuted = watchedMuted.rows.find((r) => r.bvid === 'BV1updemo001')
  assert.equal(rowMuted.upMuted, true)
  assert.deepEqual(rowMuted.tags, ['开源', 'Linux'])

  const unmuteRes = await callHttp('POST', '/api/bili-duty/feedback', {
    action: 'unmute_up',
    up: '测试UP甲',
  })
  assert.equal(unmuteRes.ok, true)
  assert.equal(unmuteRes.summary.mutedUps.some((u) => u.name === '测试UP甲'), false)

  const resolveRes = await callHttp('POST', '/api/bili-duty/memory/resolve-thread', {
    matchText: 'Rust 异步生态',
  })
  assert.equal(resolveRes.ok, true)
  assert.equal(resolveRes.resolvedCount, 1)

  const st = await callHttp('GET', '/api/bili-duty/status')
  assert.ok(st.memorySummary)
  assert.ok(st.rhythm)
})

test('dmOwnerUid 优先认 dmOwnerUid，多条连续私信合批且写入记忆，额度满时不误标已读', async () => {
  // 1) 额度用尽时，不标 seen、不推进游标
  const capped = startPlugin({
    cfg: {
      dmWatch: true,
      dmOwnerUid: 777001,
      dmUid: 888002,
      dmReplyPerDay: 1,
    },
    setupHome: (_h, sDir) => {
      writeFileSync(join(sDir, 'bili_credential.json'), JSON.stringify({
        sessdata: 's', bili_jct: 'j', buvid3: 'b', dedeuserid: '666003',
      }))
      writeFileSync(join(sDir, 'dm-seen.json'), JSON.stringify({ '777001': { key: 'k0', ts: 100 } }))
      writeFileSync(join(sDir, 'dm-quota.json'), JSON.stringify({ day: dayKey(), n: 1 }))
    },
  })
  dmQueue.sessions = [{ talker_id: 777001, unread_count: 1, last_msg: { timestamp: 200 } }]
  dmQueue.msgs = [
    { msg_key: 'k1', timestamp: 200, sender_uid: 777001, msg_type: 1, content: JSON.stringify({ content: '超额测试消息' }) },
    { msg_key: 'k0', timestamp: 100, sender_uid: 777001, msg_type: 1, content: JSON.stringify({ content: '旧消息' }) },
  ]
  const stCapped = await capped.callHttp('GET', '/api/bili-duty/status')
  assert.equal(stCapped.ownerInfo.uid, 777001)
  await capped.callHttp('POST', '/api/bili-duty/dm-check')
  assert.equal(JSON.parse(readFileSync(join(capped.stateDir, 'dm-seen.json'), 'utf8'))['777001'].key, 'k0')

  // 2) dsh 可用且有额度时：连续两条未读私信合批送入 dmPromptFor，并触发正向偏好记忆
  const okHost = startPlugin({
    cfg: {
      dmWatch: true,
      dmOwnerUid: 777001,
      dmUid: 888002,
      dmReplyPerDay: 5,
      personaPreset: 'buddy',
    },
    setupHome: (_h, sDir) => {
      writeFileSync(join(sDir, 'bili_credential.json'), JSON.stringify({
        sessdata: 's', bili_jct: 'j', buvid3: 'b', dedeuserid: '666003',
      }))
      writeFileSync(join(sDir, 'dm-seen.json'), JSON.stringify({ '777001': 'k0' }))
    },
  })
  dmQueue.sessions = [{ talker_id: 777001, unread_count: 2, last_msg: { timestamp: 300 } }]
  dmQueue.msgs = [
    { msg_key: 'k2', timestamp: 300, sender_uid: 777001, msg_type: 1, content: JSON.stringify({ content: '以后多推点这种硬件手工' }) },
    { msg_key: 'k1', timestamp: 200, sender_uid: 777001, msg_type: 1, content: JSON.stringify({ content: '刚才那条真不错 BV1v3int0001' }) },
    { msg_key: 'k0', timestamp: 100, sender_uid: 777001, msg_type: 1, content: JSON.stringify({ content: '旧消息' }) },
  ]
  await okHost.callHttp('POST', '/api/bili-duty/dm-check')

  const deadline = Date.now() + 15_000
  while (Date.now() < deadline && !existsSync(join(okHost.stateDir, 'last-spawn-args.json'))) {
    await new Promise((r) => setTimeout(r, 25))
  }
  const dump = JSON.parse(readFileSync(join(okHost.stateDir, 'last-spawn-args.json'), 'utf8'))
  const dmPrompt = dump.argv[dump.argv.length - 1]
  assert.match(dmPrompt, /刚才那条真不错/)
  assert.match(dmPrompt, /以后多推点这种硬件手工/)
  assert.equal(JSON.parse(readFileSync(join(okHost.stateDir, 'dm-seen.json'), 'utf8'))['777001'].key, 'k2')

  const memAfterDm = await okHost.callHttp('GET', '/api/bili-duty/memory')
  assert.ok(memAfterDm.episodes.some((e) => /feedback/.test(e.kind) && /硬件手工|BV1v3int0001/.test(e.summary)))
})

test('client.js Panel 与 WatchTab 在假 React 下可完整渲染不抛错', async () => {
  const registeredSlots = []
  let activeOverrides = {}
  let invokeEffects = false
  const effectCleanups = []
  const makeStubReact = () => ({
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    Fragment: Symbol('Fragment'),
    useState: (init) => {
      const val = typeof init === 'function' ? init() : init
      const key = val === null ? '__null__' : JSON.stringify(val)
      if (Array.isArray(activeOverrides[key]) && activeOverrides[key].length) {
        return [activeOverrides[key].shift(), () => {}]
      }
      return [val, () => {}]
    },
    useEffect: (fn) => {
      if (invokeEffects && typeof fn === 'function') {
        const clean = fn()
        if (typeof clean === 'function') effectCleanups.push(clean)
      }
    },
    useRef: (v) => ({ current: v }),
  })
  const renderEl = (node) => {
    if (!node || typeof node !== 'object') return node
    if (Array.isArray(node)) return node.map(renderEl)
    if (typeof node.type === 'function') return renderEl(node.type({ ...node.props, children: node.children }))
    return { ...node, children: (node.children || []).map(renderEl) }
  }

  globalThis.window = {
    __ModuleLoader__: {
      load: ({ factory }) => {
        const fakeReact = makeStubReact()
        const mod = factory((id) => (id === 'react' ? fakeReact : {}))
        const fakeCtx = {
          effect: () => {},
          slots: {
            inject: (_name, fn) => { if (typeof fn === 'function') fn() },
            register: (opts, comp) => { registeredSlots.push({ spec: opts, comp }); return () => {} },
          },
        }
        mod.apply(fakeCtx)
      },
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  globalThis.document = {
    head: { appendChild: () => {} },
    createElement: () => ({ setAttribute: () => {}, remove: () => {}, textContent: '' }),
    hidden: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  globalThis.sessionStorage = { getItem: () => '{}', setItem: () => {} }

  try {
    await import('../client.js?smoke=' + Date.now())
    const settingsSlot = registeredSlots.find((s) => s.spec?.id === 'bili-scroll')
    const scopeSlot = registeredSlots.find((s) => s.spec?.id === 'bili-scope')
    assert.ok(settingsSlot)
    assert.ok(scopeSlot)

    // 1) 初始加载态（cfg 未就绪）
    assert.ok(settingsSlot.comp())

    // 2) 配置已加载态（渲染全部 5 个页签及 memory/watched 子树）
    activeOverrides = {
      __null__: [
        {
          home: '/tmp/bili-duty',
          report: '/tmp/bili-duty/out/2026-11-18.md',
          config: {
            perDay: 5,
            peakValley: true,
            noon: true,
            night: true,
            jitterEnabled: true,
            windowJitterMaxMin: 45,
            splitDailyRounds: true,
            roundMaxPicks: 3,
            personaPreset: 'buddy',
            antiAiStrictness: 'balanced',
            browseMix: 'auto',
            skipWatchedHistory: true,
            autoLike: true,
            autoWatchLater: true,
            autoCoin: true,
            autoComment: true,
            dmMode: 'both',
            dmWatch: true,
            memoryEnabled: true,
            syncNovaMemory: true,
          },
          windows: { noon: { label: '中午', start: '12:00', end: '14:00' }, night: { label: '夜间', start: '18:00', end: '09:00' } },
          rhythm: { nextNoon: 745, nextNight: 1120 },
          memorySummary: { counts: { topics: 1, ups: 1, mutedUps: 0, openThreads: 1, episodes: 1 } },
          model: { provider: 'deepseek-account', model: 'deepseek-chat', source: 'session' },
        },
        '关键词',
        [{ id: 1, title: '默认收藏夹', count: 3 }],
        '1',
        [],
        [],
        '自定义人设',
        '营销号',
        'medium',
        'pubdate',
        'full',
        '',
        '5',
        '1',
        '1',
        '12345',
        true,
        'both',
        '测试用户',
        '',
        '',
        null,
        null,
        [], // watchedRows
        null, // diag
        null, // checks
        'buddy',
        'balanced',
        'auto',
        'friend',
        'friend',
        '1',
        '45',
        '3',
        '65',
        '2',
        '2',
        '1',
        {
          summary: {
            counts: { topics: 1, ups: 1, mutedUps: 1, openThreads: 1, episodes: 1 },
            topTopics: [{ name: 'Rust', score: 2.5 }],
            topUps: [{ name: '硬件老张', affinity: 1.8 }],
            mutedUps: [{ name: '标题党', affinity: -2 }],
            openThreads: [{ id: 't1', day: '2026-11-18', summary: 'Rust 异步' }],
          },
          episodes: [{ id: 'e1', day: '2026-11-18', kind: 'pick', up: '硬件老张', summary: '好视频' }],
        },
      ],
    }
    assert.ok(renderEl(settingsSlot.comp()))

    // 3) 触发 ScopeProbe 挂载（无 sessionId 回退显示 WatchTab），再渲染 WatchTab
    invokeEffects = true
    const probeTree = renderEl(scopeSlot.comp({ sessionId: '' }))
    assert.ok(probeTree)
    invokeEffects = false
    const watchSlot = registeredSlots.find((s) => s.spec?.id === 'bili-watched')
    assert.ok(watchSlot)
    assert.ok(renderEl(watchSlot.comp()))
  } finally {
    for (const c of effectCleanups) { try { c() } catch {} }
    delete globalThis.window
    delete globalThis.document
    delete globalThis.sessionStorage
  }
})

