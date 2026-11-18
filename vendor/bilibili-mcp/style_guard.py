"""Anti-AI style gate and plain-text sanitization for Bilibili comments and DMs.

Pure Python 3.10+ stdlib module shared by ``mcp_server.py`` and offline checks.
"""

from __future__ import annotations

import re

VALID_STRICTNESS = frozenset({"relaxed", "balanced", "strict"})

_CLICHE_LEAD_PATTERNS = (
    r"这条(?:我认|我记下了|值得)",
    r"我记下了",
    r"值得一看",
    r"确实值得",
    r"不得不说",
    r"好家伙",
    r"这个(?:必须|真的要)",
    r"强烈推荐",
    r"感谢分享",
    r"学到了",
    r"受教了",
    r"作为一个",
    r"总之",
    r"综上",
    r"宝藏\s*[Uu][Pp]",
    r"干货满满",
    r"本期视频",
    r"视频中",
    r"这个视频主要",
)

# Kept exported so mcp_server.py can expose _STYLE_LEAD compatibly.
STYLE_LEAD = re.compile(
    r"^\s*(?:@\S+\s+)?(?:" + "|".join(_CLICHE_LEAD_PATTERNS) + r")"
)

_MID_CLICHE_RE = re.compile(r"干货满满|强烈推荐|宝藏\s*[Uu][Pp]|值得一看|不得不说")

_LISTICLE_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("「首先…其次」套路分点", re.compile(r"首先[\s\S]*?其次")),
    (
        "编号列表（1. … 2. …）",
        re.compile(r"(?:^|[\s\n])1[.、]\s+\S+[\s\S]*?(?:^|[\s\n])2[.、]\s+\S+"),
    ),
)

_TRANSITION_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("AI 过渡词「值得一提的是」", re.compile(r"值得一提的是")),
    ("AI 总结词「总而言之 / 总体而言」", re.compile(r"总(?:而言之|体而言)")),
    ("AI 客服尾「如需…请告诉我」", re.compile(r"如需.*请告诉我")),
    ("AI 客套尾「欢迎…交流」", re.compile(r"欢迎.*交流")),
    ("AI 客服尾「希望…对你有帮助」", re.compile(r"希望.*对你有帮助")),
)

_MARKDOWN_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("Markdown 加粗语法（**…**）", re.compile(r"\*\*[^\n]+?\*\*")),
    ("Markdown 标题语法（# …）", re.compile(r"(?m)^[ \t]*#{1,6}\s+")),
)

_STRICT_SUMMARY_RE = re.compile(
    r"总的来说|总结(?:来说|一下|如下)|综上所述|由此可见|不仅如此|与此同时|不难看出|毫无疑问|一方面[\s\S]*?另一方面"
)
_STRICT_LABEL_COLON_RE = re.compile(r"(?m)^(?:优点|缺点|亮点|槽点|总结|结论|核心|建议)[：:]")
_STRICT_BULLET_RE = re.compile(r"(?m)^[ \t]*[-*•]\s+\S+.*\n[ \t]*[-*•]\s+\S+")

_URL_RE = re.compile(r"https?://[^\s<>()]+")
_MD_LINK_RE = re.compile(r"\[([^\]]*)\]\((https?://[^)\s]+)\)")
_TRAILING_META_RE = re.compile(
    r"[ \t]*[（(]\s*(?:"
    r"(?:以上(?:内容)?|全文)?\s*(?:共\s*计?|约)?\s*\d+\s*字(?:\s*[，,、；;][^）)\n]*)?"
    r"|字数\s*[：:]\s*\d+[^）)\n]*"
    r")[）)]\s*$"
)


def normalize_mention(text: str) -> str:
    """Collapse whitespace immediately after ``@`` (``@ 昵称`` -> ``@昵称``)."""
    return re.sub(r"@\s+", "@", text or "")


def _strip_inline_md(fragment: str) -> str:
    cleaned = re.sub(r"\*\*([^\n]+?)\*\*", r"\1", fragment)
    cleaned = re.sub(r"__([^\n]+?)__", r"\1", cleaned)
    cleaned = re.sub(r"`([^`\n]+)`", r"\1", cleaned)
    return cleaned


def sanitize_plain_text(text: str) -> str:
    """Strip Markdown/AI meta artifacts for Bilibili plain-text DMs and notes."""
    if text is None:
        return ""
    cleaned = str(text).replace("\r\n", "\n").replace("\r", "\n")

    # Remove trailing AI self-counting notes like （28字，可继续发送） or (共N字).
    while True:
        updated = _TRAILING_META_RE.sub("", cleaned)
        if updated == cleaned:
            break
        cleaned = updated

    # Strip fenced code block markers and leading ATX headers.
    cleaned = re.sub(r"(?m)^[ \t]*```[^\n]*$", "", cleaned)
    cleaned = re.sub(r"(?m)^[ \t]*#{1,6}[ \t]+", "", cleaned)

    # Convert [label](https://...) -> "label https://..." (or URL alone if identical/empty).
    def _replace_link(match: re.Match[str]) -> str:
        raw_label = _strip_inline_md(match.group(1)).strip()
        url = match.group(2).strip()
        if not raw_label or raw_label == url:
            return url
        return f"{raw_label} {url}"

    cleaned = _MD_LINK_RE.sub(_replace_link, cleaned)

    # Protect raw URLs so underscores inside URLs are never stripped as __bold__.
    urls: list[str] = []

    def _stash_url(match: re.Match[str]) -> str:
        token = f"\x00URL{len(urls)}\x00"
        urls.append(match.group(0))
        return token

    cleaned = _URL_RE.sub(_stash_url, cleaned)
    cleaned = _strip_inline_md(cleaned)
    for idx, url in enumerate(urls):
        cleaned = cleaned.replace(f"\x00URL{idx}\x00", url)

    cleaned = normalize_mention(cleaned)
    cleaned = "\n".join(line.rstrip() for line in cleaned.split("\n"))
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


def bigrams(s: str) -> set[str]:
    """Return character bigrams over non-space word/CJK characters."""
    compact = re.sub(
        r"[^\w\u4e00-\u9fff]",
        "",
        "".join(ch for ch in str(s or "") if not ch.isspace()),
    )
    if len(compact) < 2:
        return set(compact)
    return {compact[i:i + 2] for i in range(len(compact) - 1)}


def bigram_similarity(a: str, b: str) -> float:
    """Compute bigram Jaccard similarity in ``[0.0, 1.0]``."""
    left, right = bigrams(a), bigrams(b)
    if not left or not right:
        return 0.0
    return len(left & right) / max(1, len(left | right))


def _norm_strictness(strictness: str) -> str:
    mode = str(strictness or "balanced").strip().lower()
    return mode if mode in VALID_STRICTNESS else "balanced"


def detect_ai_patterns(text: str, strictness: str = "balanced") -> list[str]:
    """Return human-readable Chinese labels for AI/template/Markdown patterns found."""
    raw = str(text or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    if not raw:
        return []
    mode = _norm_strictness(strictness)
    hits: list[str] = []

    lead_match = STYLE_LEAD.match(raw)
    if lead_match:
        phrase = re.sub(r"^\s*@\S+\s+", "", lead_match.group(0)).strip()
        hits.append(f"套话开头「{phrase}」")

    for label, pattern in _LISTICLE_PATTERNS:
        if pattern.search(raw):
            hits.append(label)

    if mode == "relaxed":
        return list(dict.fromkeys(hits))

    mid_match = _MID_CLICHE_RE.search(raw)
    if mid_match and not lead_match:
        hits.append(f"AI 评价词「{mid_match.group(0)}」")

    for label, pattern in _TRANSITION_PATTERNS:
        if pattern.search(raw):
            hits.append(label)

    for label, pattern in _MARKDOWN_PATTERNS:
        if pattern.search(raw):
            hits.append(label)

    if mode == "strict":
        body_no_urls = _URL_RE.sub("", raw)
        summary_match = _STRICT_SUMMARY_RE.search(body_no_urls)
        if summary_match:
            hits.append(f"书面总结词「{summary_match.group(0)}」")
        if "；" in body_no_urls or ";" in body_no_urls:
            hits.append("过于书面的分号断句")
        if _STRICT_LABEL_COLON_RE.search(body_no_urls):
            hits.append("模板化分段标签（如「优点：/总结：」）")
        if _STRICT_BULLET_RE.search(raw):
            hits.append("条列式清单格式")
        if body_no_urls.count("。") >= 3:
            hits.append("多句完整句号书面作文体")

    return list(dict.fromkeys(hits))


def _opening_stem(text: str) -> str:
    """Extract alphanumeric/CJK stem from the start of a comment (ignoring @mention)."""
    no_mention = re.sub(r"^\s*(?:@\S+\s+)+", "", str(text or ""))
    return re.sub(r"[^\w\u4e00-\u9fff]", "", no_mention)


def check_comment_style(
    text: str,
    own_comments: list[str] | None = None,
    hot_comments: list[str] | None = None,
    strictness: str = "balanced",
) -> str:
    """Return ``""`` if a comment passes style checks, or actionable Chinese feedback."""
    raw = str(text or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    body = " ".join(raw.split())
    if not body:
        return "评论是空的。"

    patterns = detect_ai_patterns(raw, strictness=strictness)
    if patterns:
        summary = "、".join(patterns[:3])
        return (
            f"命中去 AI 味拦截（{summary}）。"
            "直接用口语说视频里一个只有看了才说得出的细节，别用套话、序号或 Markdown。"
        )

    recent_own = [
        " ".join(str(item or "").split())
        for item in (own_comments or [])[-30:]
        if str(item or "").strip()
    ]
    for old in recent_own:
        similarity = bigram_similarity(body, old)
        if similarity >= 0.55:
            return (
                f"这句跟你以前发过的「{old[:18]}…」太像了（相似度 {similarity:.2f}）。"
                "换开头、换关注点，别套同一个句式。"
            )

    cand_stem = _opening_stem(body)
    if len(cand_stem) >= 3 and len(recent_own) >= 2:
        last_two_stems = [_opening_stem(item) for item in recent_own[-2:]]
        prefix = cand_stem[:3]
        if all(len(stem) >= 3 and stem.startswith(prefix) for stem in last_two_stems):
            return (
                f"最近连续两条自己发的评论都以「{prefix}…」开头，句式撞车了。"
                "换个切入点开头，别老用同一个起手式。"
            )

    for hot_item in (hot_comments or [])[:20]:
        other = " ".join(str(hot_item or "").split())
        if not other:
            continue
        similarity = bigram_similarity(body, other)
        if similarity >= 0.50:
            return (
                f"这条视频底下已经有一句很像的（相似度 {similarity:.2f}）：{other[:24]}… "
                "撞车了 —— 换个角度写，或者这一轮不发。"
            )

    return ""


def looks_like_ai_swarm(comments: list[str]) -> bool:
    """Heuristic detecting whether a thread already has >= 2 AI/template comments."""
    cleaned = [
        " ".join(str(item or "").split())
        for item in (comments or [])[:30]
        if str(item or "").strip()
    ]
    if len(cleaned) < 2:
        return False

    suspicious: set[int] = set()
    for idx, comment_text in enumerate(cleaned):
        if detect_ai_patterns(comment_text, strictness="balanced"):
            suspicious.add(idx)

    for i in range(len(cleaned)):
        if len(cleaned[i]) < 8:
            continue
        for j in range(i + 1, len(cleaned)):
            if len(cleaned[j]) < 8:
                continue
            if bigram_similarity(cleaned[i], cleaned[j]) >= 0.50:
                suspicious.add(i)
                suspicious.add(j)

    stem_buckets: dict[str, list[int]] = {}
    for idx, comment_text in enumerate(cleaned):
        stem = _opening_stem(comment_text)
        if len(stem) >= 6:
            stem_buckets.setdefault(stem[:6], []).append(idx)
    for indices in stem_buckets.values():
        if len(indices) >= 3:
            suspicious.update(indices)

    return len(suspicious) >= 2
