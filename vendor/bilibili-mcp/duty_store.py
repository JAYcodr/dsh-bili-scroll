"""Narrow-IO persistence store strictly scoped inside ``duty_home``.

Pure Python 3.10+ stdlib module. Every file read/write is confined inside
``duty_home`` and uses atomic temp-file + ``os.replace`` for state rewrites.
"""

from __future__ import annotations

import datetime as dt
import json
import math
import os
import re
import tempfile
from pathlib import Path
from typing import Any

from style_guard import bigram_similarity

BVID_RE = re.compile(r"^BV[0-9A-Za-z]{10}$")
BVID_EXTRACT_RE = re.compile(r"(?<![0-9A-Za-z])BV[0-9A-Za-z]{10}(?![0-9A-Za-z])")
DATE_RE = re.compile(
    r"^(?:(\d{4})[-/.])?(\d{1,2})[-/.](\d{1,2})(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$"
)
LINE_DATE_RE = re.compile(r"(?<!\d)(20\d{2}-\d{2}-\d{2})(?!\d)")
FILE_MONTH_RE = re.compile(r"(20\d{2}-\d{2})")
VALID_MEMORY_KINDS = frozenset(
    {"up_impression", "topic_interest", "dislike", "thread", "observation"}
)


def _safe_subpath(duty_home: Path | str, *parts: str) -> Path:
    """Resolve a path and enforce strict containment inside ``duty_home``."""
    base = Path(duty_home).resolve()
    target = base.joinpath(*parts).resolve()
    if not target.is_relative_to(base):
        raise ValueError(f"路径越界被拒绝：{target} 不在 {base} 内")
    return target


def norm_date(raw: str = "") -> str:
    """Normalize a date string to ``YYYY-MM-DD``, defaulting to today."""
    today = dt.date.today()
    matched = DATE_RE.match(str(raw or "").strip())
    if not matched:
        return today.isoformat()
    year = int(matched.group(1)) if matched.group(1) else today.year
    try:
        parsed = dt.date(year, int(matched.group(2)), int(matched.group(3)))
        if not matched.group(1) and parsed > today:
            parsed = parsed.replace(year=year - 1)
    except ValueError:
        return today.isoformat()
    return parsed.isoformat()


def _now_iso() -> str:
    return dt.datetime.now().astimezone().isoformat(timespec="seconds")


def _clean_tags(tags: list[str] | None) -> list[str]:
    if not tags:
        return []
    seen: set[str] = set()
    cleaned: list[str] = []
    for item in tags:
        text = str(item or "").strip()
        if text and text not in seen:
            seen.add(text)
            cleaned.append(text)
    return cleaned


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        num = float(value)
    except (TypeError, ValueError):
        return default
    return num if math.isfinite(num) else default


def _atomic_write_text(path: Path, text: str) -> None:
    """Write ``text`` to a same-directory temp file and atomically replace ``path``."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            newline="\n",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as handle:
            tmp_path = Path(handle.name)
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_path, path)
    except Exception:
        if tmp_path is not None and tmp_path.exists():
            try:
                tmp_path.unlink()
            except OSError:
                pass
        raise


def _append_jsonl_line(path: Path, entry: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(entry, ensure_ascii=False) + "\n"
    with open(path, "a", encoding="utf-8", newline="\n") as handle:
        handle.write(line)


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    try:
        raw_lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []
    records: list[dict[str, Any]] = []
    for line in raw_lines:
        stripped = line.strip()
        if not stripped:
            continue
        try:
            obj = json.loads(stripped)
        except ValueError:
            continue
        if isinstance(obj, dict):
            records.append(obj)
    return records


def _read_json_dict(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        obj = json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except (OSError, ValueError):
        return {}
    return obj if isinstance(obj, dict) else {}


def pick_record(
    duty_home: Path,
    bvid: str,
    title: str,
    up: str,
    tier: str = "可以看",
    why: str = "",
    tags: list[str] | None = None,
    date: str = "",
) -> dict[str, Any]:
    """Record or update a structured pick entry in ``picks/<day>.jsonl`` atomically."""
    bv = str(bvid or "").strip()
    if not BVID_RE.fullmatch(bv):
        return {
            "ok": False,
            "error": f"无效的 BV 号：{bv!r}（必须是 BV 加 10 位字母或数字）",
        }

    day = norm_date(date)
    picks_path = _safe_subpath(duty_home, "picks", f"{day}.jsonl")
    existing = _read_jsonl(picks_path)

    record = {
        "bvid": bv,
        "title": " ".join(str(title or "").split()),
        "up": " ".join(str(up or "").split()),
        "tier": str(tier or "可以看").strip() or "可以看",
        "why": " ".join(str(why or "").split()),
        "tags": _clean_tags(tags),
        "url": f"https://www.bilibili.com/video/{bv}",
        "day": day,
        "at": _now_iso(),
    }

    updated = False
    merged: list[dict[str, Any]] = []
    for item in existing:
        if item.get("bvid") == bv:
            if not updated:
                merged.append(record)
                updated = True
        else:
            merged.append(item)
    if not updated:
        merged.append(record)

    payload = "\n".join(json.dumps(item, ensure_ascii=False) for item in merged) + "\n"
    _atomic_write_text(picks_path, payload)

    return {
        "ok": True,
        "day": day,
        "bvid": bv,
        "updated": updated,
        "count": len(merged),
        "file": f"picks/{day}.jsonl",
        "record": record,
    }


def _truncate_cleanly(text: str, max_chars: int) -> tuple[str, bool]:
    if len(text) <= max_chars:
        return text, False
    suffix = "\n…(已截断)"
    if max_chars <= len(suffix) + 8:
        return text[:max_chars], True
    budget = max_chars - len(suffix)
    cut = text.rfind("\n", 0, budget)
    if cut >= budget // 2:
        return text[:cut] + suffix, True
    return text[:budget] + suffix, True


def report_today(duty_home: Path, date: str = "", max_chars: int = 12000) -> dict[str, Any]:
    """Read ``out/<day>.md`` (truncated cleanly) and ``picks/<day>.jsonl``."""
    day = norm_date(date)
    limit = int(max_chars) if max_chars is not None and int(max_chars) > 0 else 12000

    report_path = _safe_subpath(duty_home, "out", f"{day}.md")
    picks_path = _safe_subpath(duty_home, "picks", f"{day}.jsonl")

    has_report = report_path.exists()
    raw_report = ""
    if has_report:
        try:
            raw_report = report_path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            raw_report = ""
            has_report = False

    report_text, truncated = _truncate_cleanly(raw_report, limit)
    picks = _read_jsonl(picks_path)

    return {
        "ok": True,
        "day": day,
        "has_report": has_report,
        "report": report_text,
        "truncated": truncated,
        "picks": picks,
        "pick_count": len(picks),
    }


def _is_skippable_markdown_line(line: str) -> bool:
    stripped = line.strip()
    if not stripped:
        return True
    if stripped.startswith("|"):
        cells = [c.strip() for c in stripped.strip("|").split("|")]
        if cells and all(re.fullmatch(r"[:\-]+", c or "-") for c in cells):
            return True
        if stripped.startswith("| 日期 |") or stripped.startswith("|日期|"):
            return True
    return False


def _line_sort_key(line_text: str, rel_source: str, mtime: float, line_no: int) -> tuple[str, float, int]:
    date_match = LINE_DATE_RE.search(line_text)
    if date_match:
        date_key = date_match.group(1)
    else:
        month_match = FILE_MONTH_RE.search(rel_source)
        date_key = f"{month_match.group(1)}-00" if month_match else ""
    return (date_key, mtime, line_no)


def digest_search(duty_home: Path, query: str = "", limit: int = 15) -> dict[str, Any]:
    """Search ``digest/*.md``, ``seen.md``, and ``seen/*.md`` returning newest matches."""
    base = Path(duty_home).resolve()
    clamped_limit = max(1, min(int(limit or 15), 200))
    clean_query = " ".join(str(query or "").split())
    tokens = [tok.lower() for tok in clean_query.split()]

    candidate_files: list[Path] = []
    digest_dir = _safe_subpath(base, "digest")
    if digest_dir.is_dir():
        candidate_files.extend(sorted(digest_dir.glob("*.md")))
    seen_file = _safe_subpath(base, "seen.md")
    if seen_file.is_file():
        candidate_files.append(seen_file)
    seen_dir = _safe_subpath(base, "seen")
    if seen_dir.is_dir():
        candidate_files.extend(sorted(seen_dir.glob("*.md")))

    hits: list[tuple[tuple[str, float, int], dict[str, Any]]] = []
    for file_path in candidate_files:
        resolved = file_path.resolve()
        if not resolved.is_relative_to(base):
            continue
        try:
            mtime = resolved.stat().st_mtime
            lines = resolved.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        rel_source = resolved.relative_to(base).as_posix()
        for idx, raw_line in enumerate(lines, start=1):
            if _is_skippable_markdown_line(raw_line):
                continue
            low = raw_line.lower()
            if tokens and not all(tok in low for tok in tokens):
                continue
            sort_key = _line_sort_key(raw_line, rel_source, mtime, idx)
            hits.append((
                sort_key,
                {"source": rel_source, "line": idx, "text": raw_line.strip()},
            ))

    hits.sort(key=lambda pair: pair[0], reverse=True)
    matches = [entry for _, entry in hits[:clamped_limit]]
    return {
        "ok": True,
        "query": clean_query,
        "count": len(matches),
        "matches": matches,
    }


def _extract_muted_list(profile: dict[str, Any], *keys: str) -> list[str]:
    items: list[str] = []
    seen: set[str] = set()
    for key in keys:
        val = profile.get(key)
        if not isinstance(val, list):
            continue
        for entry in val:
            name = str(entry or "").strip()
            if name and name not in seen:
                seen.add(name)
                items.append(name)
    return items


def _episode_score(episode: dict[str, Any], idx: int, total: int, query_tokens: list[str], query_text: str) -> float:
    recency = (idx + 1) / max(1, total)
    if not query_text:
        return recency
    haystack = " ".join([
        str(episode.get("subject", "")),
        str(episode.get("content", "")),
        str(episode.get("title", "")),
        str(episode.get("up", "")),
        str(episode.get("summary", "")),
        str(episode.get("bvid", "")),
        " ".join(str(t) for t in (episode.get("tags") or []) if t),
        str(episode.get("kind", "")),
    ]).lower()
    if not haystack.strip():
        return 0.0
    token_hits = sum(1 for tok in query_tokens if tok in haystack)
    token_ratio = token_hits / max(1, len(query_tokens))
    sim = bigram_similarity(query_text.lower(), haystack)
    overlap = max(token_ratio, sim if sim >= 0.15 else 0.0)
    if overlap <= 0.0:
        return 0.0
    return overlap + 0.25 * recency


def memory_recall(duty_home: Path, query: str = "", limit: int = 10) -> dict[str, Any]:
    """Recall taste profile preferences and relevant/recent episodic memories."""
    clamped_limit = max(1, min(int(limit or 10), 100))
    profile_path = _safe_subpath(duty_home, "memory", "taste_profile.json")
    episodes_path = _safe_subpath(duty_home, "memory", "episodic_memory.jsonl")

    profile = _read_json_dict(profile_path)
    muted_topics = _extract_muted_list(profile, "mutedTopics", "muted_topics")
    muted_ups = _extract_muted_list(profile, "mutedUps", "muted_ups")
    muted_topics_set = set(muted_topics)
    muted_ups_set = set(muted_ups)

    topics_list: list[dict[str, Any]] = []
    raw_topics = profile.get("topics")
    if isinstance(raw_topics, dict):
        for name, val in raw_topics.items():
            topic_name = str(name or "").strip()
            if not topic_name:
                continue
            if isinstance(val, dict):
                if val.get("muted"):
                    if topic_name not in muted_topics_set:
                        muted_topics_set.add(topic_name)
                        muted_topics.append(topic_name)
                    continue
                weight = _safe_float(val.get("weight", val.get("score", 0.0)))
                notes = [str(n) for n in (val.get("notes") or []) if str(n).strip()][-3:]
            else:
                weight = _safe_float(val)
                notes = []
            if topic_name in muted_topics_set:
                continue
            topics_list.append({"topic": topic_name, "weight": round(weight, 3), "notes": notes})
    topics_list.sort(key=lambda item: item["weight"], reverse=True)

    ups_list: list[dict[str, Any]] = []
    raw_ups = profile.get("ups")
    if isinstance(raw_ups, dict):
        for name, val in raw_ups.items():
            up_name = str(name or "").strip()
            if not up_name:
                continue
            if isinstance(val, dict):
                if val.get("muted"):
                    if up_name not in muted_ups_set:
                        muted_ups_set.add(up_name)
                        muted_ups.append(up_name)
                    continue
                aff = _safe_float(val.get("affinity", val.get("score", 0.0)))
                notes = [str(n) for n in (val.get("notes") or []) if str(n).strip()][-3:]
            else:
                aff = _safe_float(val)
                notes = []
            if up_name in muted_ups_set:
                continue
            ups_list.append({"up": up_name, "affinity": round(aff, 3), "notes": notes})
    ups_list.sort(key=lambda item: item["affinity"], reverse=True)

    clean_query = " ".join(str(query or "").split())
    query_tokens = [tok.lower() for tok in clean_query.split()]
    all_episodes = _read_jsonl(episodes_path)
    total = len(all_episodes)

    scored: list[tuple[float, int, dict[str, Any]]] = []
    for idx, episode in enumerate(all_episodes):
        score = _episode_score(episode, idx, total, query_tokens, clean_query)
        if clean_query and score <= 0.0:
            continue
        scored.append((score, idx, episode))

    scored.sort(key=lambda item: (item[0], item[1]), reverse=True)
    recalled_episodes = [item[2] for item in scored[:clamped_limit]]

    return {
        "ok": True,
        "topics": topics_list[:15],
        "ups": ups_list[:15],
        "muted_ups": muted_ups,
        "muted_topics": muted_topics,
        "episodes": recalled_episodes,
    }


def _append_note(notes: list[Any], content: str, limit: int = 10) -> list[str]:
    cleaned = [str(n).strip() for n in (notes or []) if str(n).strip()]
    if content and (not cleaned or cleaned[-1] != content):
        cleaned.append(content)
    return cleaned[-limit:]


def memory_note(
    duty_home: Path,
    kind: str,
    subject: str,
    content: str,
    affinity: float = 0.0,
    tags: list[str] | None = None,
) -> dict[str, Any]:
    """Append an episodic memory note and atomically update ``taste_profile.json``."""
    clean_kind = str(kind or "").strip()
    if clean_kind not in VALID_MEMORY_KINDS:
        allowed = ", ".join(sorted(VALID_MEMORY_KINDS))
        return {"ok": False, "error": f"不支持的记忆类型：{clean_kind!r}（可选：{allowed}）"}

    clean_subject = " ".join(str(subject or "").split())
    clean_content = " ".join(str(content or "").split())
    if not clean_subject and not clean_content:
        return {"ok": False, "error": "subject 和 content 不能同时为空"}

    clean_tags = _clean_tags(tags)
    aff_delta = _safe_float(affinity, 0.0)
    now = _now_iso()
    day = now[:10]

    episode = {
        "at": now,
        "day": day,
        "kind": clean_kind,
        "subject": clean_subject,
        "content": clean_content,
        "affinity": aff_delta,
        "tags": clean_tags,
    }

    episodes_path = _safe_subpath(duty_home, "memory", "episodic_memory.jsonl")
    profile_path = _safe_subpath(duty_home, "memory", "taste_profile.json")

    _append_jsonl_line(episodes_path, episode)

    profile = _read_json_dict(profile_path)
    profile.setdefault("version", 1)
    profile["updatedAt"] = now

    topics = profile.get("topics")
    if not isinstance(topics, dict):
        topics = {}
        profile["topics"] = topics

    ups = profile.get("ups")
    if not isinstance(ups, dict):
        ups = {}
        profile["ups"] = ups

    muted_topics = _extract_muted_list(profile, "mutedTopics", "muted_topics")
    muted_ups = _extract_muted_list(profile, "mutedUps", "muted_ups")

    if clean_kind == "up_impression" and clean_subject:
        raw_entry = ups.get(clean_subject)
        entry = dict(raw_entry) if isinstance(raw_entry, dict) else {"affinity": _safe_float(raw_entry, 0.0)}
        new_aff = round(_safe_float(entry.get("affinity", entry.get("score", 0.0))) + aff_delta, 3)
        entry["affinity"] = new_aff
        entry["muted"] = bool(entry.get("muted", False)) and new_aff <= 0
        if not entry["muted"] and clean_subject in muted_ups:
            muted_ups = [u for u in muted_ups if u != clean_subject]
        entry["updatedAt"] = now
        entry["notes"] = _append_note(entry.get("notes") or [], clean_content)
        ups[clean_subject] = entry

    elif clean_kind == "topic_interest" and clean_subject:
        boost = aff_delta if aff_delta != 0.0 else 1.0
        raw_entry = topics.get(clean_subject)
        entry = dict(raw_entry) if isinstance(raw_entry, dict) else {"weight": _safe_float(raw_entry, 0.0)}
        new_weight = round(_safe_float(entry.get("weight", entry.get("score", 0.0))) + boost, 3)
        entry["weight"] = new_weight
        entry["score"] = new_weight
        entry["muted"] = False
        if clean_subject in muted_topics and boost > 0:
            muted_topics = [t for t in muted_topics if t != clean_subject]
        entry["updatedAt"] = now
        entry["notes"] = _append_note(entry.get("notes") or [], clean_content)
        topics[clean_subject] = entry

    elif clean_kind == "dislike" and clean_subject:
        lower_tags = {t.lower() for t in clean_tags}
        is_up = (
            "up" in lower_tags
            or clean_subject in ups
            or clean_subject.lower().startswith("up:")
        )
        if is_up:
            up_name = re.sub(r"^[Uu][Pp]\s*[:：]\s*", "", clean_subject).strip() or clean_subject
            raw_entry = ups.get(up_name)
            entry = dict(raw_entry) if isinstance(raw_entry, dict) else {"affinity": _safe_float(raw_entry, 0.0)}
            delta = aff_delta if aff_delta < 0 else -1.0
            entry["affinity"] = round(_safe_float(entry.get("affinity", entry.get("score", 0.0))) + delta, 3)
            entry["muted"] = True
            entry["updatedAt"] = now
            entry["notes"] = _append_note(entry.get("notes") or [], clean_content)
            ups[up_name] = entry
            if up_name not in muted_ups:
                muted_ups.append(up_name)
        else:
            raw_entry = topics.get(clean_subject)
            entry = dict(raw_entry) if isinstance(raw_entry, dict) else {"weight": _safe_float(raw_entry, 0.0)}
            delta = aff_delta if aff_delta < 0 else -1.0
            new_weight = round(_safe_float(entry.get("weight", entry.get("score", 0.0))) + delta, 3)
            entry["weight"] = new_weight
            entry["score"] = new_weight
            entry["muted"] = True
            entry["updatedAt"] = now
            entry["notes"] = _append_note(entry.get("notes") or [], clean_content)
            topics[clean_subject] = entry
            if clean_subject not in muted_topics:
                muted_topics.append(clean_subject)

    elif clean_kind == "thread":
        threads = profile.get("openThreads")
        if not isinstance(threads, list):
            threads = []
        threads.append({"at": now, "subject": clean_subject, "content": clean_content})
        profile["openThreads"] = threads[-30:]

    elif clean_kind == "observation":
        observations = profile.get("observations")
        if not isinstance(observations, list):
            observations = []
        observations.append({"at": now, "subject": clean_subject, "content": clean_content})
        profile["observations"] = observations[-30:]

    profile["mutedTopics"] = muted_topics
    profile["mutedUps"] = muted_ups
    _atomic_write_text(profile_path, json.dumps(profile, ensure_ascii=False, indent=2) + "\n")

    return {
        "ok": True,
        "kind": clean_kind,
        "subject": clean_subject,
        "episode": episode,
    }


def append_dm_history(
    duty_home: Path,
    uid: int,
    direction: str,
    text: str,
    bvids: list[str] | None = None,
) -> dict[str, Any]:
    """Append a DM event record ``{at, day, uid, direction, text, bvids}`` to ``dm-history.jsonl``."""
    history_path = _safe_subpath(duty_home, "dm-history.jsonl")
    clean_text = str(text or "")
    if bvids is None:
        bvid_list = sorted(set(BVID_EXTRACT_RE.findall(clean_text)))
    else:
        bvid_list = _clean_tags([str(b).strip() for b in bvids])

    now = _now_iso()
    entry = {
        "at": now,
        "day": now[:10],
        "uid": int(uid),
        "direction": str(direction or "out").strip() or "out",
        "text": clean_text,
        "bvids": bvid_list,
    }
    _append_jsonl_line(history_path, entry)
    return entry
