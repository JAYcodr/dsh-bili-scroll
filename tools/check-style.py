#!/usr/bin/env python3
"""Offline unittest suite for style_guard, duty_store, and mcp_server (v3.0).

Runnable directly with plain ``python3 tools/check-style.py`` without
requiring ``mcp`` or ``bilibili_api`` installed locally.
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
MCP_DIR = ROOT / "vendor" / "bilibili-mcp"
if str(MCP_DIR) not in sys.path:
    sys.path.insert(0, str(MCP_DIR))

import duty_store  # noqa: E402
import style_guard  # noqa: E402


def _build_stub_modules() -> dict[str, types.ModuleType]:
    """Create minimal stub modules so mcp_server.py can import offline."""
    stubs: dict[str, types.ModuleType] = {}

    class _FakeFastMCP:
        def __init__(self, name: str) -> None:
            self.name = name
            self.registered: dict[str, object] = {}

        def tool(self):
            def deco(fn):
                self.registered[fn.__name__] = fn
                return fn

            return deco

        def run(self, transport: str = "stdio") -> None:
            return None

    class _FakeContent:
        def __init__(self, **kwargs) -> None:
            for key, value in kwargs.items():
                setattr(self, key, value)

    mcp_mod = types.ModuleType("mcp")
    mcp_server_mod = types.ModuleType("mcp.server")
    mcp_fastmcp_mod = types.ModuleType("mcp.server.fastmcp")
    mcp_fastmcp_mod.FastMCP = _FakeFastMCP
    mcp_types_mod = types.ModuleType("mcp.types")
    mcp_types_mod.ImageContent = _FakeContent
    mcp_types_mod.TextContent = _FakeContent

    stubs["mcp"] = mcp_mod
    stubs["mcp.server"] = mcp_server_mod
    stubs["mcp.server.fastmcp"] = mcp_fastmcp_mod
    stubs["mcp.types"] = mcp_types_mod

    bili_mod = types.ModuleType("bilibili_api")

    class _FakeCredential:
        def __init__(self, sessdata="", bili_jct="", buvid3="", dedeuserid="") -> None:
            self.sessdata = sessdata
            self.bili_jct = bili_jct
            self.buvid3 = buvid3
            self.dedeuserid = dedeuserid

    class _FakeVideo:
        def __init__(self, bvid: str = "", credential=None) -> None:
            self.bvid = bvid
            self.credential = credential

        async def get_info(self) -> dict:
            return {"aid": 123456, "bvid": self.bvid, "title": "stub"}

        async def get_related(self) -> list:
            return []

        async def like(self, status: bool = True) -> dict:
            return {"status": status}

        async def pay_coin(self, num: int = 1) -> dict:
            return {"num": num}

    video_mod = types.ModuleType("bilibili_api.video")
    video_mod.Video = _FakeVideo

    search_mod = types.ModuleType("bilibili_api.search")
    search_mod.OrderVideo = types.SimpleNamespace(
        TOTALRANK="totalrank", CLICK="click", PUBDATE="pubdate", DM="dm"
    )
    search_mod.SearchObjectType = types.SimpleNamespace(VIDEO="video")

    comment_mod = types.ModuleType("bilibili_api.comment")
    comment_mod.CommentResourceType = types.SimpleNamespace(VIDEO=1)
    comment_mod.OrderType = types.SimpleNamespace(LIKE=2, TIME=0)

    dynamic_mod = types.ModuleType("bilibili_api.dynamic")
    dynamic_mod.DynamicType = types.SimpleNamespace(VIDEO="VIDEO")

    async def _stub_dynamic_page_info(credential=None, offset: str = "", _type=None):
        return {"items": [], "offset": "", "has_more": False}

    dynamic_mod.get_dynamic_page_info = _stub_dynamic_page_info

    hot_mod = types.ModuleType("bilibili_api.hot")
    rank_mod = types.ModuleType("bilibili_api.rank")
    rank_mod.RankType = types.SimpleNamespace(
        All=1, Original=2, Rookie=3, Douga=4, Music=5, Dance=6, Game=7,
        Knowledge=8, Technology=9, Sports=10, Car=11, Life=12, Food=13,
        Animal=14, Fashion=15, Ent=16, Cinephile=17,
    )
    rank_mod.RankDayType = types.SimpleNamespace(THREE_DAY=3, WEEK=7)

    user_mod = types.ModuleType("bilibili_api.user")
    user_mod.VideoOrder = types.SimpleNamespace(PUBDATE="pubdate", VIEW="click", FAVORITE="stow")
    user_mod.HistoryType = types.SimpleNamespace(ARCHIVE="archive")

    async def _stub_get_self_history(page_num: int = 1, per_page_item: int = 20, _type=None, credential=None):
        return []

    async def _stub_set_watch_later(aid: int = 0, bvid: str = "", add: bool = True, credential=None):
        return {"code": 0}

    user_mod.get_self_history = _stub_get_self_history
    user_mod.set_watch_later = _stub_set_watch_later

    session_mod = types.ModuleType("bilibili_api.session")
    session_mod.EventType = types.SimpleNamespace(TEXT=1)

    fav_mod = types.ModuleType("bilibili_api.favorite_list")
    homepage_mod = types.ModuleType("bilibili_api.homepage")
    uploader_mod = types.ModuleType("bilibili_api.video_uploader")
    uploader_mod.VideoUploader = object
    uploader_mod.VideoUploaderPage = object
    uploader_mod.VideoMeta = object
    uploader_mod.Lines = object
    opus_mod = types.ModuleType("bilibili_api.opus")
    utils_mod = types.ModuleType("bilibili_api.utils")
    picture_mod = types.ModuleType("bilibili_api.utils.picture")
    picture_mod.Picture = object
    login_mod = types.ModuleType("bilibili_api.login_v2")
    login_mod.QrCodeLogin = object
    login_mod.QrCodeLoginEvents = types.SimpleNamespace(SCAN=1, CONF=2, TIMEOUT=3, DONE=4)

    bili_mod.Credential = _FakeCredential
    bili_mod.video = video_mod
    bili_mod.search = search_mod
    bili_mod.comment = comment_mod
    bili_mod.dynamic = dynamic_mod
    bili_mod.opus = opus_mod
    bili_mod.hot = hot_mod
    bili_mod.rank = rank_mod
    bili_mod.user = user_mod
    bili_mod.session = session_mod
    bili_mod.favorite_list = fav_mod
    bili_mod.homepage = homepage_mod

    stubs.update({
        "bilibili_api": bili_mod,
        "bilibili_api.video": video_mod,
        "bilibili_api.search": search_mod,
        "bilibili_api.comment": comment_mod,
        "bilibili_api.dynamic": dynamic_mod,
        "bilibili_api.opus": opus_mod,
        "bilibili_api.hot": hot_mod,
        "bilibili_api.rank": rank_mod,
        "bilibili_api.user": user_mod,
        "bilibili_api.session": session_mod,
        "bilibili_api.favorite_list": fav_mod,
        "bilibili_api.homepage": homepage_mod,
        "bilibili_api.video_uploader": uploader_mod,
        "bilibili_api.utils": utils_mod,
        "bilibili_api.utils.picture": picture_mod,
        "bilibili_api.login_v2": login_mod,
    })
    return stubs


def _load_mcp_server_offline(allowed_tools: str = ""):
    stubs = _build_stub_modules()
    module_name = f"_mcp_server_test_{abs(hash(allowed_tools))}"
    spec = importlib.util.spec_from_file_location(module_name, MCP_DIR / "mcp_server.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    env_patch = {"BILI_MCP_TOOLS": allowed_tools} if allowed_tools else {}
    saved_allowed = os.environ.get("BILI_MCP_TOOLS")
    try:
        if allowed_tools:
            os.environ["BILI_MCP_TOOLS"] = allowed_tools
        else:
            os.environ.pop("BILI_MCP_TOOLS", None)
        with mock.patch.dict(sys.modules, stubs):
            spec.loader.exec_module(module)
    finally:
        if saved_allowed is None:
            os.environ.pop("BILI_MCP_TOOLS", None)
        else:
            os.environ["BILI_MCP_TOOLS"] = saved_allowed
    return module, env_patch


class TestStyleGuard(unittest.TestCase):
    """Tests for style_guard.py."""

    def test_normalize_mention_cases(self) -> None:
        cases = [
            ("@ No3799 这条不错", "@No3799 这条不错"),
            ("@   No3799 多个空格", "@No3799 多个空格"),
            ("@\tNo3799 制表符", "@No3799 制表符"),
            ("@\nNo3799 换行", "@No3799 换行"),
            ("@No3799 已经紧贴", "@No3799 已经紧贴"),
            ("这条没有 @ 符号", "这条没有 @符号"),
            ("", ""),
            (None, ""),
            ("邮箱 a@b.com 不该被拆", "邮箱 a@b.com 不该被拆"),
            ("@   ", "@"),
        ]
        for src, expected in cases:
            with self.subTest(src=src):
                self.assertEqual(style_guard.normalize_mention(src), expected)

    def test_sanitize_plain_text(self) -> None:
        raw = (
            "### 今日精选\r\n"
            "看看 [**这个拆解**](https://www.bilibili.com/video/BV1uNk1YxEJQ) 和 "
            "[https://example.com/a__b](https://example.com/a__b)\n"
            "@ No3799 这条里 `__重点__` 和 `config.json` 写得挺细。\n\n\n\n"
            "正文里提到的（共3个工具）不能误删。\n"
            "（28字，可继续发送）"
        )
        cleaned = style_guard.sanitize_plain_text(raw)
        self.assertNotIn("###", cleaned)
        self.assertNotIn("**", cleaned)
        self.assertNotIn("__重点__", cleaned)
        self.assertNotIn("`", cleaned)
        self.assertNotIn("28字", cleaned)
        self.assertNotIn("\n\n\n", cleaned)
        self.assertIn("今日精选", cleaned)
        self.assertIn("这个拆解 https://www.bilibili.com/video/BV1uNk1YxEJQ", cleaned)
        self.assertIn("https://example.com/a__b", cleaned)
        self.assertNotIn("https://example.com/a__b https://example.com/a__b", cleaned)
        self.assertIn("@No3799", cleaned)
        self.assertIn("重点", cleaned)
        self.assertIn("config.json", cleaned)
        self.assertIn("（共3个工具）", cleaned)
        self.assertEqual(style_guard.sanitize_plain_text(None), "")
        self.assertEqual(style_guard.sanitize_plain_text("  你好 (共12字) "), "你好")

    def test_bigrams_and_similarity(self) -> None:
        self.assertEqual(style_guard.bigrams(""), set())
        self.assertEqual(style_guard.bigrams("啊"), {"啊"})
        self.assertEqual(style_guard.bigrams("你好啊!"), {"你好", "好啊"})
        self.assertEqual(style_guard.bigram_similarity("今天天气真不错", "今天天气真不错"), 1.0)
        self.assertEqual(style_guard.bigram_similarity("今天天气", "完全不同"), 0.0)
        self.assertEqual(style_guard.bigram_similarity("", "今天天气"), 0.0)

    def test_detect_ai_patterns_and_strictness(self) -> None:
        cliches = [
            "这条我认，讲得挺实在",
            "值得一看的教程",
            "不得不说这一步很关键",
            "好家伙直接把主板焊死了",
            "强烈推荐新手看看",
            "感谢分享这个排查思路",
            "学到了很多新东西",
            "受教了，回去试试",
            "作为一个老用户我想说",
            "总之还是挺省心的",
            "综上可以买单风扇版",
            "宝藏UP终于更新了",
            "干货满满的一期评测",
            "本期视频主要对比了功耗",
            "视频中提到的脚本很稳",
            "这个视频主要讲散热改造",
            "@张三 感谢分享，马上去试",
        ]
        for sample in cliches:
            with self.subTest(sample=sample):
                self.assertTrue(style_guard.detect_ai_patterns(sample, strictness="balanced"))

        listicles = [
            "首先温度压下去了，其次噪声也低了不少",
            "1. 先拆背板 2. 再清理风道",
        ]
        for sample in listicles:
            self.assertTrue(style_guard.detect_ai_patterns(sample, strictness="relaxed"))
            self.assertTrue(style_guard.detect_ai_patterns(sample, strictness="balanced"))

        # Transitions & markdown: flagged in balanced/strict, ignored in relaxed.
        mid_ai = "前面那段拆解值得一提的是散热片焊得挺稳"
        self.assertEqual(style_guard.detect_ai_patterns(mid_ai, strictness="relaxed"), [])
        self.assertTrue(style_guard.detect_ai_patterns(mid_ai, strictness="balanced"))

        for tail in ("总体而言还算实用", "总而言之可以入手", "如需完整脚本请告诉我", "欢迎大家在评论区交流", "希望这个思路对你有帮助"):
            self.assertTrue(style_guard.detect_ai_patterns(tail, strictness="balanced"))

        self.assertTrue(style_guard.detect_ai_patterns("这里 **加粗** 了重点", strictness="balanced"))
        self.assertTrue(style_guard.detect_ai_patterns("### 小结\n确实稳", strictness="balanced"))
        self.assertEqual(style_guard.detect_ai_patterns("### 小结\n确实稳", strictness="relaxed"), [])

        # Strict-only checks: formal punctuation & summary phrasing.
        formal = "前面铺垫不少；后面对比温差也降了八度。"
        self.assertEqual(style_guard.detect_ai_patterns(formal, strictness="balanced"), [])
        self.assertTrue(style_guard.detect_ai_patterns(formal, strictness="strict"))

        summary = "总的来说，这套方案比原厂稳定很多"
        self.assertEqual(style_guard.detect_ai_patterns(summary, strictness="balanced"), [])
        self.assertTrue(style_guard.detect_ai_patterns(summary, strictness="strict"))

        casual = "3分20秒把铜管压扁那下我差点以为要翻车了，好在最后点亮了"
        self.assertEqual(style_guard.detect_ai_patterns(casual, strictness="strict"), [])

    def test_check_comment_style(self) -> None:
        self.assertTrue(style_guard.check_comment_style("   "))
        self.assertTrue(style_guard.check_comment_style("值得一看，讲得很清楚"))

        # Similarity >= 0.55 against own_comments[-30:].
        own = ["2分15秒调低风扇曲线后噪音小了很多", "另一条完全不相关的评论"]
        self.assertTrue(style_guard.check_comment_style("2分15秒调低风扇曲线后噪音真的小了很多", own_comments=own))

        # Older than last 30 does not block.
        padded_own = ["2分15秒调低风扇曲线后噪音小了很多"] + [f"无关评论编号{i}" for i in range(30)]
        self.assertEqual(
            style_guard.check_comment_style("2分15秒调低风扇曲线后噪音真的小了很多", own_comments=padded_own),
            "",
        )

        # Opening-prefix repetition on last 2+ own comments (even when bigram sim < 0.55).
        prefix_own = ["看到一半以为要翻车结果成功点亮", "看到一半差点以为电源冒烟了"]
        self.assertTrue(
            style_guard.check_comment_style("看到一半突然切出一段猫叫太逗了", own_comments=prefix_own)
        )
        # Only 1 consecutive matching stem does not block.
        self.assertEqual(
            style_guard.check_comment_style("看到一半突然切出一段猫叫太逗了", own_comments=[prefix_own[0]]),
            "",
        )

        # Similarity >= 0.50 against hot_comments[:20].
        hot = ["把硅脂刮平再压散热器果然降了六度"]
        self.assertTrue(
            style_guard.check_comment_style("把硅脂刮平再压散热器直接降了六度", hot_comments=hot)
        )
        # Beyond hot_comments[:20] does not block.
        padded_hot = [f"热评占位第{i}条内容" for i in range(20)] + hot
        self.assertEqual(
            style_guard.check_comment_style("把硅脂刮平再压散热器直接降了六度", hot_comments=padded_hot),
            "",
        )

        # Natural specific comment passes.
        self.assertEqual(
            style_guard.check_comment_style(
                "3分10秒那个示波器纹波一拉高就看出来电源滤波缩水了",
                own_comments=own,
                hot_comments=hot,
            ),
            "",
        )

    def test_looks_like_ai_swarm(self) -> None:
        self.assertFalse(style_guard.looks_like_ai_swarm(["就一条评论"]))
        self.assertFalse(style_guard.looks_like_ai_swarm([
            "2分15秒猫直接跳键盘上了笑死",
            "bgm 叫啥求歌名",
            "哈哈",
            "下次一定",
            "下次一定",
        ]))
        self.assertFalse(style_guard.looks_like_ai_swarm([
            "值得一看！讲得非常清楚",
            "我按这个引脚焊反了差点烧掉板子",
        ]))
        self.assertTrue(style_guard.looks_like_ai_swarm([
            "值得一看！逻辑特别清晰",
            "感谢分享，学到了不少技巧",
        ]))
        self.assertTrue(style_guard.looks_like_ai_swarm([
            "前半段实测数据很扎实，后半段对比也很直观",
            "前半段实测数据很扎实，后半段对比非常直观",
        ]))
        self.assertTrue(style_guard.looks_like_ai_swarm([
            "看完这期最大的感受是剪辑节奏很稳",
            "看完这期最大的收获是排版思路清晰",
            "看完这期最大的体会是逻辑相当流畅",
        ]))


class TestDutyStore(unittest.TestCase):
    """Tests for duty_store.py."""

    def test_safe_subpath_blocks_traversal(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            home = Path(tmpdir)
            with self.assertRaises(ValueError):
                duty_store._safe_subpath(home, "..", "escape.txt")

    def test_pick_record_dedup_and_validation(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            home = Path(tmpdir)
            bad = duty_store.pick_record(home, "not-a-bvid", "标题", "UP")
            self.assertFalse(bad["ok"])

            # Pre-seed a corrupted JSONL line to verify graceful recovery.
            picks_dir = home / "picks"
            picks_dir.mkdir(parents=True, exist_ok=True)
            (picks_dir / "2026-11-18.jsonl").write_text("{corrupt json\n", encoding="utf-8")

            first = duty_store.pick_record(
                home,
                bvid="BV1uNk1YxEJQ",
                title="Rust 异步调度拆解",
                up="硬核UP",
                tier="必看",
                why="源码级剖析",
                tags=["Rust", "异步", "Rust"],
                date="2026-11-18",
            )
            self.assertTrue(first["ok"])
            self.assertFalse(first["updated"])
            self.assertEqual(first["count"], 1)
            self.assertEqual(first["record"]["tags"], ["Rust", "异步"])

            second = duty_store.pick_record(
                home,
                bvid="BV1uNk1YxEJQ",
                title="Rust 异步调度拆解（修订）",
                up="硬核UP",
                tier="必看",
                why="更新了压测数据",
                tags=["Rust"],
                date="2026-11-18",
            )
            self.assertTrue(second["ok"])
            self.assertTrue(second["updated"])
            self.assertEqual(second["count"], 1)

            third = duty_store.pick_record(
                home,
                bvid="BV1xx411c7mD",
                title="机械键盘换轴指南",
                up="外设君",
                date="../../etc/passwd",  # falls back safely to today inside duty_home
            )
            self.assertTrue(third["ok"])
            self.assertTrue((home / "picks" / f"{third['day']}.jsonl").is_file())
            self.assertEqual(list(picks_dir.glob("*.tmp")), [])

    def test_report_today_truncation_and_picks(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            home = Path(tmpdir)
            empty_res = duty_store.report_today(home, date="2026-11-18")
            self.assertTrue(empty_res["ok"])
            self.assertFalse(empty_res["has_report"])
            self.assertEqual(empty_res["picks"], [])

            out_dir = home / "out"
            out_dir.mkdir(parents=True, exist_ok=True)
            long_md = "# 日报\n" + "\n".join(f"- 第 {i} 行内容测试截断长度" for i in range(40))
            (out_dir / "2026-11-18.md").write_text(long_md, encoding="utf-8")
            duty_store.pick_record(home, "BV1uNk1YxEJQ", "测试视频", "测试UP", date="2026-11-18")

            rep = duty_store.report_today(home, date="2026-11-18", max_chars=120)
            self.assertTrue(rep["has_report"])
            self.assertTrue(rep["truncated"])
            self.assertLessEqual(len(rep["report"]), 120)
            self.assertEqual(rep["pick_count"], 1)

    def test_digest_search_recency_and_multitoken(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            home = Path(tmpdir)
            (home / "digest").mkdir(parents=True, exist_ok=True)
            (home / "seen").mkdir(parents=True, exist_ok=True)
            (home / "digest" / "2026-10.md").write_text(
                "- 2026-10-12 Rust 编译器入门\n- 2026-10-15 做饭日常\n",
                encoding="utf-8",
            )
            (home / "digest" / "2026-11.md").write_text(
                "- 2026-11-05 Rust 编译器内存模型\n",
                encoding="utf-8",
            )
            (home / "seen.md").write_text(
                "| 日期 | BV | 标题 | UP | 状态 |\n"
                "| --- | --- | --- | --- | --- |\n"
                "| 2026-11-18 | BV1uNk1YxEJQ | RUST 编译器借用检查 | 极客 | 挑了 |\n",
                encoding="utf-8",
            )

            res = duty_store.digest_search(home, query="rust 编译器", limit=10)
            self.assertTrue(res["ok"])
            self.assertEqual(res["count"], 3)
            self.assertIn("2026-11-18", res["matches"][0]["text"])
            self.assertIn("2026-11-05", res["matches"][1]["text"])
            self.assertIn("2026-10-12", res["matches"][2]["text"])

    def test_memory_note_recall_and_corruption_resilience(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            home = Path(tmpdir)
            bad_kind = duty_store.memory_note(home, kind="invalid_kind", subject="x", content="y")
            self.assertFalse(bad_kind["ok"])
            bad_empty = duty_store.memory_note(home, kind="observation", subject="", content="")
            self.assertFalse(bad_empty["ok"])

            # Pre-seed corrupted profile and extra JS field to test recovery + preservation.
            mem_dir = home / "memory"
            mem_dir.mkdir(parents=True, exist_ok=True)
            (mem_dir / "taste_profile.json").write_text("{broken json", encoding="utf-8")
            res_corrupt = duty_store.memory_recall(home)
            self.assertTrue(res_corrupt["ok"])
            self.assertEqual(res_corrupt["topics"], [])

            (mem_dir / "taste_profile.json").write_text(
                json.dumps({
                    "durationPreference": "medium",
                    "topics": {"Linux": 0.8, "Rust": {"score": 1.2, "likes": 3}},
                }),
                encoding="utf-8",
            )
            self.assertTrue(duty_store.memory_note(home, "topic_interest", "Rust", "喜欢底层原理", affinity=2.0)["ok"])
            self.assertTrue(duty_store.memory_note(home, "up_impression", "极客湾", "实测扎实", affinity=1.8)["ok"])
            self.assertTrue(duty_store.memory_note(home, "dislike", "标题党搬运", "别推洗稿")["ok"])
            self.assertTrue(duty_store.memory_note(home, "dislike", "水军营销号", "屏蔽", tags=["up"])["ok"])
            self.assertTrue(duty_store.memory_note(home, "thread", "显卡降价追踪", "下周再看后续")["ok"])
            self.assertTrue(duty_store.memory_note(home, "observation", "深夜习惯", "晚上爱看长纪录片")["ok"])

            # Append a JS-formatted episode and a corrupted line to verify recall + skip.
            with open(mem_dir / "episodic_memory.jsonl", "a", encoding="utf-8") as handle:
                handle.write(json.dumps({
                    "kind": "pick",
                    "bvid": "BV1xx411c7mD",
                    "title": "Rust 嵌入式调优",
                    "up": "硬件君",
                    "summary": "Rust 寄存器实战",
                    "tags": ["Rust"],
                }, ensure_ascii=False) + "\n")
                handle.write("not-json-line\n")

            profile_saved = json.loads((mem_dir / "taste_profile.json").read_text(encoding="utf-8"))
            self.assertEqual(profile_saved.get("durationPreference"), "medium")
            self.assertEqual(profile_saved["topics"]["Rust"]["score"], 3.2)
            self.assertEqual(profile_saved["topics"]["Rust"]["likes"], 3)
            self.assertEqual(list(mem_dir.glob("*.tmp")), [])

            recalled = duty_store.memory_recall(home, query="Rust 底层", limit=5)
            self.assertTrue(recalled["ok"])
            self.assertEqual(recalled["topics"][0]["topic"], "Rust")
            self.assertEqual(recalled["ups"][0]["up"], "极客湾")
            self.assertIn("标题党搬运", recalled["muted_topics"])
            self.assertIn("水军营销号", recalled["muted_ups"])
            self.assertGreaterEqual(len(recalled["episodes"]), 2)
            self.assertEqual(recalled["episodes"][0]["subject"], "Rust")

    def test_append_dm_history(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            home = Path(tmpdir)
            entry = duty_store.append_dm_history(home, 12345, "out", "推荐你看看 BV1uNk1YxEJQ 这条")
            self.assertEqual(entry["uid"], 12345)
            self.assertEqual(entry["direction"], "out")
            self.assertEqual(entry["bvids"], ["BV1uNk1YxEJQ"])
            lines = (home / "dm-history.jsonl").read_text(encoding="utf-8").splitlines()
            self.assertEqual(len(lines), 1)
            self.assertEqual(json.loads(lines[0])["bvids"], ["BV1uNk1YxEJQ"])


class TestMcpServerOffline(unittest.TestCase):
    """End-to-end offline tests for mcp_server.py using stubbed dependencies."""

    def test_compat_exports_and_guard_whitelist(self) -> None:
        mod, _ = _load_mcp_server_offline("bili_search,duty_report_today")
        for sym in (
            "_normalize_mention", "_bigrams", "_sim", "_STYLE_LEAD", "_style_reason",
            "_https", "_cover_url", "_snapshot_entries", "_image_headers", "_crop_tile",
        ):
            self.assertTrue(hasattr(mod, sym), f"Missing exported symbol: {sym}")

        self.assertEqual(mod._normalize_mention("@ No3799 嗨"), "@No3799 嗨")
        self.assertEqual(mod._https("http://i0.hdslb.com/a.jpg"), "https://i0.hdslb.com/a.jpg")

        denied_like = json.loads(asyncio.run(mod.bili_like("BV1uNk1YxEJQ")))
        self.assertFalse(denied_like["ok"])
        self.assertIn("bili_like", denied_like["error"])

        denied_pick = json.loads(asyncio.run(asyncio.sleep(0, result=mod.duty_pick_record("BV1uNk1YxEJQ", "t", "u"))))
        self.assertFalse(denied_pick["ok"])

        self.assertIn("没开", mod._guard("bili_reply"))
        self.assertEqual(mod._guard("bili_search"), "")

    def test_human_pause_ranges(self) -> None:
        mod, _ = _load_mcp_server_offline("")
        recorded: list[float] = []

        async def fake_sleep(val: float) -> None:
            recorded.append(val)

        with mock.patch.object(mod.asyncio, "sleep", side_effect=fake_sleep):
            with mock.patch.object(mod.random, "random", return_value=0.9):
                asyncio.run(mod._human_pause("browse"))
                asyncio.run(mod._human_pause("read"))
                asyncio.run(mod._human_pause("write"))
            with mock.patch.object(mod.random, "random", return_value=0.05):
                asyncio.run(mod._human_pause("browse"))

        self.assertTrue(0.5 <= recorded[0] <= 1.5)
        self.assertTrue(0.8 <= recorded[1] <= 2.2)
        self.assertTrue(1.0 <= recorded[2] <= 2.6)
        self.assertTrue(2.5 <= recorded[3] <= 3.5)

    def test_style_reason_and_bili_comments_order_swarm(self) -> None:
        mod, _ = _load_mcp_server_offline("")
        with tempfile.TemporaryDirectory() as tmpdir:
            mod.DUTY_HOME = Path(tmpdir)

            # Local cliché caught without hitting network.
            reason = asyncio.run(mod._style_reason("值得一看，真不错", "BV1uNk1YxEJQ", None))
            self.assertIn("去 AI 味", reason)

            # BILI_STYLE_STRICTNESS=strict triggers on formal semicolon.
            with mock.patch.dict(os.environ, {"BILI_STYLE_STRICTNESS": "strict"}):
                strict_reason = asyncio.run(mod._style_reason("散热做好了；风扇也不吵了。", "BV1uNk1YxEJQ", None))
                self.assertIn("分号", strict_reason)

            # Mock bili_comments with TIME order and AI swarm replies.
            fake_cred = mod.Credential("s", "j", "b", "1")
            fake_replies = [
                {"rpid": 1, "member": {"uname": "u1"}, "content": {"message": "值得一看！干货满满"}, "like": 5, "rcount": 0, "ctime": 1},
                {"rpid": 2, "member": {"uname": "u2"}, "content": {"message": "感谢分享，学到了很多"}, "like": 3, "rcount": 0, "ctime": 2},
            ]
            with (
                mock.patch.object(mod, "get_cred", return_value=fake_cred),
                mock.patch.object(mod, "_human_pause", new=mock.AsyncMock()),
                mock.patch.object(
                    mod.comment,
                    "get_comments",
                    new=mock.AsyncMock(side_effect=[{"replies": fake_replies}, {"replies": []}]),
                    create=True,
                ),
            ):
                res = json.loads(asyncio.run(mod.bili_comments("BV1uNk1YxEJQ", num=10, order="time")))
                self.assertEqual(res["order"], "time")
                self.assertEqual(res["count"], 2)
                self.assertTrue(res["ai_swarm_suspected"])

            # Verify bili_reply blocks AI cliché via _style_reason and passes natural text.
            with (
                mock.patch.object(mod, "get_cred", return_value=fake_cred),
                mock.patch.object(mod, "_human_pause", new=mock.AsyncMock()),
                mock.patch.object(mod.comment, "get_comments", new=mock.AsyncMock(return_value={"replies": []}), create=True),
                mock.patch.object(mod.comment, "send_comment", new=mock.AsyncMock(return_value={"rpid": 777}), create=True) as send_cmt,
            ):
                blocked = json.loads(asyncio.run(mod.bili_reply("BV1uNk1YxEJQ", "@ No3799 值得一看，很不错")))
                self.assertFalse(blocked["ok"])
                self.assertEqual(blocked["blocked_by"], "style")
                send_cmt.assert_not_called()

                ok_reply = json.loads(asyncio.run(mod.bili_reply("BV1uNk1YxEJQ", "@ No3799 3分12秒示波器纹波看得很清楚")))
                self.assertTrue(ok_reply["success"])
                self.assertEqual(ok_reply["rpid"], 777)
                self.assertEqual(send_cmt.call_args.kwargs["text"], "@No3799 3分12秒示波器纹波看得很清楚")

    def test_bili_send_message_sanitize_limit_and_history(self) -> None:
        mod, _ = _load_mcp_server_offline("")
        with tempfile.TemporaryDirectory() as tmpdir:
            mod.DUTY_HOME = Path(tmpdir)
            fake_cred = mod.Credential("s", "j", "b", "1")
            send_mock = mock.AsyncMock(return_value={"code": 0, "data": {"msg_key": 9988776655}})

            with (
                mock.patch.object(mod, "get_cred", return_value=fake_cred),
                mock.patch.object(mod, "_human_pause", new=mock.AsyncMock()),
                mock.patch.object(mod.session, "send_msg", new=send_mock, create=True),
            ):
                # Over 495 chars -> structured rejection, no send_msg call.
                too_long = "字" * 500
                over_res = json.loads(asyncio.run(mod.bili_send_message(12345, too_long)))
                self.assertFalse(over_res["success"])
                self.assertEqual(over_res["char_count"], 500)
                self.assertEqual(over_res["max_chars"], 495)
                send_mock.assert_not_called()

                # Markdown + @ space + trailing meta-note cleaned before sending.
                raw_dm = "### 晚上挑了两条\n@ No3799 看看 [**标题**](https://www.bilibili.com/video/BV1uNk1YxEJQ)\n（25字，可继续发送）"
                ok_res = json.loads(asyncio.run(mod.bili_send_message(12345, raw_dm)))
                self.assertTrue(ok_res["success"])
                sent_content = send_mock.call_args.kwargs["content"]
                self.assertNotIn("###", sent_content)
                self.assertNotIn("**", sent_content)
                self.assertNotIn("25字", sent_content)
                self.assertIn("@No3799", sent_content)
                self.assertIn("标题 https://www.bilibili.com/video/BV1uNk1YxEJQ", sent_content)

                history_lines = (Path(tmpdir) / "dm-history.jsonl").read_text(encoding="utf-8").splitlines()
                self.assertEqual(len(history_lines), 1)
                history_entry = json.loads(history_lines[0])
                self.assertEqual(history_entry["uid"], 12345)
                self.assertEqual(history_entry["direction"], "out")
                self.assertEqual(history_entry["bvids"], ["BV1uNk1YxEJQ"])

    def test_new_bili_and_duty_tools(self) -> None:
        mod, _ = _load_mcp_server_offline("")
        with tempfile.TemporaryDirectory() as tmpdir:
            mod.DUTY_HOME = Path(tmpdir)
            fake_cred = mod.Credential("s", "j", "b", "1")

            with (
                mock.patch.object(mod, "get_cred", return_value=fake_cred),
                mock.patch.object(mod, "load_credential", return_value=fake_cred),
                mock.patch.object(mod, "_human_pause", new=mock.AsyncMock()),
            ):
                # bili_related_videos
                with mock.patch.object(
                    mod.video.Video,
                    "get_related",
                    new=mock.AsyncMock(return_value=[{"bvid": "BV1xx411c7mD", "title": "相关视频", "owner": {"name": "UP1", "mid": 9}, "stat": {"view": 100}, "duration": 95}]),
                ):
                    rel = json.loads(asyncio.run(mod.bili_related_videos("BV1uNk1YxEJQ", limit=5)))
                    self.assertTrue(rel["ok"])
                    self.assertEqual(rel["videos"][0]["duration"], "1:35")

                # bili_dynamic_feed
                dyn_payload = {
                    "has_more": True,
                    "offset": "next_1",
                    "items": [{
                        "id_str": "101",
                        "type": "DYNAMIC_TYPE_AV",
                        "modules": {
                            "module_author": {"name": "常看UP", "mid": 88, "pub_time": "1小时前"},
                            "module_dynamic": {
                                "major": {
                                    "archive": {
                                        "bvid": "BV1xx411c7mD",
                                        "title": "动态新片",
                                        "duration_text": "08:12",
                                        "stat": {"play": "1.2万", "danmaku": "50"},
                                    }
                                }
                            },
                        },
                    }],
                }
                with mock.patch.object(mod.dynamic, "get_dynamic_page_info", new=mock.AsyncMock(return_value=dyn_payload)):
                    dyn = json.loads(asyncio.run(mod.bili_dynamic_feed()))
                    self.assertTrue(dyn["ok"])
                    self.assertEqual(dyn["offset"], "next_1")
                    self.assertEqual(dyn["items"][0]["bvid"], "BV1xx411c7mD")

                # bili_history
                hist_payload = [
                    {"title": "看过的视频", "author_name": "UP2", "history": {"bvid": "BV1uNk1YxEJQ"}, "view_at": 1700000000}
                ]
                with mock.patch.object(mod.user, "get_self_history", new=mock.AsyncMock(return_value=hist_payload)):
                    hist = json.loads(asyncio.run(mod.bili_history()))
                    self.assertTrue(hist["ok"])
                    self.assertEqual(hist["bvids"], ["BV1uNk1YxEJQ"])

                # bili_like (already liked graceful handling)
                with mock.patch.object(mod.video.Video, "like", new=mock.AsyncMock(side_effect=RuntimeError("65006 已经赞过"))):
                    liked = json.loads(asyncio.run(mod.bili_like("BV1uNk1YxEJQ")))
                    self.assertTrue(liked["ok"])
                    self.assertTrue(liked["already"])

                # bili_watch_later_add
                with mock.patch.object(mod.user, "set_watch_later", new=mock.AsyncMock(return_value={"code": 0})):
                    wl = json.loads(asyncio.run(mod.bili_watch_later_add("BV1uNk1YxEJQ")))
                    self.assertTrue(wl["ok"])

                # bili_coin clamps num to 1..2
                coin_mock = mock.AsyncMock(return_value={"like": False})
                with mock.patch.object(mod.video.Video, "pay_coin", new=coin_mock):
                    coined = json.loads(asyncio.run(mod.bili_coin("BV1uNk1YxEJQ", num=5)))
                    self.assertTrue(coined["ok"])
                    self.assertEqual(coined["num"], 2)
                    coin_mock.assert_awaited_once_with(num=2)

            # duty_* wrappers
            p_res = json.loads(mod.duty_pick_record("BV1uNk1YxEJQ", "好片", "极客", tags=["Rust", "编译器"]))
            self.assertTrue(p_res["ok"])
            r_res = json.loads(mod.duty_report_today())
            self.assertTrue(r_res["ok"])
            self.assertEqual(r_res["pick_count"], 1)
            n_res = json.loads(mod.duty_memory_note("topic_interest", "Rust", "喜欢底层", affinity=1.5))
            self.assertTrue(n_res["ok"])
            m_res = json.loads(mod.duty_memory_recall(query="Rust"))
            self.assertTrue(m_res["ok"])
            self.assertEqual(m_res["topics"][0]["topic"], "Rust")
            mod.duty_digest_append("- 2026-11-18 Rust 实战")
            d_res = json.loads(mod.duty_digest_search(query="rust"))
            self.assertTrue(d_res["ok"])
            self.assertEqual(d_res["count"], 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
