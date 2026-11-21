"""Сведения из интернета: MusicBrainz, Cover Art Archive, Википедия / Викиданные, AcoustID.

Всё выключено по умолчанию и включается в «Админка → Общие». Файлы с музыкой не меняются:
найденное хранится в БД (album_meta, artist_meta, track_match) и в DATA_DIR/meta.

Что делает фоновый поток (по одному объекту за раз, с паузами — правила MusicBrainz: не чаще 1 запроса в секунду):
- альбомы: MBID релиза из тегов (если файлы размечены Picard) → иначе поиск по названию и исполнителю →
  иначе (если указан ключ AcoustID) распознавание нескольких треков по звуку. Найденный релиз даёт обложку
  (если своей у альбома нет), год и жанр (только если их нет в тегах);
- исполнители: MusicBrainz (MBID — из найденного альбома или поиском по имени) → Викиданные →
  биография из Википедии на выбранном языке и фото с Викисклада;
- треки без тегов (исполнитель неизвестен): название и исполнитель по звуку через AcoustID.

Свои обложки и теги всегда главнее найденного.
"""
from __future__ import annotations

import io
import json
import logging
import os
import re
import shutil
import subprocess
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timedelta, timezone
from difflib import SequenceMatcher
from pathlib import Path

from PIL import Image, ImageOps
from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from . import db as dbmod
from .app_settings import get_setting, set_setting
from .config import COVER_CACHE, META_DIR, VERSION
from .models import Album, AlbumMeta, Artist, ArtistMeta, Library, Track, TrackMatch

log = logging.getLogger("uvicorn.error")

USER_AGENT = f"SelfMusic/{VERSION} ( https://github.com/kozhevyatov/selfmusic )"
MB_API = "https://musicbrainz.org/ws/2"
CAA = "https://coverartarchive.org"
ACOUSTID_API = "https://api.acoustid.org/v2/lookup"

COVERS_DIR = META_DIR / "covers"
ARTISTS_DIR = META_DIR / "artists"

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
RETRY_NOTFOUND = timedelta(days=30)
RETRY_ERROR = timedelta(days=1)
FOUND = ("found", "manual")

# имена, которые искать бессмысленно (см. scanner.VARIOUS / UNKNOWN_ARTIST, books.UNKNOWN_AUTHOR)
VARIOUS = "Разные исполнители"
SKIP_ARTISTS = {"разные исполнители", "неизвестный исполнитель", "неизвестный автор", "various artists", "unknown artist"}
SKIP_ALBUMS = {"без альбома"}

# ---------------- настройки ----------------

DEFAULTS = {
    "meta_enabled": "0",
    "meta_covers": "1",  # обложки для альбомов без своей
    "meta_artists": "1",  # биографии и фото исполнителей
    "meta_fill": "1",  # год и жанр, если их нет в тегах
    "meta_lang": "ru",  # язык Википедии
    "meta_acoustid_key": "",  # ключ приложения AcoustID (бесплатно на acoustid.org)
}
LANGS = ("ru", "en", "uk", "be", "kk", "de", "fr", "es", "it", "pl")


def config(db: Session) -> dict:
    def flag(key: str) -> bool:
        return (get_setting(db, key) or DEFAULTS[key]) == "1"

    lang = get_setting(db, "meta_lang") or DEFAULTS["meta_lang"]
    return {
        "enabled": flag("meta_enabled"),
        "covers": flag("meta_covers"),
        "artists": flag("meta_artists"),
        "fill": flag("meta_fill"),
        "lang": lang if lang in LANGS else "ru",
        "acoustid_key": (get_setting(db, "meta_acoustid_key") or "").strip(),
        "fpcalc": bool(shutil.which("fpcalc")),
    }


def save_config(db: Session, data: dict) -> None:
    for key in ("enabled", "covers", "artists", "fill"):
        if data.get(key) is not None:
            set_setting(db, f"meta_{key}", "1" if data[key] else "0")
    if data.get("lang") in LANGS:
        set_setting(db, "meta_lang", data["lang"])
    if data.get("acoustid_key") is not None:
        set_setting(db, "meta_acoustid_key", str(data["acoustid_key"]).strip()[:64])


# ---------------- сеть ----------------


class NetError(Exception):
    """Сервис недоступен или ответил ошибкой — объект не помечаем, повторим позже."""


class NotFound(Exception):
    pass


class _Limiter:
    def __init__(self, interval: float) -> None:
        self.interval = interval
        self._lock = threading.Lock()
        self._last = 0.0

    def wait(self) -> None:
        with self._lock:
            delay = self._last + self.interval - time.monotonic()
            if delay > 0:
                time.sleep(delay)
            self._last = time.monotonic()


_mb_limit = _Limiter(1.1)  # MusicBrainz: не чаще раза в секунду с одного адреса
_acoustid_limit = _Limiter(0.4)  # AcoustID: до 3 запросов в секунду
_wiki_limit = _Limiter(0.2)


def http_get(url: str, *, data: bytes | None = None, accept: str = "application/json", timeout: float = 25,
             max_bytes: int = 20 * 1024 * 1024) -> bytes:
    headers = {"User-Agent": USER_AGENT, "Accept": accept}
    if data is not None:
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    req = urllib.request.Request(url, data=data, headers=headers)
    host = urllib.parse.urlsplit(url).hostname or url
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 — адреса только наши, https
            body = resp.read(max_bytes + 1)
    except urllib.error.HTTPError as exc:
        if exc.code in (404, 410):
            raise NotFound(url) from exc
        raise NetError(f"{host}: HTTP {exc.code}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        reason = getattr(exc, "reason", exc)
        raise NetError(f"{host}: {reason}") from exc
    if len(body) > max_bytes:
        raise NetError(f"{host}: слишком большой ответ")
    return body


def http_json(url: str, limiter: _Limiter, *, data: bytes | None = None, retries: int = 2) -> dict:
    for attempt in range(retries + 1):
        limiter.wait()
        try:
            return json.loads(http_get(url, data=data))
        except NetError as exc:
            # 503 у MusicBrainz — «слишком часто»: подождём и повторим
            if attempt < retries and ("HTTP 503" in str(exc) or "HTTP 429" in str(exc) or "timed out" in str(exc)):
                time.sleep(2 + attempt * 3)
                continue
            raise
        except ValueError as exc:
            raise NetError(f"{urllib.parse.urlsplit(url).hostname}: не JSON") from exc
    raise NetError("unreachable")


def mb_get(path: str, **params) -> dict:  # noqa: ANN003
    params["fmt"] = "json"
    return http_json(f"{MB_API}/{path}?{urllib.parse.urlencode(params)}", _mb_limit)


# ---------------- сравнение названий ----------------

_BRACKETS = re.compile(r"\s*[\(\[\{][^\)\]\}]*[\)\]\}]")
_NOT_WORD = re.compile(r"[^\w]+", re.UNICODE)


def norm(text: str, strip_brackets: bool = True) -> str:
    s = unicodedata.normalize("NFKC", text or "").lower().replace("ё", "е")
    if strip_brackets:
        stripped = _BRACKETS.sub("", s)
        s = stripped if stripped.strip() else s  # «(Без названия)» целиком в скобках — оставляем
    s = s.replace("&", " and ").replace(" и ", " and ")
    s = re.sub(r"^the\s+", "", s.strip())
    return _NOT_WORD.sub(" ", s).strip()


def similar(a: str, b: str) -> float:
    na, nb = norm(a), norm(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    if na.replace(" ", "") == nb.replace(" ", ""):
        return 0.98
    return SequenceMatcher(None, na, nb).ratio()


def lucene(text: str) -> str:
    return '"' + (text or "").replace("\\", "\\\\").replace('"', '\\"') + '"'


def _year(date: str | None) -> int | None:
    m = re.match(r"^(\d{4})", date or "")
    year = int(m.group(1)) if m else None
    return year if year and 1000 < year < 2200 else None


def _credit(credits: list | None) -> tuple[str, list[dict]]:
    """artist-credit MusicBrainz → «A feat. B» и список исполнителей [{id, name}]."""
    name, artists = "", []
    for c in credits or []:
        if isinstance(c, str):
            name += c
            continue
        name += (c.get("name") or c.get("artist", {}).get("name") or "") + (c.get("joinphrase") or "")
        if c.get("artist", {}).get("id"):
            artists.append({"id": c["artist"]["id"], "name": c["artist"].get("name", "")})
    return name.strip(), artists


# ---------------- MusicBrainz: релизы ----------------


def release_brief(r: dict) -> dict:
    artist, artists = _credit(r.get("artist-credit"))
    media = r.get("media") or []
    tracks = r.get("track-count") or sum(int(m.get("track-count") or 0) for m in media)
    formats = Counter(m.get("format") or "" for m in media if m.get("format"))
    rg = r.get("release-group") or {}
    return {
        "id": r.get("id"),
        "title": r.get("title") or "",
        "artist": artist,
        "artists": artists,
        "date": r.get("date") or "",
        "year": _year(r.get("date")),
        "country": r.get("country") or "",
        "status": r.get("status") or "",
        "track_count": int(tracks or 0),
        "media": " + ".join(f"{n}×{f}" if n > 1 else f for f, n in formats.items()),
        "release_group": rg.get("id"),
        "type": rg.get("primary-type") or "",
        "score": int(r.get("score") or 0),
        "disambiguation": r.get("disambiguation") or "",
    }


def search_releases(title: str, artist: str = "", limit: int = 15) -> list[dict]:
    # «Альбом (Deluxe Edition) [2019]» — ищем без приписок в скобках, сравнение потом тоже без них
    title = _BRACKETS.sub("", title).strip() or title
    query = f"release:{lucene(title)}"
    if artist and norm(artist) not in SKIP_ARTISTS:
        query += f" AND artist:{lucene(artist)}"
    data = mb_get("release", query=query, limit=limit)
    return [release_brief(r) for r in data.get("releases") or [] if r.get("id")]


def pick_release(cands: list[dict], album: dict) -> dict | None:
    """Лучший релиз для альбома: название и исполнитель должны совпасть, дальше — число треков и год."""
    various = norm(album["artist"]) in SKIP_ARTISTS
    best, best_pts = None, 0.0
    for c in cands:
        ts = similar(c["title"], album["name"])
        if ts < 0.88:
            continue
        if various:
            # у сборников сверяем только название — значит, число треков должно почти совпасть
            if album["track_count"] and abs(c["track_count"] - album["track_count"]) > 1:
                continue
            ars = 1.0
        else:
            ars = max([similar(c["artist"], album["artist"])] + [similar(a["name"], album["artist"]) for a in c["artists"]])
            if ars < 0.85:
                continue
        pts = c["score"] / 100 + ts + ars
        if album["track_count"] and c["track_count"]:
            diff = abs(c["track_count"] - album["track_count"])
            pts += 1.0 if diff == 0 else 0.3 if diff <= 2 else -0.6
        if album["year"] and c["year"]:
            pts += 0.5 if c["year"] == album["year"] else 0
        if c["status"] == "Official":
            pts += 0.3
        if pts > best_pts:
            best, best_pts = c, pts
    return best


def release_details(release_id: str) -> dict:
    r = mb_get(f"release/{release_id}", inc="artist-credits release-groups genres media")
    brief = release_brief(r)
    rg = r.get("release-group") or {}
    genres = r.get("genres") or []
    if not genres and rg.get("id"):
        try:
            genres = mb_get(f"release-group/{rg['id']}", inc="genres").get("genres") or []
        except NotFound:
            genres = []
    genres = sorted(genres, key=lambda g: -int(g.get("count") or 0))
    brief["genre"] = _genre_name(genres[0]["name"]) if genres else ""
    brief["year"] = _year(rg.get("first-release-date")) or brief["year"]
    return brief


def _genre_name(name: str) -> str:
    # жанры MusicBrainz в нижнем регистре: «hip hop» → «Hip Hop»
    return " ".join(w if any(ch.isupper() for ch in w) else w[:1].upper() + w[1:] for w in name.split())[:128]


def fetch_release_cover(release_id: str, release_group: str | None) -> bytes | None:
    urls = [f"{CAA}/release/{release_id}/front-1200"]
    if release_group:
        urls.append(f"{CAA}/release-group/{release_group}/front-1200")
    for url in urls:
        try:
            _wiki_limit.wait()
            return http_get(url, accept="image/*", timeout=60)
        except NotFound:
            continue
    return None


# ---------------- MusicBrainz: исполнители ----------------


def artist_brief(a: dict) -> dict:
    life = a.get("life-span") or {}
    begin, end = _year(life.get("begin")), _year(life.get("end"))
    return {
        "id": a.get("id"),
        "name": a.get("name") or "",
        "sort_name": a.get("sort-name") or "",
        "disambiguation": a.get("disambiguation") or "",
        "country": a.get("country") or "",
        "type": a.get("type") or "",
        "life_span": f"{begin or '?'}–{end}" if end else (f"с {begin}" if begin else ""),
        "score": int(a.get("score") or 0),
        "aliases": [x.get("name") or "" for x in a.get("aliases") or []],
    }


def search_artists(name: str, limit: int = 10) -> list[dict]:
    data = mb_get("artist", query=f"artist:{lucene(name)} OR alias:{lucene(name)}", limit=limit)
    return [artist_brief(a) for a in data.get("artists") or [] if a.get("id")]


def pick_artist(cands: list[dict], name: str) -> dict | None:
    exact = [c for c in cands if c["score"] >= 90 and max([similar(c["name"], name)] + [similar(x, name) for x in c["aliases"]]) >= 0.97]
    return exact[0] if exact else None


def artist_details(mbid: str, lang: str) -> dict:
    a = mb_get(f"artist/{mbid}", inc="url-rels genres aliases")
    info = artist_brief(a)
    genres = sorted(a.get("genres") or [], key=lambda g: -int(g.get("count") or 0))
    info["genres"] = ", ".join(_genre_name(g["name"]) for g in genres[:3])
    wikidata, wikipedia = None, None
    for rel in a.get("relations") or []:
        url = (rel.get("url") or {}).get("resource") or ""
        if rel.get("type") == "wikidata":
            wikidata = url.rstrip("/").rsplit("/", 1)[-1]
        elif rel.get("type") == "wikipedia":
            wikipedia = url
    info.update(bio="", bio_lang="", bio_url="", image=None, image_source="")
    sitelinks, image_name = {}, None
    if wikidata and re.match(r"^Q\d+$", wikidata):
        try:
            entity = http_json(f"https://www.wikidata.org/wiki/Special:EntityData/{wikidata}.json", _wiki_limit)
            ent = (entity.get("entities") or {}).get(wikidata) or {}
            sitelinks = {k: v.get("title") for k, v in (ent.get("sitelinks") or {}).items()}
            p18 = ((ent.get("claims") or {}).get("P18") or [])
            if p18:
                image_name = ((p18[0].get("mainsnak") or {}).get("datavalue") or {}).get("value")
        except NotFound:
            pass
    # биография: выбранный язык → английский → ссылка на Википедию прямо из MusicBrainz
    pages: list[tuple[str, str]] = []
    for code in dict.fromkeys((lang, "en")):
        if sitelinks.get(f"{code}wiki"):
            pages.append((code, sitelinks[f"{code}wiki"]))
    if not pages and wikipedia:
        m = re.match(r"https?://(\w+)\.wikipedia\.org/wiki/(.+)$", wikipedia)
        if m:
            pages.append((m.group(1), urllib.parse.unquote(m.group(2))))
    for code, title in pages:
        try:
            s = http_json(
                f"https://{code}.wikipedia.org/api/rest_v1/page/summary/{urllib.parse.quote(title.replace(' ', '_'), safe='')}",
                _wiki_limit,
            )
        except NotFound:
            continue
        if s.get("type") == "disambiguation" or not s.get("extract"):
            continue
        info.update(
            bio=s["extract"].strip(),
            bio_lang=code,
            bio_url=((s.get("content_urls") or {}).get("desktop") or {}).get("page") or f"https://{code}.wikipedia.org/wiki/{title}",
        )
        break
    if image_name:
        fname = image_name.replace(" ", "_")
        try:
            _wiki_limit.wait()
            info["image"] = http_get(
                f"https://commons.wikimedia.org/wiki/Special:FilePath/{urllib.parse.quote(fname)}?width=1000",
                accept="image/*",
                timeout=60,
            )
            info["image_source"] = f"https://commons.wikimedia.org/wiki/File:{urllib.parse.quote(fname)}"
        except NotFound:
            pass
    return info


# ---------------- AcoustID ----------------


def _low_priority() -> None:
    try:
        os.nice(19)
    except OSError:
        pass


def fingerprint(path: str) -> tuple[float, str] | None:
    exe = shutil.which("fpcalc")
    if not exe:
        return None
    cmd = [exe, "-json", "-length", "120", path]
    if shutil.which("ionice"):
        cmd = ["ionice", "-c3", *cmd]
    try:
        out = subprocess.run(cmd, capture_output=True, timeout=180, preexec_fn=_low_priority, check=False).stdout
        data = json.loads(out or b"{}")
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return None
    if not data.get("fingerprint"):
        return None
    return float(data.get("duration") or 0), data["fingerprint"]


def acoustid_lookup(key: str, path: str) -> list[dict]:
    fp = fingerprint(path)
    if fp is None:
        return []
    duration, print_ = fp
    body = urllib.parse.urlencode(
        {"client": key, "meta": "recordings releasegroups", "duration": int(duration), "fingerprint": print_, "format": "json"}
    ).encode()
    data = http_json(ACOUSTID_API, _acoustid_limit, data=body)
    if data.get("status") != "ok":
        msg = (data.get("error") or {}).get("message") or "ошибка"
        raise NetError(f"AcoustID: {msg}")
    return data.get("results") or []


def acoustid_recording(key: str, path: str) -> dict | None:
    """Самая вероятная запись: {id, title, artist, score}."""
    for res in sorted(acoustid_lookup(key, path), key=lambda r: -float(r.get("score") or 0)):
        score = float(res.get("score") or 0)
        if score < 0.8:
            break
        for rec in res.get("recordings") or []:
            if rec.get("title") and rec.get("artists"):
                artist, _ = _credit(rec["artists"])
                return {"id": rec.get("id"), "title": rec["title"], "artist": artist, "score": score}
    return None


def acoustid_release(key: str, paths: list[str], track_count: int) -> str | None:
    """Релиз альбома по нескольким трекам: голосуем за группу релизов, потом подбираем релиз по числу треков."""
    votes: Counter = Counter()
    for path in paths:
        seen = set()
        for res in acoustid_lookup(key, path):
            score = float(res.get("score") or 0)
            if score < 0.7:
                continue
            for rec in res.get("recordings") or []:
                for rg in rec.get("releasegroups") or []:
                    if rg.get("id") and rg["id"] not in seen and rg.get("type") in (None, "Album", "EP", "Single"):
                        seen.add(rg["id"])
                        votes[rg["id"]] += score
    if not votes:
        return None
    rg_id, pts = votes.most_common(1)[0]
    if len(paths) > 1 and pts < 1.2:  # совпал только один трек из нескольких — ненадёжно
        return None
    releases = [release_brief(r) for r in mb_get("release", **{"release-group": rg_id, "inc": "media", "limit": 50}).get("releases") or []]
    if not releases:
        return None
    releases.sort(key=lambda r: (abs(r["track_count"] - track_count) if track_count else 0, r["status"] != "Official", r["date"] or "9999"))
    return releases[0]["id"]


# ---------------- MBID из тегов ----------------


def _first_text(value) -> str:  # noqa: ANN001
    if hasattr(value, "text"):
        value = value.text
    if isinstance(value, (list, tuple)):
        value = value[0] if value else ""
    if isinstance(value, bytes):
        value = value.decode("utf-8", "ignore")
    return str(value).strip().lower()


def tag_ids(path: str) -> dict:
    """MBID релиза и исполнителя альбома из тегов (Picard и др.)."""
    import mutagen  # noqa: PLC0415

    out: dict = {}
    try:
        audio = mutagen.File(path)
    except Exception:  # noqa: BLE001
        return out
    tags = getattr(audio, "tags", None)
    if not tags:
        return out
    try:
        keys = list(tags.keys())
    except Exception:  # noqa: BLE001
        return out
    for key in keys:
        k = str(key).lower().replace("_", " ")
        if "musicbrainz" not in k:
            continue
        try:
            value = _first_text(tags[key])
        except Exception:  # noqa: BLE001
            continue
        if not UUID_RE.match(value):
            continue
        if k.endswith("album id") or k.endswith("albumid"):
            out.setdefault("release", value)
        elif "album artist id" in k or "albumartistid" in k:
            out.setdefault("artist", value)
    return out


# ---------------- файлы ----------------


def _save_image(data: bytes, target: Path, max_side: int) -> bool:
    try:
        img = Image.open(io.BytesIO(data))
        img.draft("RGB", (max_side * 2, max_side * 2))
        img = ImageOps.exif_transpose(img).convert("RGB")
        img.thumbnail((max_side, max_side), Image.LANCZOS)
    except Exception:  # noqa: BLE001
        return False
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(".tmp")
    try:
        img.save(tmp, "JPEG", quality=90)
        tmp.replace(target)
    except OSError:
        tmp.unlink(missing_ok=True)
        return False
    return True


def _remove_files(folder: Path, prefix: str, keep: str | None = None) -> None:
    for old in folder.glob(f"{prefix}*"):
        if old.name != keep:
            old.unlink(missing_ok=True)
    if prefix.startswith("ar"):  # уменьшенные копии фото исполнителя
        for old in COVER_CACHE.glob(f"{prefix}*"):
            old.unlink(missing_ok=True)


def artist_image_path(meta: ArtistMeta, size: int) -> Path | None:
    """Квадратная уменьшенная копия фото исполнителя (WebP, в кэше обложек)."""
    if not meta.image_file:
        return None
    src = ARTISTS_DIR / meta.image_file
    if not src.is_file():
        return None
    for step in (64, 128, 256, 400, 600, 900):
        if size <= step:
            size = step
            break
    else:
        size = 900
    stamp = int(meta.checked_at.timestamp()) if meta.checked_at else 0
    cached = COVER_CACHE / f"ar{meta.artist_id}-{size}-{stamp}.webp"
    if cached.exists():
        return cached
    try:
        img = Image.open(src).convert("RGB")
        img = ImageOps.fit(img, (size, size), Image.LANCZOS, centering=(0.5, 0.3))  # лица обычно в верхней части
        COVER_CACHE.mkdir(parents=True, exist_ok=True)
        tmp = cached.with_name(cached.name + f".{threading.get_ident()}.tmp")
        img.save(tmp, "WEBP", quality=86, method=4)
        tmp.replace(cached)
    except Exception:  # noqa: BLE001
        return None
    return cached


def artist_image_url(meta: ArtistMeta | None) -> str | None:
    if meta is None or not meta.image_file:
        return None
    stamp = int(meta.checked_at.timestamp()) if meta.checked_at else 0
    return f"/api/cover/artist/{meta.artist_id}?v={stamp}"


def artist_images(db: Session, ids) -> dict[int, str]:  # noqa: ANN001
    ids = list(ids)
    if not ids:
        return {}
    rows = db.scalars(select(ArtistMeta).where(ArtistMeta.artist_id.in_(ids), ArtistMeta.image_file.is_not(None)))
    return {m.artist_id: artist_image_url(m) for m in rows}


# ---------------- применение найденного ----------------


def _index_lock():  # noqa: ANN202
    from .scanner import index_lock  # noqa: PLC0415 — циклический импорт

    return index_lock


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _track_values(tracks: list[Track]) -> tuple[int | None, str]:
    years = Counter(t.year for t in tracks if t.year)
    genres = Counter(t.genre for t in tracks if t.genre)
    return (years.most_common(1)[0][0] if years else None), (genres.most_common(1)[0][0] if genres else "")


def fill_album(db: Session, album: Album, cfg: dict | None = None) -> None:
    """Год и жанр из MusicBrainz — только если их нет в тегах (вызывается и сканером)."""
    if album.year is not None and album.genre:
        return
    meta = db.get(AlbumMeta, album.id)
    if meta is None or meta.status not in FOUND:
        return
    cfg = cfg or config(db)
    if not (cfg["enabled"] and cfg["fill"]):
        return
    if album.year is None and meta.year:
        album.year = meta.year
    if not album.genre and meta.genre:
        album.genre = meta.genre


def apply_album(album_id: int, rel: dict | None, *, source: str, status: str, cover: bytes | None = None,
                error: str | None = None, artist_hint: str | None = None) -> None:
    with _index_lock(), dbmod.session_scope() as db:
        album = db.get(Album, album_id)
        if album is None:
            return
        cfg = config(db)
        meta = db.get(AlbumMeta, album_id) or AlbumMeta(album_id=album_id)
        meta.status, meta.source, meta.error, meta.checked_at = status, source, error, utcnow()
        if rel is None:
            meta.release_mbid = meta.release_group_mbid = meta.artist_mbid = None
            meta.title = meta.artist = meta.genre = ""
            meta.year = None
        else:
            meta.release_mbid = rel["id"]
            meta.release_group_mbid = rel.get("release_group")
            meta.artist_mbid = rel["artists"][0]["id"] if len(rel.get("artists") or []) == 1 else None
            meta.title, meta.artist = rel["title"][:512], rel["artist"][:512]
            meta.year, meta.genre = rel.get("year"), rel.get("genre", "")[:128]
        if cover:
            name = f"al{album_id}-{rel['id'][:8]}.jpg" if rel else None
            if name and _save_image(cover, COVERS_DIR / name, 1200):
                _remove_files(COVERS_DIR, f"al{album_id}-", keep=name)
                meta.cover_file = name
                if not album.cover or album.cover.startswith("meta:"):
                    album.cover = "meta:" + name
                    album.updated_at = utcnow()
        elif rel is None or status in ("ignored", "manual"):
            # вручную выбран релиз без обложки — старая найденная обложка от другого релиза не нужна
            _drop_album_cover(album, meta)
        db.merge(meta)
        if status in FOUND:
            fill_album(db, album, cfg)
            hint = artist_hint or meta.artist_mbid
            if hint and album.artist_id:
                am = db.get(ArtistMeta, album.artist_id)
                if am is None or (am.status in ("notfound", "error") and am.source != "manual"):
                    am = am or ArtistMeta(artist_id=album.artist_id)
                    am.status, am.source, am.mbid, am.checked_at = "pending", "album", hint, utcnow()
                    db.merge(am)
        else:
            year, genre = _track_values(list(db.scalars(select(Track).where(Track.album_id == album_id))))
            album.year, album.genre = year, genre
        db.commit()


def _drop_album_cover(album: Album, meta: AlbumMeta) -> None:
    if album.cover and album.cover.startswith("meta:"):
        album.cover = None
        album.updated_at = utcnow()
    if meta.cover_file:
        (COVERS_DIR / meta.cover_file).unlink(missing_ok=True)
        meta.cover_file = None


def apply_artist(artist_id: int, info: dict | None, *, source: str, status: str, error: str | None = None) -> None:
    with dbmod.session_scope() as db:
        if db.get(Artist, artist_id) is None:
            return
        meta = db.get(ArtistMeta, artist_id) or ArtistMeta(artist_id=artist_id)
        meta.status, meta.source, meta.error, meta.checked_at = status, source, error, utcnow()
        info = info or {}
        meta.mbid = info.get("id")
        meta.mb_name = (info.get("name") or "")[:512]
        meta.disambiguation = (info.get("disambiguation") or "")[:512]
        meta.country = (info.get("country") or "")[:8]
        meta.life_span = (info.get("life_span") or "")[:64]
        meta.genres = (info.get("genres") or "")[:512]
        meta.bio = info.get("bio") or ""
        meta.bio_lang = info.get("bio_lang") or ""
        meta.bio_url = (info.get("bio_url") or "")[:1024]
        name = None
        if info.get("image"):
            name = f"ar{artist_id}-{int(time.time())}.jpg"
            if not _save_image(info["image"], ARTISTS_DIR / name, 1000):
                name = None
        _remove_files(ARTISTS_DIR, f"ar{artist_id}-", keep=name)
        meta.image_file = name
        meta.image_source = (info.get("image_source") or "")[:1024] if name else ""
        db.merge(meta)
        db.commit()


# ---------------- поиск: альбом, исполнитель, трек ----------------


def album_info(db: Session, album_id: int) -> dict | None:
    album = db.get(Album, album_id)
    if album is None:
        return None
    lib = db.get(Library, album.library_id)
    tracks = list(
        db.scalars(select(Track).where(Track.album_id == album_id).order_by(func.coalesce(Track.disc_no, 1), Track.track_no, Track.id))
    )
    return {
        "id": album.id,
        "name": album.name,
        "artist": album.artist_name,
        "year": album.year,
        "track_count": len(tracks),
        "has_cover": bool(album.cover) and not album.cover.startswith("meta:"),
        "paths": [os.path.join(lib.path, t.path) for t in tracks] if lib else [],
    }


def find_album_release(info: dict, cfg: dict) -> tuple[str, str] | None:
    """(источник, MBID релиза) или None."""
    if info["paths"]:
        rid = tag_ids(info["paths"][0]).get("release")
        if rid:
            return "tags", rid
    if norm(info["name"]) not in SKIP_ALBUMS:
        best = pick_release(search_releases(info["name"], info["artist"]), info)
        if best:
            return "search", best["id"]
    if cfg["acoustid_key"] and cfg["fpcalc"] and info["paths"]:
        paths = info["paths"]
        sample = [paths[i] for i in sorted({0, len(paths) // 2, len(paths) - 1})][:3]
        rid = acoustid_release(cfg["acoustid_key"], sample, info["track_count"])
        if rid:
            return "acoustid", rid
    return None


def refresh_album(album_id: int, *, release_id: str | None = None, manual: bool = False) -> str:
    """Найти (или применить выбранный вручную) релиз альбома. Возвращает итоговый статус."""
    with dbmod.session_scope() as db:
        cfg = config(db)
        info = album_info(db, album_id)
    if info is None:
        return "gone"
    try:
        if release_id:
            found = ("manual", release_id)
        else:
            found = find_album_release(info, cfg)
        if found is None:
            apply_album(album_id, None, source="", status="notfound")
            return "notfound"
        source, rid = found
        rel = release_details(rid)
        cover = None
        if cfg["covers"] and (manual or not info["has_cover"]):
            cover = fetch_release_cover(rel["id"], rel.get("release_group"))
        hint = None
        if info["paths"] and source == "tags":
            hint = tag_ids(info["paths"][0]).get("artist")
        status = "manual" if manual else "found"
        apply_album(album_id, rel, source=source, status=status, cover=cover, artist_hint=hint)
        return status
    except NotFound:
        if manual:
            raise
        # MBID из тегов устарел (релиз объединили или удалили) — считаем, что не нашли
        apply_album(album_id, None, source="", status="notfound", error="Релиз не найден в MusicBrainz")
        return "notfound"
    except NetError:
        raise
    except Exception as exc:  # noqa: BLE001
        log.exception("Сведения об альбоме %s", album_id)
        apply_album(album_id, None, source="", status="error", error=str(exc)[:255] or exc.__class__.__name__)
        return "error"


def refresh_artist(artist_id: int, *, mbid: str | None = None, manual: bool = False) -> str:
    with dbmod.session_scope() as db:
        cfg = config(db)
        artist = db.get(Artist, artist_id)
        if artist is None:
            return "gone"
        name = artist.name
        meta = db.get(ArtistMeta, artist_id)
        known = meta.mbid if meta is not None and meta.status in ("pending", "found", "manual") else None
    try:
        source = "manual" if mbid else ("album" if known else "search")
        mbid = mbid or known
        if not mbid:
            best = pick_artist(search_artists(name), name)
            if best is None:
                apply_artist(artist_id, None, source="", status="notfound")
                return "notfound"
            mbid = best["id"]
        info = artist_details(mbid, cfg["lang"])
        status = "manual" if manual else "found"
        apply_artist(artist_id, info, source=source, status=status)
        return status
    except (NotFound, NetError):
        raise
    except Exception as exc:  # noqa: BLE001
        log.exception("Сведения об исполнителе %s", artist_id)
        apply_artist(artist_id, None, source="", status="error", error=str(exc)[:255] or exc.__class__.__name__)
        return "error"


def refresh_track(track_id: int) -> str:
    from .scanner import UNKNOWN_ARTIST, finalize_album, get_or_create_artist  # noqa: PLC0415

    with dbmod.session_scope() as db:
        cfg = config(db)
        track = db.get(Track, track_id)
        lib = db.get(Library, track.library_id) if track else None
        if track is None or lib is None:
            return "gone"
        path = os.path.join(lib.path, track.path)
    if not cfg["acoustid_key"] or not cfg["fpcalc"]:
        return "skipped"
    try:
        rec = acoustid_recording(cfg["acoustid_key"], path)
    except NetError:
        raise
    except Exception as exc:  # noqa: BLE001
        rec, err = None, str(exc)[:255]
    else:
        err = None
    with _index_lock(), dbmod.session_scope() as db:
        track = db.get(Track, track_id)
        if track is None:
            return "gone"
        m = db.get(TrackMatch, track_id) or TrackMatch(track_id=track_id)
        m.checked_at, m.error = utcnow(), err
        if rec:
            m.status, m.recording_mbid, m.title, m.artist, m.score = "found", rec["id"], rec["title"][:512], rec["artist"][:512], rec["score"]
            if track.artist_name == UNKNOWN_ARTIST:
                track.title = m.title
                track.artist_name = m.artist
                track.artist_id = get_or_create_artist(db, m.artist)
                lib = db.get(Library, track.library_id)
                db.flush()
                finalize_album(db, track.album_id, Path(lib.path), False, {})
        else:
            m.status = "error" if err else "notfound"
        db.merge(m)
        db.commit()
        return m.status


def track_suggestion(db: Session, track_id: int) -> tuple[str, str] | None:
    """Для сканера: название и исполнитель трека без тегов, узнанного по звуку."""
    m = db.get(TrackMatch, track_id)
    if m is None or m.status != "found" or not m.title:
        return None
    return m.title, m.artist


# ---------------- фоновый поток ----------------


def _music_libs():  # noqa: ANN202
    return select(Library.id).where(Library.enabled.is_(True), Library.kind == "music")


def _stale(model, now: datetime):  # noqa: ANN001, ANN202
    return or_(
        and_(model.status == "notfound", model.checked_at < now - RETRY_NOTFOUND),
        and_(model.status == "error", model.checked_at < now - RETRY_ERROR),
    )


def next_album(db: Session, now: datetime) -> int | None:
    return db.scalar(
        select(Album.id)
        .outerjoin(AlbumMeta, AlbumMeta.album_id == Album.id)
        .where(Album.library_id.in_(_music_libs()), or_(AlbumMeta.album_id.is_(None), _stale(AlbumMeta, now)))
        .order_by(AlbumMeta.album_id.is_not(None), Album.id.desc())
        .limit(1)
    )


def next_artist(db: Session, now: datetime) -> int | None:
    has_music = select(Album.artist_id).where(Album.library_id.in_(_music_libs()), Album.artist_id.is_not(None))
    return db.scalar(
        select(Artist.id)
        .outerjoin(ArtistMeta, ArtistMeta.artist_id == Artist.id)
        .where(
            Artist.id.in_(has_music),
            func.lower(Artist.name).not_in(SKIP_ARTISTS),
            or_(ArtistMeta.artist_id.is_(None), ArtistMeta.status == "pending", _stale(ArtistMeta, now)),
        )
        .order_by(func.coalesce(ArtistMeta.status, "") != "pending", ArtistMeta.artist_id.is_not(None), Artist.id.desc())
        .limit(1)
    )


def next_track(db: Session, now: datetime) -> int | None:
    from .scanner import UNKNOWN_ARTIST  # noqa: PLC0415

    return db.scalar(
        select(Track.id)
        .outerjoin(TrackMatch, TrackMatch.track_id == Track.id)
        .where(
            Track.library_id.in_(_music_libs()),
            Track.artist_name == UNKNOWN_ARTIST,
            or_(TrackMatch.track_id.is_(None), _stale(TrackMatch, now)),
        )
        .order_by(Track.id.desc())
        .limit(1)
    )


class MetaWorker:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._wake = threading.Event()
        self._offline_until = 0.0
        self.state: dict = {"running": False, "current": None, "done_session": 0, "last_error": None, "paused_reason": ""}

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        COVERS_DIR.mkdir(parents=True, exist_ok=True)
        ARTISTS_DIR.mkdir(parents=True, exist_ok=True)
        self._thread = threading.Thread(target=self._loop, daemon=True, name="metadata")
        self._thread.start()

    def wake(self) -> None:
        self._offline_until = 0
        self._wake.set()

    def _set(self, **kw) -> None:  # noqa: ANN003
        with self._lock:
            self.state.update(kw)

    def status(self) -> dict:
        with dbmod.session_scope() as db:
            cfg = config(db)
            key = cfg.pop("acoustid_key")
            music = _music_libs()
            albums_total = db.scalar(select(func.count()).select_from(Album).where(Album.library_id.in_(music))) or 0
            artists_total = db.scalar(
                select(func.count(func.distinct(Album.artist_id))).where(Album.library_id.in_(music), Album.artist_id.is_not(None))
            ) or 0

            def counts(model, key_col):  # noqa: ANN001, ANN202
                rows = db.execute(select(model.status, func.count(key_col)).group_by(model.status)).all()
                return {s: n for s, n in rows}

            al = counts(AlbumMeta, AlbumMeta.album_id)
            ar = counts(ArtistMeta, ArtistMeta.artist_id)
            tr = counts(TrackMatch, TrackMatch.track_id)
            from .scanner import UNKNOWN_ARTIST  # noqa: PLC0415

            untagged = db.scalar(
                select(func.count()).select_from(Track).where(Track.library_id.in_(music), Track.artist_name == UNKNOWN_ARTIST)
            ) or 0
            covers = db.scalar(select(func.count()).select_from(Album).where(Album.cover.like("meta:%"))) or 0
            bios = db.scalar(select(func.count()).select_from(ArtistMeta).where(ArtistMeta.bio != "")) or 0
            photos = db.scalar(select(func.count()).select_from(ArtistMeta).where(ArtistMeta.image_file.is_not(None))) or 0
        with self._lock:
            st = dict(self.state)
        return {
            **st,
            **cfg,
            "acoustid_key": key,
            "album_stats": {"total": albums_total, "found": al.get("found", 0) + al.get("manual", 0), "notfound": al.get("notfound", 0),
                       "error": al.get("error", 0), "ignored": al.get("ignored", 0), "covers": covers},
            "artist_stats": {"total": artists_total, "found": ar.get("found", 0) + ar.get("manual", 0), "notfound": ar.get("notfound", 0),
                        "error": ar.get("error", 0), "bios": bios, "photos": photos},
            "track_stats": {"untagged": untagged, "found": tr.get("found", 0), "notfound": tr.get("notfound", 0)},
        }

    def retry(self, failed_only: bool = True) -> None:
        """«Проверить заново»: ненайденное и ошибки — в очередь (найденное вручную не трогаем)."""
        old = datetime(2000, 1, 1, tzinfo=timezone.utc)
        with dbmod.session_scope() as db:
            for model in (AlbumMeta, ArtistMeta, TrackMatch):
                cond = model.status.in_(("notfound", "error")) if failed_only else model.status.in_(("notfound", "error", "found"))
                for row in db.scalars(select(model).where(cond)):
                    if row.status == "found":
                        row.status = "notfound"
                    row.checked_at = old
            db.commit()
        self.wake()

    def _loop(self) -> None:
        try:
            os.setpriority(os.PRIO_PROCESS, threading.get_native_id(), 10)
        except (OSError, AttributeError):
            pass
        time.sleep(30)
        last_cleanup = 0.0
        while True:
            worked = False
            try:
                worked = self._tick()
                if time.time() - last_cleanup > 6 * 3600:
                    last_cleanup = time.time()
                    self._cleanup()
            except NetError as exc:
                # сети нет или сервис недоступен — объект не помечаем, пробуем позже
                self._offline_until = time.time() + 600
                self._set(running=False, current=None, paused_reason=f"Нет связи: {exc}. Повтор через 10 минут", last_error=str(exc))
            except Exception:  # noqa: BLE001
                log.exception("Сведения из интернета")
            self._wake.wait(0.2 if worked else 60)
            self._wake.clear()

    def _tick(self) -> bool:
        if not dbmod.is_configured():
            return False
        if time.time() < self._offline_until:
            return False
        from .scanner import scanner  # noqa: PLC0415

        with dbmod.session_scope() as db:
            cfg = config(db)
            if not cfg["enabled"]:
                self._set(running=False, current=None, paused_reason="Выключено")
                return False
            if scanner.status().get("running"):
                self._set(running=False, paused_reason="Ждёт окончания сканирования")
                return False
            now = utcnow()
            job = None
            album_id = next_album(db, now)
            if album_id:
                a = db.get(Album, album_id)
                job = ("album", album_id, f"Альбом: {a.artist_name} — {a.name}")
            elif cfg["artists"] and (artist_id := next_artist(db, now)):
                job = ("artist", artist_id, f"Исполнитель: {db.get(Artist, artist_id).name}")
            elif cfg["acoustid_key"] and cfg["fpcalc"] and (track_id := next_track(db, now)):
                t = db.get(Track, track_id)
                job = ("track", track_id, f"Трек по звуку: {t.path.rsplit('/', 1)[-1]}")
        if job is None:
            self._set(running=False, current=None, paused_reason="Всё проверено")
            return False
        kind, item_id, label = job
        self._set(running=True, current=label, paused_reason="")
        if kind == "album":
            result = refresh_album(item_id)
        elif kind == "artist":
            try:
                result = refresh_artist(item_id)
            except NotFound:  # MBID из тегов устарел (объединили в MusicBrainz) — ищем по имени
                with dbmod.session_scope() as db:
                    m = db.get(ArtistMeta, item_id)
                    if m is not None:
                        m.status, m.mbid = "notfound", None
                        db.commit()
                result = refresh_artist(item_id)
        else:
            result = refresh_track(item_id)
        with self._lock:
            self.state["done_session"] += 1
            if result == "error":
                self.state["last_error"] = label
        return True

    def _cleanup(self) -> None:
        """Файлы обложек и фото, на которые больше ничего не ссылается (альбом удалён и т.п.)."""
        with dbmod.session_scope() as db:
            covers = set(db.scalars(select(AlbumMeta.cover_file).where(AlbumMeta.cover_file.is_not(None))))
            photos = set(db.scalars(select(ArtistMeta.image_file).where(ArtistMeta.image_file.is_not(None))))
        for folder, used in ((COVERS_DIR, covers), (ARTISTS_DIR, photos)):
            if not folder.is_dir():
                continue
            for f in folder.iterdir():
                if f.is_file() and f.name not in used and time.time() - f.stat().st_mtime > 3600:
                    f.unlink(missing_ok=True)


worker = MetaWorker()
dbmod.on_ready(worker.start)
