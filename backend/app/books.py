"""Аудиокниги: как из папок и тегов получить автора, серию, номер в серии, чтеца и главы.

Соглашения те же, что у Audiobookshelf (самый распространённый self-hosted сервер аудиокниг),
чтобы готовые библиотеки подхватывались без переименований:

    Автор / Серия / Книга / файлы…      (или Автор / Книга, или просто Книга)

Имя папки книги:  «1 - Название», «1. Название», «Название - Vol. 2», «Book 3 - Название»,
                  «1994 - Название», «Vol 1 - 1994 - Название», «Название {Чтец}», «… [ASIN]».
Рядом можно положить desc.txt (описание) и reader.txt (чтец). Подпапки Disc 1 / CD 2 — части одной книги.
Главы: у одного большого файла (m4b, mp3 с CHAP) — из самого файла через ffprobe;
у книги из многих файлов каждый файл — глава.
"""
from __future__ import annotations

import json
import logging
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

import mutagen

from .config import settings
from .tags import fix_encoding

log = logging.getLogger("uvicorn.error")

UNKNOWN_AUTHOR = "Неизвестный автор"

_NARRATOR = re.compile(r"\s*\{([^}]+)\}\s*")
_ASIN = re.compile(r"\s*\[[A-Z0-9]{10}\]\s*")
_LEAD_SEQ = re.compile(r"^\s*(?:(?:vol(?:ume)?\.?|book|книга|том|часть|ч\.)\s*)?(\d+(?:[.,]\d+)?)\s*(?:-|\.|–|—)\s+(.+)$", re.I)
_TAIL_SEQ = re.compile(r"^(.+?)\s*(?:-|–|—|,)\s*(?:vol(?:ume)?\.?|book|книга|том|часть|ч\.)\s*(\d+(?:[.,]\d+)?)\s*$", re.I)
_MID_SEQ = re.compile(r"^(?:vol(?:ume)?\.?|book|книга|том|часть)\s*(\d+(?:[.,]\d+)?)\s*(?:-|–|—)\s*(.+)$", re.I)
_YEAR = re.compile(r"^\s*\(?((?:19|20)\d{2})\)?\s*(?:-|–|—)\s+(.+)$")
_NUM = re.compile(r"(\d+)")


@dataclass
class ParsedFolder:
    title: str
    seq: float | None = None
    year: int | None = None
    narrator: str = ""


def parse_book_folder(name: str) -> ParsedFolder:
    """«Vol 1 - 1994 - Хоббит {Иванов} [B00…]» → title=Хоббит, seq=1, year=1994, narrator=Иванов."""
    narrator = ""
    m = _NARRATOR.search(name)
    if m:
        narrator = m.group(1).strip()
        name = _NARRATOR.sub(" ", name)
    name = _ASIN.sub(" ", name).strip()
    seq: float | None = None
    year: int | None = None
    for rx in (_MID_SEQ, _LEAD_SEQ):
        m = rx.match(name)
        if m:
            seq = float(m.group(1).replace(",", "."))
            name = m.group(2).strip()
            break
    if seq is None:
        m = _TAIL_SEQ.match(name)
        if m:
            name, seq = m.group(1).strip(), float(m.group(2).replace(",", "."))
    m = _YEAR.match(name)
    if m:
        year, name = int(m.group(1)), m.group(2).strip()
    # «1994 - Название» не путаем с номером 1994 в серии
    if seq is not None and seq >= 1900 and year is None:
        year, seq = int(seq), None
    return ParsedFolder(title=name.strip(" -–—.") or name, seq=seq, year=year, narrator=narrator)


def natural_key(text: str) -> list:
    """«Глава 2» раньше «Глава 10»."""
    return [int(p) if p.isdigit() else p.lower() for p in _NUM.split(text)]


def read_text_file(folder: Path, names: tuple[str, ...], limit: int = 20000) -> str:
    for n in names:
        p = folder / n
        if p.is_file():
            try:
                return p.read_text("utf-8", errors="replace").strip()[:limit]
            except OSError:
                return ""
    return ""


# Ключи тегов, которые пишут программы для аудиокниг (Audible, mp3tag, Audiobookshelf, Picard)
_TAG_KEYS = {
    "narrator": ["TXXX:NARRATOR", "TXXX:narrator", "narrator", "NARRATOR", "©nrt", "----:com.apple.iTunes:NARRATOR", "TCOM", "composer", "©wrt"],
    "series": ["TXXX:SERIES", "TXXX:series", "series", "SERIES", "TXXX:MVNM", "MVNM", "©mvn", "----:com.apple.iTunes:SERIES", "TIT1", "©grp"],
    "series_seq": ["TXXX:SERIES-PART", "TXXX:SERIES_PART", "series-part", "seriespart", "TXXX:MVIN", "MVIN", "©mvi", "----:com.apple.iTunes:SERIES-PART"],
    "description": ["TXXX:DESCRIPTION", "description", "DESCRIPTION", "desc", "©des", "ldes", "COMM", "comment", "©cmt"],
    "subtitle": ["TIT3", "TXXX:SUBTITLE", "subtitle", "SUBTITLE", "----:com.apple.iTunes:SUBTITLE"],
    "author": ["TPE2", "albumartist", "album artist", "aART", "TPE1", "artist", "©ART"],
}


def _as_text(v) -> str:  # noqa: ANN001
    if v is None:
        return ""
    if hasattr(v, "text"):  # фрейм ID3
        v = v.text
    if isinstance(v, (list, tuple)):
        v = v[0] if v else ""
        if isinstance(v, tuple):  # MP4: (номер, всего)
            v = v[0]
    if isinstance(v, bytes):
        v = v.decode("utf-8", "replace")
    return fix_encoding(str(v).strip())


def _first(tags, keys: list[str]) -> str:  # noqa: ANN001
    if tags is None:
        return ""
    is_id3 = hasattr(tags, "getall")
    lower = {}
    if not is_id3:
        try:
            lower = {str(k).lower(): k for k in tags.keys()}
        except Exception:  # noqa: BLE001
            lower = {}
    for key in keys:
        try:
            if is_id3:
                frames = tags.getall(key)
                text = _as_text(frames[0]) if frames else ""
            else:
                real = key if key in tags else lower.get(key.lower())
                text = _as_text(tags[real]) if real is not None else ""
        except Exception:  # noqa: BLE001
            text = ""
        if text:
            return text
    return ""


def book_tags(path: Path) -> dict:
    try:
        audio = mutagen.File(path)
    except Exception:  # noqa: BLE001
        return {}
    tags = getattr(audio, "tags", None)
    out = {k: _first(tags, keys) for k, keys in _TAG_KEYS.items()}
    try:
        out["series_seq"] = float(re.sub(r"[^\d.,]", "", out["series_seq"]).replace(",", ".")) if out["series_seq"] else None
    except ValueError:
        out["series_seq"] = None
    return out


def _ffprobe() -> str:
    """ffprobe рядом с ffmpeg, иначе из PATH."""
    sibling = Path(settings.ffmpeg).with_name("ffprobe")
    if sibling.is_file():
        return str(sibling)
    return shutil.which("ffprobe") or "ffprobe"


def file_chapters(path: Path) -> list[dict]:
    """Главы внутри файла (m4b/m4a/mp3 с CHAP) — через ffprobe. [{"title", "start", "end"}]"""
    ffprobe = _ffprobe()
    try:
        out = subprocess.run(
            [ffprobe, "-v", "error", "-print_format", "json", "-show_chapters", str(path)],
            capture_output=True,
            timeout=60,
            check=False,
        ).stdout
        data = json.loads(out or b"{}")
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return []
    chapters = []
    for i, ch in enumerate(data.get("chapters", []), 1):
        try:
            start, end = float(ch["start_time"]), float(ch["end_time"])
        except (KeyError, ValueError):
            continue
        title = fix_encoding(str((ch.get("tags") or {}).get("title") or f"Глава {i}")).strip()
        chapters.append({"title": title[:300], "start": round(start, 3), "end": round(end, 3)})
    return chapters if len(chapters) > 1 else []


def split_path(rel_folder: str) -> tuple[str, str, str]:
    """Папка книги относительно корня → (автор, серия, имя папки книги) по схеме Автор/Серия/Книга."""
    parts = [p for p in rel_folder.split("/") if p]
    if not parts:
        return "", "", ""
    book = parts[-1]
    if len(parts) >= 3:
        return parts[-3], parts[-2], book
    if len(parts) == 2:
        return parts[0], "", book
    return "", "", book
