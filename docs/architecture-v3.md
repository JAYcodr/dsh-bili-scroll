# dsh-bili-scroll v3.0 拟人化完整重构架构契约

> 本文档作为各模块实现与多 Agent 协作的单一事实来源（Single Source of Truth）。

## 1. 四大核心支柱与模块划分

1. **语言与人设 (`lib/persona.mjs`)**
   - 内置四档人设预设：`buddy`（损友/熟人，默认）、`chill_geek`（摸鱼技术宅）、`curious_night`（深夜好奇党）、`custom`（完全遵从用户自定义文本/AGENTS.md）。
   - 统一 `resolveOwnerPersonaText(cfg)`：修复此前 `dmPromptFor` 不解析单行文件路径的缺陷，同时兼容 Windows/POSIX `~/` 路径、目录自动读 `AGENTS.md`，并在 40,000 字符处安全截断。
   - 时段情绪感知 `deriveMoodContext(now, stats)`：按北京时间时段（午休摸鱼、晚间放松、深夜安静、周末闲逛）与本轮/近期命中率生成自然语气微调。
   - 可选只读读取 `$DSH_HOME/storages/nova_memory/facts/` 中 `kind` 为 `preference`/`person` 的条目标题与正文（零强耦合，目录不存在时静默跳过）。

2. **长期记忆与偏好演化 (`lib/memory.mjs`)**
   - 持久化目录：`$DSH_HOME/bili-duty/memory/`（全部使用临时文件 + `renameSync` 原子写）：
     - `taste_profile.json`：主题/关键词兴趣权重（含指数时间衰减，默认半衰期 21 天）、UP 主好感度与屏蔽状态（`affinity` / `muted` / `notes`）、时长偏好、风格备注。
     - `episodic_memory.jsonl`：推荐/跳过事件、用户私信或面板反馈、待跟进话题（`openThreads`）。
     - `feedback_events.jsonl`：来自 UI 卡片墙（喜欢/太水/屏蔽UP/加好感）、私信反馈、评论复核的反馈事件流水。
   - `recallContext(...)`：按当前候选主题、UP 主与近期交互召回高相关记忆，格式化为紧凑文本块注入轮次与私信提示词（受 `memoryMaxInjectChars` 限制）。
   - `evolveFromRound(...)` & `extractDmFeedbackSignals(text)`：零额外 LLM 开销自动完成每轮偏好演化与私信轻量偏好提取。

3. **浏览与互动节律 (`lib/rhythm.mjs`)**
   - `planWindowWakeup(now, windowKey, win, state, cfg)`：窗口内随机抖动唤醒（默认 0~45 分钟，且严格保底在窗口结束前留出至少 20 分钟余量），目标时间持久化进 `state.json.windowSchedule`，重启不丢、不重复触发。
   - `buildBrowsePlan(cfg, tasteProfile, state, now)`：
     - 混合发现策略：首页推荐流 + 轮换关键词 + 高好感 UP 回访 + 动态流/相关推荐“顺藤摸瓜”。
     - 自动分批刷（`splitDailyRounds` + `roundMaxPicks`）：把每日配额自然拆散，避免一口气刷完。
     - 克制互动预算：结合 `autoLike` / `autoWatchLater` / `autoCoin` / `autoComment` 与 `commentChance`（默认 65%）决定本轮互动额度，避免机械逢视频必评。

4. **朋友式日报与私信投递 (`lib/delivery.mjs`)**
   - 兼容老格式（`### BV...`）与新朋友口吻格式（`### [标题](https://www.bilibili.com/video/BV...)` + `<!-- bili-pick: BV... | tier=... | up=... -->`），并与 `picks/YYYY-MM-DD.jsonl` 结构化边车合并，确保配额统计、卡片墙元数据与自动收藏 100% 准确。
   - `sanitizeDmText`：剔除 B 站私信不渲染的 Markdown 语法（`**加粗**`、`### 标题`、`[字](url)`），统一 `@ 昵称` → `@昵称`。
   - `splitDmMessages`：按段落/条目边界安全切分 ≤460 字短消息，避免触发 B 站 `code 21007`（500 字上限）。
   - `dm-history.jsonl`：记录近期发出/收到的私信摘要与开场白，防止连续几天用同一句套话开场。

5. **Python MCP 与去 AI 味闸门 (`vendor/bilibili-mcp/style_guard.py`, `duty_store.py`, `mcp_server.py`)**
   - `style_guard.py`：纯标准库实现；升级开头八股/连接词/客服尾/Markdown 泄漏检测、自身历史评论句式/结构去重、热评撞车检测。
   - `duty_store.py`：纯标准库实现；严格限定在 `DUTY_HOME` 内的窄口读写：`pick_record`、`report_today`、`digest_search`、`memory_recall`、`memory_note`。
   - `mcp_server.py`：
     - `_human_pause(kind)`：对数正态/抖动停顿，覆盖全部读接口。
     - 新增只读工具：`bili_related_videos`、`bili_dynamic_feed`、`bili_history`。
     - 新增受白名单与配置双闸保护的轻量互动工具：`bili_like`、`bili_watch_later_add`、`bili_coin`。
     - 新增窄口记忆/归档读取工具：`duty_pick_record`、`duty_report_today`、`duty_digest_search`、`duty_memory_recall`、`duty_memory_note`。
     - 保持 `tools/check-mention.py` 与 `tools/check-vision.py` 所有内部导出符号兼容。

## 2. 宿主同步与缺陷修复清单 (`index.js` & `lib/`)

- 修复 `dmOwnerUid()` 忽略 `cfg.dmOwnerUid` 的问题。
- 修复修改 `dmWatchMinutes` 后 `dmTimer` 不热重启的问题；修复 `dmTick()` 连续多条未读消息只取最后一条、且在 `dmReplyRunning` 时丢消息的问题。
- 修复 `DEFAULTS.headlessProfile`（统一为 `'bili-duty'`）与 `clampPatch` 对 `dmMode` / `dmUid` / 新增字段的校验。
- 修复 `syncNotes` 的 `notesSig` 局部重置问题。
- `bili_reply` DSH 工具补全 `root` 参数；`bili_search` 补全 `page` 参数。
- `mcpWhitelist()` 按配置放行 `bili_received_replies`、`bili_received_at_and_likes`、`bili_user_info`、`bili_user_videos`、`bili_related_videos`、`bili_dynamic_feed`、`bili_history`、`duty_*` 新工具，以及受控的 `bili_like` / `bili_watch_later_add` / `bili_coin`。
- `lib/state.mjs` 的 `ensureHomeFiles` 同步复制 `style_guard.py` 与 `duty_store.py` 至 `stateDir`。
