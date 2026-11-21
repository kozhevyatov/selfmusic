"""Subsonic / OpenSubsonic API (/rest/*).

С ним работают готовые приложения: Symfonium, Tempo, DSub (Android), Amperfy, play:Sub,
Substreamer (iOS), Feishin, Sonixd (десктоп) и др.

Авторизация: u + p (пароль приложения или основной пароль) либо u + t + s,
где t = md5(пароль_приложения + s). Пароль приложения задаётся в профиле.
Права на папки соблюдаются так же, как в вебе.
"""
from __future__ import annotations

import hashlib
import json
import re

import secrets
import threading
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from typing import Any, Callable

from fastapi import APIRouter, Request
from fastapi.responses import Response
from sqlalchemy import delete, desc, func, select
from sqlalchemy.orm import Session

from .. import db as dbmod
from .. import mixes, ratelimit, smart
from ..access import allowed_library_ids
from ..config import VERSION
from ..media import content_type, cover_path, file_response, image_response, placeholder_cover, stream_track, track_file
from ..models import Album, Artist, Bookmark, Library, Play, Playlist, PlaylistEntry, PlaylistMember, PlayQueue, Rating, Star, Track, User
from ..queries import album_list_query, album_tracks, artists_with_counts, genres, search_tracks, top_tracks, tracks_query
from ..scanner import scanner
from ..security import decrypt_secret, verify_password

router = APIRouter(tags=["subsonic"])

API_VERSION = "1.16.1"
IGNORED_ARTICLES = "The El La Los Las Le Les"


class SubsonicError(Exception):
    def __init__(self, code: int, message: str) -> None:
        self.code = code
        self.message = message


# ---------------- параметры и ответы ----------------


class Params:
    def __init__(self, items: list[tuple[str, str]]) -> None:
        self._items = items

    def get(self, name: str, default: str | None = None) -> str | None:
        for k, v in self._items:
            if k == name:
                return v
        return default

    def req(self, name: str) -> str:
        value = self.get(name)
        if value is None or value == "":
            raise SubsonicError(10, f"Не указан обязательный параметр: {name}")
        return value

    def all(self, name: str) -> list[str]:
        return [v for k, v in self._items if k == name]

    def int(self, name: str, default: int | None = None, lo: int | None = None, hi: int | None = None) -> int | None:
        raw = self.get(name)
        if raw is None or raw == "":
            return default
        try:
            value = int(float(raw))
        except ValueError:
            raise SubsonicError(0, f"Неверное значение параметра {name}")
        if lo is not None:
            value = max(lo, value)
        if hi is not None:
            value = min(hi, value)
        return value

    def bool(self, name: str, default: bool = False) -> bool:
        raw = self.get(name)
        if raw is None:
            return default
        return raw.lower() in ("true", "1", "yes")


def _base(status: str = "ok") -> dict:
    return {
        "status": status,
        "version": API_VERSION,
        "type": "selfmusic",
        "serverVersion": VERSION,
        "openSubsonic": True,
    }


# Управляющие символы из тегов недопустимы в XML 1.0 — один такой символ ломал бы весь ответ
_XML_BAD = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]")


def _xml_value(v: Any) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, datetime):
        return _iso(v)
    return _XML_BAD.sub("", str(v))


def _to_xml(parent: ET.Element, data: dict) -> None:
    for key, value in data.items():
        if value is None:
            continue
        if key == "value" and not isinstance(value, (dict, list)):
            parent.text = _xml_value(value)  # текст элемента (например, текст песни)
        elif isinstance(value, dict):
            _to_xml(ET.SubElement(parent, key), value)
        elif isinstance(value, list):
            for item in value:
                if isinstance(item, dict):
                    _to_xml(ET.SubElement(parent, key), item)
                else:
                    ET.SubElement(parent, key).text = _xml_value(item)
        else:
            parent.set(key, _xml_value(value))


def render(params: Params, payload: dict, status: str = "ok") -> Response:
    body = {**_base(status), **payload}
    fmt = (params.get("f") or "xml").lower()
    if fmt in ("json", "jsonp"):
        data = json.dumps({"subsonic-response": body}, ensure_ascii=False, default=_json_default)
        callback = params.get("callback")
        if fmt == "jsonp" and callback and callback.replace("_", "").replace(".", "").isalnum():
            return Response(f"{callback}({data});", media_type="application/javascript")
        return Response(data, media_type="application/json")
    root = ET.Element("subsonic-response", {"xmlns": "http://subsonic.org/restapi"})
    _to_xml(root, body)
    xml = b'<?xml version="1.0" encoding="UTF-8"?>' + ET.tostring(root, encoding="utf-8")
    return Response(xml, media_type="application/xml")


def _json_default(v: Any) -> Any:
    if isinstance(v, datetime):
        return _iso(v)
    raise TypeError


def _iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


# ---------------- идентификаторы ----------------
# Строковые id с префиксом: ar-1, al-1, tr-1, pl-1 — чтобы getMusicDirectory и getCoverArt
# понимали, о чём речь. Для совместимости принимаем и «голые» числа.


def _parse_id(value: str, default_kind: str = "tr") -> tuple[str, int]:
    kind, sep, num = value.partition("-")
    if not sep:
        kind, num = default_kind, value
    try:
        return kind, int(num)
    except ValueError:
        raise SubsonicError(70, "Объект не найден")


# ---------------- контекст запроса ----------------


class Ctx:
    def __init__(self, db: Session, user: User, params: Params, request: Request) -> None:
        self.db = db
        self.user = user
        self.p = params
        self.request = request
        self._libs: list[int] | None = None
        self._all_libs: list[int] | None = None
        self._plain_libs: list[int] | None = None

    def libs(self, folder: int | None = None) -> list[int]:
        """Без выбора папки — только музыка (книги не мешаются в альбомах, поиске, случайных).
        Если приложение явно выбрало папку (musicFolderId) — в том числе папку аудиокниг."""
        if self._libs is None:
            self._libs = allowed_library_ids(self.db, self.user)
        if folder is not None:
            return [i for i in self.all_libs() if i == folder]
        return self._libs

    def plain_libs(self) -> list[int]:
        """Музыка без учёта «Вся / Общая / Моя» — для плейлистов и очереди."""
        if self._plain_libs is None:
            self._plain_libs = allowed_library_ids(self.db, self.user, scoped=False)
        return self._plain_libs

    def all_libs(self) -> list[int]:
        if self._all_libs is None:
            self._all_libs = allowed_library_ids(self.db, self.user, kind="any")
        return self._all_libs

    def folder(self) -> list[int]:
        return self.libs(self.p.int("musicFolderId"))

    def stars(self, kind: str, ids: list[int]) -> dict[int, datetime]:
        if not ids:
            return {}
        rows = self.db.execute(
            select(Star.item_id, Star.created_at).where(
                Star.user_id == self.user.id, Star.kind == kind, Star.item_id.in_(ids)
            )
        )
        return dict(rows.all())

    def ratings(self, kind: str, ids: list[int]) -> dict[int, int]:
        if not ids:
            return {}
        rows = self.db.execute(
            select(Rating.item_id, Rating.rating).where(
                Rating.user_id == self.user.id, Rating.kind == kind, Rating.item_id.in_(ids)
            )
        )
        return dict(rows.all())

    def play_counts(self, ids: list[int]) -> dict[int, tuple[int, datetime]]:
        if not ids:
            return {}
        rows = self.db.execute(
            select(Play.track_id, func.count(Play.id), func.max(Play.played_at))
            .where(Play.user_id == self.user.id, Play.track_id.in_(ids))
            .group_by(Play.track_id)
        )
        return {r[0]: (r[1], r[2]) for r in rows}

    # ---------- представления ----------

    def songs(self, tracks: list[Track]) -> list[dict]:
        ids = [t.id for t in tracks]
        stars = self.stars("track", ids)
        ratings = self.ratings("track", ids)
        plays = self.play_counts(ids)
        return [self.song(t, stars, ratings, plays) for t in tracks]

    def song(self, t: Track, stars: dict, ratings: dict, plays: dict) -> dict:
        album = t.album
        cnt, last = plays.get(t.id, (0, None))
        data = {
            "id": f"tr-{t.id}",
            "parent": f"al-{t.album_id}",
            "isDir": False,
            "title": t.title,
            "album": album.name if album else "",
            "artist": t.artist_name,
            "track": t.track_no,
            "discNumber": t.disc_no,
            "year": t.year,
            "genre": t.genre or None,
            "coverArt": f"al-{t.album_id}",
            "size": t.size,
            "contentType": content_type(t.suffix),
            "suffix": t.suffix,
            "duration": int(round(t.duration)),
            "bitRate": t.bitrate,
            "samplingRate": t.sample_rate or None,
            "bitDepth": t.bit_depth or None,
            "channelCount": t.channels or None,
            "path": t.path,
            "albumId": f"al-{t.album_id}",
            "artistId": f"ar-{t.artist_id}" if t.artist_id else None,
            "type": "music",
            "mediaType": "song",
            "isVideo": False,
            "created": _iso(t.created_at),
            "playCount": cnt,
            "played": _iso(last) if last else None,
            "starred": _iso(stars[t.id]) if t.id in stars else None,
            "userRating": ratings.get(t.id),
            "displayArtist": t.artist_name,
            "displayAlbumArtist": album.artist_name if album else None,
            "sortName": t.title,
            "genres": [{"name": t.genre}] if t.genre else [],
            "artists": [{"id": f"ar-{t.artist_id}", "name": t.artist_name}] if t.artist_id else [],
            "albumArtists": [{"id": f"ar-{album.artist_id}", "name": album.artist_name}] if album and album.artist_id else [],
            "musicBrainzId": "",
            "replayGain": {},
        }
        return data

    def albums(self, albums: list[Album], legacy: bool = False) -> list[dict]:
        ids = [a.id for a in albums]
        stars = self.stars("album", ids)
        ratings = self.ratings("album", ids)
        plays = {}
        if ids:
            rows = self.db.execute(
                select(Play.album_id, func.count(Play.id), func.max(Play.played_at))
                .where(Play.user_id == self.user.id, Play.album_id.in_(ids))
                .group_by(Play.album_id)
            )
            plays = {r[0]: (r[1], r[2]) for r in rows}
        return [self.album(a, stars, ratings, plays, legacy) for a in albums]

    def album(self, a: Album, stars: dict, ratings: dict, plays: dict, legacy: bool = False) -> dict:
        cnt, last = plays.get(a.id, (0, None))
        data = {
            "id": f"al-{a.id}",
            "name": a.name,
            "title": a.name,
            "album": a.name,
            "artist": a.artist_name,
            "artistId": f"ar-{a.artist_id}" if a.artist_id else None,
            "coverArt": f"al-{a.id}",
            "songCount": a.track_count,
            "duration": a.duration,
            "playCount": cnt,
            "played": _iso(last) if last else None,
            "created": _iso(a.created_at),
            "year": a.year,
            "genre": a.genre or None,
            "starred": _iso(stars[a.id]) if a.id in stars else None,
            "userRating": ratings.get(a.id),
            "isDir": True,
            "parent": f"ar-{a.artist_id}" if a.artist_id else None,
            "sortName": a.sort_name,
            "genres": [{"name": a.genre}] if a.genre else [],
            "artists": [{"id": f"ar-{a.artist_id}", "name": a.artist_name}] if a.artist_id else [],
            "displayArtist": a.artist_name,
            "musicBrainzId": "",
            "isCompilation": a.artist_name == "Разные исполнители",
            "discTitles": [],
            "recordLabels": [],
            "releaseTypes": [],
        }
        return data

    def artists(self, rows: list[tuple]) -> list[dict]:
        stars = self.stars("artist", [r[0].id for r in rows])
        return [
            {
                "id": f"ar-{artist.id}",
                "name": artist.name,
                "albumCount": count,
                "coverArt": f"ar-{artist.id}",
                "artistImageUrl": None,
                "starred": _iso(stars[artist.id]) if artist.id in stars else None,
                "sortName": artist.sort_name,
                "musicBrainzId": "",
                "roles": ["albumartist"],
            }
            for artist, count, _cover in rows
        ]

    def visible_track(self, raw_id: str) -> Track:
        _, tid = _parse_id(raw_id, "tr")
        track = self.db.get(Track, tid)
        if not track or track.library_id not in self.all_libs():
            raise SubsonicError(70, "Трек не найден")
        return track

    def visible_album(self, raw_id: str) -> Album:
        _, aid = _parse_id(raw_id, "al")
        album = self.db.get(Album, aid)
        if not album or album.library_id not in self.all_libs():
            raise SubsonicError(70, "Альбом не найден")
        return album


# ---------------- авторизация ----------------


# Клиент с основным паролем (p=) присылает его в каждом запросе — и на каждую обложку.
# Argon2 намеренно тяжёлый (~64 МБ памяти и десятки мс на проверку), на NAS сетка из
# 50 обложек превратилась бы в 50 одновременных хешей. Удачную проверку запоминаем
# на 10 минут; в ключе — хеш пароля из базы, так что смена пароля сбрасывает кэш.
_verified: dict[str, float] = {}
_verified_lock = threading.Lock()
VERIFY_TTL = 600


def _main_password_ok(user: User, password: str) -> bool:
    key = hashlib.sha256(f"{user.id}\0{user.password_hash}\0{password}".encode()).hexdigest()
    now = time.monotonic()
    with _verified_lock:
        if _verified.get(key, 0) > now:
            return True
    if not verify_password(password, user.password_hash):
        return False
    with _verified_lock:
        if len(_verified) > 1000:
            for k in [k for k, exp in _verified.items() if exp <= now] or list(_verified)[:500]:
                _verified.pop(k, None)
        _verified[key] = now + VERIFY_TTL
    return True


def _authenticate(db: Session, p: Params, request: Request) -> User:
    username = p.get("u")
    if not username:
        raise SubsonicError(10, "Не указан пользователь")
    ip = request.client.host if request.client else "?"
    try:
        ratelimit.check(username, ip)
    except ratelimit.TooManyAttempts:
        raise SubsonicError(40, "Слишком много неудачных попыток, попробуйте позже")
    user = db.scalar(select(User).where(User.username == username))
    ok = False
    if user and user.is_active:
        app_password = decrypt_secret(user.subsonic_password)
        token, salt, password = p.get("t"), p.get("s"), p.get("p")
        if token and salt:
            if app_password:
                expected = hashlib.md5((app_password + salt).encode()).hexdigest()
                ok = secrets.compare_digest(expected, token.lower())
        elif password is not None:
            if password.startswith("enc:"):
                try:
                    password = bytes.fromhex(password[4:]).decode("utf-8")
                except ValueError:
                    password = ""
            ok = (bool(app_password) and secrets.compare_digest(app_password, password)) or _main_password_ok(
                user, password
            )
        elif p.get("apiKey"):
            raise SubsonicError(42, "Авторизация по apiKey не поддерживается")
    if not ok:
        ratelimit.fail(username, ip)
        raise SubsonicError(40, "Неверный логин или пароль")
    ratelimit.success(username, ip)
    return user


# ---------------- методы ----------------

Handler = Callable[[Ctx], Any]
HANDLERS: dict[str, Handler] = {}


def method(*names: str):
    def deco(fn: Handler) -> Handler:
        for name in names:
            HANDLERS[name.lower()] = fn
        return fn

    return deco


@method("ping")
def ping(c: Ctx) -> dict:
    return {}


@method("getLicense")
def get_license(c: Ctx) -> dict:
    return {"license": {"valid": True, "email": c.user.email, "licenseExpires": "2099-12-31T00:00:00.000Z"}}


@method("getOpenSubsonicExtensions")
def extensions(c: Ctx) -> dict:
    return {
        "openSubsonicExtensions": [
            {"name": "formPost", "versions": [1]},
            {"name": "transcodeOffset", "versions": [1]},
            {"name": "songLyrics", "versions": [1]},
        ]
    }


@method("getMusicFolders")
def music_folders(c: Ctx) -> dict:
    libs = c.db.scalars(select(Library).where(Library.id.in_(c.all_libs() or [-1])).order_by(Library.name))
    return {"musicFolders": {"musicFolder": [{"id": lib.id, "name": lib.name} for lib in libs]}}


def _index(c: Ctx, rows: list[tuple]) -> list[dict]:
    groups: dict[str, list] = {}
    for row in rows:
        name = (row[0].sort_name or row[0].name).strip()
        letter = name[:1].upper() if name else "#"
        if not letter.isalpha():
            letter = "#"
        groups.setdefault(letter, []).append(row)
    return [{"name": k, "artist": c.artists(v)} for k, v in sorted(groups.items(), key=lambda kv: (kv[0] == "#", kv[0]))]


@method("getIndexes")
def get_indexes(c: Ctx) -> dict:
    rows = artists_with_counts(c.db, c.folder())
    last = c.db.scalar(select(func.max(Library.last_scan_at)))
    return {
        "indexes": {
            "lastModified": int(last.timestamp() * 1000) if last else 0,
            "ignoredArticles": IGNORED_ARTICLES,
            "index": _index(c, rows),
        }
    }


@method("getArtists")
def get_artists(c: Ctx) -> dict:
    rows = artists_with_counts(c.db, c.folder())
    return {"artists": {"ignoredArticles": IGNORED_ARTICLES, "index": _index(c, rows)}}


def _artist_albums(c: Ctx, artist_id: int) -> list[Album]:
    # открытый исполнитель — как на сайте: без учёта «Вся / Общая / Моя»
    return list(c.db.scalars(album_list_query(c.plain_libs(), c.user.id, "year", artist_id=artist_id)))


@method("getArtist")
def get_artist(c: Ctx) -> dict:
    _, aid = _parse_id(c.p.req("id"), "ar")
    rows = artists_with_counts(c.db, c.plain_libs(), only_ids=[aid])
    if not rows:
        raise SubsonicError(70, "Исполнитель не найден")
    data = c.artists(rows)[0]
    data["album"] = c.albums(_artist_albums(c, aid))
    return {"artist": data}


@method("getAlbum")
def get_album(c: Ctx) -> dict:
    album = c.visible_album(c.p.req("id"))
    data = c.albums([album])[0]
    data["song"] = c.songs(album_tracks(c.db, album.id))
    return {"album": data}


@method("getSong")
def get_song(c: Ctx) -> dict:
    return {"song": c.songs([c.visible_track(c.p.req("id"))])[0]}


@method("getMusicDirectory")
def get_music_directory(c: Ctx) -> dict:
    raw = c.p.req("id")
    kind, num = _parse_id(raw, "al")
    if kind == "ar":
        rows = artists_with_counts(c.db, c.plain_libs(), only_ids=[num])
        if not rows:
            raise SubsonicError(70, "Не найдено")
        albums = _artist_albums(c, num)
        children = c.albums(albums)
        for ch in children:
            ch["title"] = ch["name"]
        return {"directory": {"id": raw, "name": rows[0][0].name, "child": children}}
    if kind == "al":
        album = c.visible_album(raw)
        return {
            "directory": {
                "id": raw,
                "name": album.name,
                "parent": f"ar-{album.artist_id}" if album.artist_id else None,
                "child": c.songs(album_tracks(c.db, album.id)),
            }
        }
    raise SubsonicError(70, "Не найдено")


ALBUM_LIST_TYPES = {
    "random", "newest", "highest", "frequent", "recent", "alphabeticalByName",
    "alphabeticalByArtist", "starred", "byYear", "byGenre",
}


def _album_list(c: Ctx) -> list[dict]:
    kind = c.p.req("type")
    if kind not in ALBUM_LIST_TYPES:
        raise SubsonicError(0, f"Неизвестный тип списка: {kind}")
    size = c.p.int("size", 10, 1, 500)
    offset = c.p.int("offset", 0, 0)
    libs = c.folder()
    if kind == "byYear":
        query = album_list_query(
            libs, c.user.id, kind, from_year=c.p.int("fromYear", 0), to_year=c.p.int("toYear", 9999)
        )
    elif kind == "byGenre":
        query = album_list_query(libs, c.user.id, "newest", genre=c.p.req("genre"))
    else:
        query = album_list_query(libs, c.user.id, kind)
    return c.albums(list(c.db.scalars(query.offset(offset).limit(size))))


@method("getAlbumList")
def get_album_list(c: Ctx) -> dict:
    items = _album_list(c)
    for it in items:
        it["title"] = it["name"]
    return {"albumList": {"album": items}}


@method("getAlbumList2")
def get_album_list2(c: Ctx) -> dict:
    return {"albumList2": {"album": _album_list(c)}}


@method("getRandomSongs")
def get_random_songs(c: Ctx) -> dict:
    size = c.p.int("size", 10, 1, 500)
    query = tracks_query(c.folder())
    if genre := c.p.get("genre"):
        query = query.where(Track.genre == genre)
    if (fy := c.p.int("fromYear")) is not None:
        query = query.where(Track.year >= fy)
    if (ty := c.p.int("toYear")) is not None:
        query = query.where(Track.year <= ty)
    tracks = list(c.db.scalars(query.order_by(func.random()).limit(size)))
    return {"randomSongs": {"song": c.songs(tracks)}}


@method("getSongsByGenre")
def get_songs_by_genre(c: Ctx) -> dict:
    count = c.p.int("count", 10, 1, 500)
    offset = c.p.int("offset", 0, 0)
    query = tracks_query(c.folder()).where(Track.genre == c.p.req("genre")).order_by(Track.album_id, Track.track_no)
    return {"songsByGenre": {"song": c.songs(list(c.db.scalars(query.offset(offset).limit(count))))}}


@method("getGenres")
def get_genres(c: Ctx) -> dict:
    return {
        "genres": {
            "genre": [{"value": g, "songCount": t, "albumCount": a} for g, t, a in genres(c.db, c.libs())]
        }
    }


def _search(c: Ctx) -> dict:
    q = (c.p.get("query") or "").strip().strip('"').strip()
    libs = c.folder()
    a_count, a_off = c.p.int("artistCount", 20, 0, 500), c.p.int("artistOffset", 0, 0)
    al_count, al_off = c.p.int("albumCount", 20, 0, 500), c.p.int("albumOffset", 0, 0)
    s_count, s_off = c.p.int("songCount", 20, 0, 5000), c.p.int("songOffset", 0, 0)
    # Пустой запрос — «вся медиатека постранично»: так её синхронизируют Symfonium и др.
    q = "" if q in ("*", "") else q
    artists = artists_with_counts(c.db, libs, q)[a_off : a_off + a_count] if a_count else []
    albums_q = album_list_query(libs, c.user.id, "name", q=q)
    albums = list(c.db.scalars(albums_q.offset(al_off).limit(al_count))) if al_count else []
    songs = search_tracks(c.db, libs, q, s_count, s_off) if s_count else []
    return {"artist": c.artists(artists), "album": c.albums(albums), "song": c.songs(songs)}


@method("search2")
def search2(c: Ctx) -> dict:
    return {"searchResult2": _search(c)}


@method("search3")
def search3(c: Ctx) -> dict:
    return {"searchResult3": _search(c)}


@method("search")
def search_legacy(c: Ctx) -> dict:
    q = c.p.get("any") or c.p.get("title") or c.p.get("album") or c.p.get("artist") or ""
    count = c.p.int("count", 20, 1, 500)
    offset = c.p.int("offset", 0, 0)
    songs = search_tracks(c.db, c.libs(), q, count, offset)
    return {"searchResult": {"offset": offset, "totalHits": len(songs), "match": c.songs(songs)}}


def _starred(c: Ctx) -> dict:
    # избранное не зависит от «Вся / Общая / Моя» (если приложение не выбрало папку явно)
    libs = c.folder() if c.p.get("musicFolderId") else c.plain_libs()
    tracks = list(
        c.db.scalars(
            tracks_query(libs)
            .join(Star, (Star.item_id == Track.id) & (Star.kind == "track") & (Star.user_id == c.user.id))
            .order_by(desc(Star.created_at))
        )
    )
    albums = list(c.db.scalars(album_list_query(libs, c.user.id, "starred")))
    artist_ids = list(c.db.scalars(select(Star.item_id).where(Star.user_id == c.user.id, Star.kind == "artist")))
    rows = artists_with_counts(c.db, libs, only_ids=artist_ids) if artist_ids else []
    return {"artist": c.artists(rows), "album": c.albums(albums), "song": c.songs(tracks)}


@method("getStarred")
def get_starred(c: Ctx) -> dict:
    return {"starred": _starred(c)}


@method("getStarred2")
def get_starred2(c: Ctx) -> dict:
    return {"starred2": _starred(c)}


def _star_targets(c: Ctx) -> list[tuple[str, int]]:
    targets: list[tuple[str, int]] = []
    names = {"tr": "track", "al": "album", "ar": "artist"}
    for raw in c.p.all("id"):
        kind, num = _parse_id(raw, "tr")
        if kind in names:
            targets.append((names[kind], num))
    for raw in c.p.all("albumId"):
        targets.append(("album", _parse_id(raw, "al")[1]))
    for raw in c.p.all("artistId"):
        targets.append(("artist", _parse_id(raw, "ar")[1]))
    return targets


@method("star")
def star(c: Ctx) -> dict:
    models = {"track": Track, "album": Album, "artist": Artist}
    for kind, num in _star_targets(c):
        if c.db.get(models[kind], num) and not c.db.get(Star, (c.user.id, kind, num)):
            c.db.add(Star(user_id=c.user.id, kind=kind, item_id=num))
    c.db.commit()
    return {}


@method("unstar")
def unstar(c: Ctx) -> dict:
    for kind, num in _star_targets(c):
        c.db.execute(delete(Star).where(Star.user_id == c.user.id, Star.kind == kind, Star.item_id == num))
    c.db.commit()
    return {}


@method("setRating")
def set_rating(c: Ctx) -> dict:
    kind, num = _parse_id(c.p.req("id"), "tr")
    kind = {"tr": "track", "al": "album", "ar": "artist"}.get(kind, "track")
    rating = c.p.int("rating", 0, 0, 5)
    row = c.db.get(Rating, (c.user.id, kind, num))
    if rating == 0:
        if row:
            c.db.delete(row)
    elif row:
        row.rating = rating
    else:
        c.db.add(Rating(user_id=c.user.id, kind=kind, item_id=num, rating=rating))
    c.db.commit()
    return {}


# «Сейчас играет» — в памяти, этого достаточно
NOW_PLAYING: dict[tuple[int, str], tuple[int, float]] = {}


@method("scrobble")
def scrobble(c: Ctx) -> dict:
    submission = c.p.bool("submission", True)
    times = c.p.all("time")
    for i, raw in enumerate(c.p.all("id")):
        try:
            track = c.visible_track(raw)
        except SubsonicError:
            continue
        if submission:
            at = datetime.now(timezone.utc)
            if i < len(times) and times[i].isdigit():
                at = datetime.fromtimestamp(int(times[i]) / 1000, timezone.utc)
            c.db.add(Play(user_id=c.user.id, track_id=track.id, album_id=track.album_id, played_at=at))
        else:
            NOW_PLAYING[(c.user.id, c.p.get("c") or "")] = (track.id, time.time())
    c.db.commit()
    return {}


@method("getNowPlaying")
def get_now_playing(c: Ctx) -> dict:
    entries = []
    now = time.time()
    for (user_id, client), (track_id, at) in list(NOW_PLAYING.items()):
        if now - at > 15 * 60:
            NOW_PLAYING.pop((user_id, client), None)
            continue
        track = c.db.get(Track, track_id)
        user = c.db.get(User, user_id)
        if not track or not user or track.library_id not in c.plain_libs():
            continue
        song = c.songs([track])[0]
        song.update({"username": user.username, "minutesAgo": int((now - at) / 60), "playerId": 0, "playerName": client})
        entries.append(song)
    return {"nowPlaying": {"entry": entries}}


# ---------------- плейлисты ----------------


def _playlist_tracks(c: Ctx, pl: Playlist) -> list[Track]:
    rules = smart.parse_rules(pl.rules)
    if rules is not None:
        return smart.evaluate(c.db, c.user, rules)
    return list(
        c.db.scalars(
            select(Track)
            .join(PlaylistEntry, PlaylistEntry.track_id == Track.id)
            .where(PlaylistEntry.playlist_id == pl.id, Track.library_id.in_(c.plain_libs() or [-1]))
            .order_by(PlaylistEntry.position, PlaylistEntry.id)
        )
    )


def _playlist(c: Ctx, pl: Playlist, tracks: list[Track] | None = None) -> dict:
    if tracks is None and pl.rules:
        tracks = _playlist_tracks(c, pl)
    if tracks is None:
        stats = c.db.execute(
            select(func.count(Track.id), func.coalesce(func.sum(Track.duration), 0), func.min(Track.album_id))
            .join(PlaylistEntry, PlaylistEntry.track_id == Track.id)
            .where(PlaylistEntry.playlist_id == pl.id, Track.library_id.in_(c.plain_libs() or [-1]))
        ).one()
        count, duration, first_album = stats
    else:
        count, duration = len(tracks), sum(t.duration for t in tracks)
        first_album = tracks[0].album_id if tracks else None
    return {
        "id": f"pl-{pl.id}",
        "name": pl.name,
        "comment": pl.comment or None,
        "owner": pl.owner.username,
        "public": pl.is_public,
        "songCount": count,
        "duration": int(duration),
        "created": _iso(pl.created_at),
        "changed": _iso(pl.updated_at),
        "coverArt": f"pl-{pl.id}" if first_album else None,
    }


def _get_pl(c: Ctx, raw: str, write: bool = False) -> Playlist:
    _, pid = _parse_id(raw, "pl")
    pl = c.db.get(Playlist, pid)
    member = pl is not None and c.db.get(PlaylistMember, (pl.id, c.user.id)) is not None
    if not pl or (pl.owner_id != c.user.id and not pl.is_public and not member):
        raise SubsonicError(70, "Плейлист не найден")
    if write and (pl.rules or (pl.owner_id != c.user.id and not member)):
        raise SubsonicError(50, "Умный плейлист собирается сам" if pl.rules else "Можно менять только свои и совместные плейлисты")
    return pl


def _append(c: Ctx, pl: Playlist, raw_ids: list[str]) -> None:
    pos = c.db.scalar(select(func.coalesce(func.max(PlaylistEntry.position), -1)).where(PlaylistEntry.playlist_id == pl.id))
    for raw in raw_ids:
        try:
            track = c.visible_track(raw)
        except SubsonicError:
            continue
        pos += 1
        c.db.add(PlaylistEntry(playlist_id=pl.id, track_id=track.id, position=pos, added_by=c.user.id))
    pl.updated_at = datetime.now(timezone.utc)


# Подборки видны приложениям как плейлисты только для чтения: id «mx-<ключ>»
def _mix_playlist(c: Ctx, key: str, tracks: list[Track]) -> dict:
    m = mixes.BY_KEY[key]
    now = datetime.now(timezone.utc)
    return {
        "id": f"mx-{key}",
        "name": f"✦ {m.title}",
        "comment": f"Подборка SelfMusic: {m.subtitle}. Обновляется каждый день.",
        "owner": c.user.username,
        "public": False,
        "readonly": True,
        "songCount": len(tracks),
        "duration": int(sum(t.duration for t in tracks)),
        "created": _iso(now),
        "changed": _iso(now),
        "coverArt": f"al-{tracks[0].album_id}" if tracks else None,
    }


def _mix_tracks(c: Ctx, key: str) -> list[Track]:
    from .mixes import load_tracks  # noqa: PLC0415

    return load_tracks(c.db, c.user, mixes.get_mix(c.db, c.user, key))


@method("getPlaylists")
def get_playlists(c: Ctx) -> dict:
    mine = select(PlaylistMember.playlist_id).where(PlaylistMember.user_id == c.user.id)
    pls = c.db.scalars(
        select(Playlist)
        .where((Playlist.owner_id == c.user.id) | Playlist.is_public.is_(True) | Playlist.id.in_(mine))
        .order_by(desc(Playlist.updated_at))
    )
    items = []
    cache: dict = {}
    for key in mixes.subsonic_keys():
        try:
            ids = mixes.get_mix(c.db, c.user, key, cache)
        except Exception:  # noqa: BLE001 — подборки не должны ломать список плейлистов
            break
        if len(ids) >= 8:
            items.append(_mix_playlist(c, key, _mix_tracks(c, key)))
    return {"playlists": {"playlist": items + [_playlist(c, pl) for pl in pls]}}


@method("getPlaylist")
def get_playlist(c: Ctx) -> dict:
    raw = c.p.req("id")
    if raw.startswith("mx-") and raw[3:] in mixes.BY_KEY:
        tracks = _mix_tracks(c, raw[3:])
        data = _mix_playlist(c, raw[3:], tracks)
        data["entry"] = c.songs(tracks)
        return {"playlist": data}
    pl = _get_pl(c, raw)
    tracks = _playlist_tracks(c, pl)
    data = _playlist(c, pl, tracks)
    data["entry"] = c.songs(tracks)
    return {"playlist": data}


@method("createPlaylist")
def create_playlist(c: Ctx) -> dict:
    if pid := c.p.get("playlistId"):
        pl = _get_pl(c, pid, write=True)
        c.db.execute(delete(PlaylistEntry).where(PlaylistEntry.playlist_id == pl.id))
        if name := c.p.get("name"):
            pl.name = name
    else:
        pl = Playlist(owner_id=c.user.id, name=c.p.req("name"))
        c.db.add(pl)
        c.db.flush()
    _append(c, pl, c.p.all("songId"))
    c.db.commit()
    c.db.refresh(pl)
    tracks = _playlist_tracks(c, pl)
    data = _playlist(c, pl, tracks)
    data["entry"] = c.songs(tracks)
    return {"playlist": data}


@method("updatePlaylist")
def update_playlist(c: Ctx) -> dict:
    pl = _get_pl(c, c.p.req("playlistId"), write=True)
    if (name := c.p.get("name")) is not None:
        pl.name = name
    if (comment := c.p.get("comment")) is not None:
        pl.comment = comment
    if c.p.get("public") is not None:
        pl.is_public = c.p.bool("public")
    remove = {int(i) for i in c.p.all("songIndexToRemove") if i.isdigit()}
    if remove:
        entries = list(
            c.db.scalars(
                select(PlaylistEntry)
                .join(Track, Track.id == PlaylistEntry.track_id)
                .where(PlaylistEntry.playlist_id == pl.id, Track.library_id.in_(c.plain_libs() or [-1]))
                .order_by(PlaylistEntry.position, PlaylistEntry.id)
            )
        )
        for idx in remove:
            if idx < len(entries):
                c.db.delete(entries[idx])
    _append(c, pl, c.p.all("songIdToAdd"))
    pl.updated_at = datetime.now(timezone.utc)
    c.db.commit()
    return {}


@method("deletePlaylist")
def delete_playlist(c: Ctx) -> dict:
    pl = _get_pl(c, c.p.req("id"), write=True)
    c.db.delete(pl)
    c.db.commit()
    return {}


# ---------------- очередь ----------------


@method("getPlayQueue")
def get_play_queue(c: Ctx) -> dict:
    pq = c.db.get(PlayQueue, c.user.id)
    if not pq:
        return {}
    ids = [i for i in json.loads(pq.track_ids or "[]") if isinstance(i, int)]
    tracks = {t.id: t for t in c.db.scalars(tracks_query(c.plain_libs()).where(Track.id.in_(ids or [-1])))}
    return {
        "playQueue": {
            "current": f"tr-{pq.current_id}" if pq.current_id else None,
            "position": pq.position_ms,
            "username": c.user.username,
            "changed": _iso(pq.changed_at),
            "changedBy": pq.changed_by,
            "entry": c.songs([tracks[i] for i in ids if i in tracks]),
        }
    }


@method("savePlayQueue")
def save_play_queue(c: Ctx) -> dict:
    ids = [_parse_id(raw, "tr")[1] for raw in c.p.all("id")]
    pq = c.db.get(PlayQueue, c.user.id) or PlayQueue(user_id=c.user.id)
    pq.track_ids = json.dumps(ids)
    current = c.p.get("current")
    pq.current_id = _parse_id(current, "tr")[1] if current else None
    pq.position_ms = c.p.int("position", 0, 0) or 0
    pq.changed_by = (c.p.get("c") or "")[:128]
    pq.changed_at = datetime.now(timezone.utc)
    pq.device_id = f"subsonic:{pq.changed_by}"[:64]
    pq.playing = False  # клиенты Subsonic не сообщают, играет ли сейчас
    pq.rev = (pq.rev or 0) + 1
    c.db.merge(pq)
    c.db.commit()
    return {}


# ---------------- информация ----------------


@method("getArtistInfo", "getArtistInfo2")
def get_artist_info(c: Ctx) -> dict:
    from ..models import ArtistMeta  # noqa: PLC0415

    key = "artistInfo2" if c.p.get("__method") == "getartistinfo2" else "artistInfo"
    info = {"biography": "", "musicBrainzId": "", "smallImageUrl": "", "mediumImageUrl": "", "largeImageUrl": ""}
    try:
        kind, num = _parse_id(c.p.get("id") or "", "ar")
    except SubsonicError:
        kind, num = "", 0
    m = c.db.get(ArtistMeta, num) if kind == "ar" else None
    if m is not None and m.status in ("found", "manual"):
        info["biography"] = m.bio
        info["musicBrainzId"] = m.mbid or ""
        if m.bio_url:
            info["lastFmUrl"] = m.bio_url  # у клиентов это ссылка «подробнее»
    return {key: info}


@method("getAlbumInfo", "getAlbumInfo2")
def get_album_info(c: Ctx) -> dict:
    from ..models import AlbumMeta  # noqa: PLC0415

    try:
        kind, num = _parse_id(c.p.get("id") or "", "al")
    except SubsonicError:
        kind, num = "", 0
    m = c.db.get(AlbumMeta, num) if kind == "al" else None
    mbid = m.release_mbid if m is not None and m.status in ("found", "manual") else ""
    return {"albumInfo": {"notes": "", "musicBrainzId": mbid or ""}}


@method("getTopSongs")
def get_top_songs(c: Ctx) -> dict:
    name = c.p.req("artist")
    count = c.p.int("count", 50, 1, 500)
    artist = c.db.scalar(select(Artist).where(func.lower(Artist.name) == name.lower()))
    tracks = top_tracks(c.db, c.libs(), artist.id, count) if artist else []
    return {"topSongs": {"song": c.songs(tracks)}}


@method("getSimilarSongs", "getSimilarSongs2")
def get_similar_songs(c: Ctx) -> dict:
    key = "similarSongs2" if c.p.get("__method") == "getsimilarsongs2" else "similarSongs"
    count = c.p.int("count", 50, 1, 500)
    kind, num = _parse_id(c.p.req("id"), "ar")
    genre = None
    artist_id = None
    if kind == "ar":
        artist_id = num
    elif kind == "al":
        album = c.visible_album(c.p.get("id") or "")
        artist_id, genre = album.artist_id, album.genre
    else:
        track = c.visible_track(c.p.get("id") or "")
        artist_id, genre = track.artist_id, track.genre
    # «Радио» в приложениях — тот же подбор похожих, что и в вебе
    from .mixes import load_tracks  # noqa: PLC0415

    ids = mixes.radio(
        c.db, c.user,
        track_id=num if kind == "tr" else None,
        artist_id=artist_id if kind != "tr" else None,
        count=count,
    )
    tracks = load_tracks(c.db, c.user, ids)
    if not tracks:  # анализа ещё нет и жанров не хватило — по старинке
        query = tracks_query(c.libs())
        if genre:
            query = query.where((Track.genre == genre) | (Track.artist_id == artist_id))
        elif artist_id:
            query = query.where(Track.artist_id == artist_id)
        tracks = list(c.db.scalars(query.order_by(func.random()).limit(count)))
    return {key: {"song": c.songs(tracks)}}


@method("getLyrics")
def get_lyrics(c: Ctx) -> dict:
    artist, title = c.p.get("artist") or "", c.p.get("title") or ""
    query = tracks_query(c.libs()).where(Track.lyrics.is_not(None))
    if title:
        query = query.where(func.lower(Track.title) == title.lower())
    if artist:
        query = query.where(func.lower(Track.artist_name) == artist.lower())
    track = c.db.scalars(query.limit(1)).first() if title else None
    if not track:
        return {"lyrics": {"artist": artist, "title": title}}
    return {"lyrics": {"artist": track.artist_name, "title": track.title, "value": _plain_lyrics(track.lyrics or "")}}


def _plain_lyrics(text: str) -> str:
    import re

    return "\n".join(re.sub(r"^\s*(\[[0-9:.]+\])+\s*", "", line) for line in text.splitlines()).strip()


@method("getLyricsBySongId")
def get_lyrics_by_song_id(c: Ctx) -> dict:
    import re

    track = c.visible_track(c.p.req("id"))
    if not track.lyrics:
        return {"lyricsList": {"structuredLyrics": []}}
    lines = []
    synced = False
    for line in track.lyrics.splitlines():
        m = re.match(r"^\s*\[(\d+):(\d+(?:\.\d+)?)\](.*)$", line)
        if m:
            synced = True
            lines.append({"start": int((int(m.group(1)) * 60 + float(m.group(2))) * 1000), "value": m.group(3).strip()})
        elif not re.match(r"^\s*\[[a-z]+:", line, re.I):
            lines.append({"value": line})
    if not synced:
        lines = [{"value": ln["value"]} for ln in lines]
    return {
        "lyricsList": {
            "structuredLyrics": [
                {
                    "displayArtist": track.artist_name,
                    "displayTitle": track.title,
                    "lang": "xxx",
                    "synced": synced,
                    "line": lines,
                }
            ]
        }
    }


# ---------------- пользователи и сканирование ----------------


def _user(c: Ctx, user: User) -> dict:
    return {
        "username": user.username,
        "email": user.email,
        "scrobblingEnabled": True,
        "adminRole": user.is_admin,
        "settingsRole": True,
        "downloadRole": True,
        "uploadRole": False,
        "playlistRole": True,
        "coverArtRole": False,
        "commentRole": False,
        "podcastRole": False,
        "streamRole": True,
        "jukeboxRole": False,
        "shareRole": False,
        "videoConversionRole": False,
        "folder": allowed_library_ids(c.db, user),
    }


@method("getUser")
def get_user(c: Ctx) -> dict:
    name = c.p.get("username") or c.user.username
    if name != c.user.username and not c.user.is_admin:
        raise SubsonicError(50, "Нет прав")
    user = c.db.scalar(select(User).where(User.username == name))
    if not user:
        raise SubsonicError(70, "Пользователь не найден")
    return {"user": _user(c, user)}


@method("getUsers")
def get_users(c: Ctx) -> dict:
    if not c.user.is_admin:
        raise SubsonicError(50, "Нет прав")
    return {"users": {"user": [_user(c, u) for u in c.db.scalars(select(User).order_by(User.id))]}}


def _scan_status() -> dict:
    st = scanner.status()
    return {"scanStatus": {"scanning": st["running"], "count": st["checked"]}}


@method("getScanStatus")
def get_scan_status(c: Ctx) -> dict:
    return _scan_status()


@method("startScan")
def start_scan(c: Ctx) -> dict:
    if not c.user.is_admin:
        raise SubsonicError(50, "Нет прав")
    scanner.start(full=c.p.bool("fullScan"))
    return _scan_status()


# Пустые ответы для того, чего нет — чтобы приложения не показывали ошибки
@method("getPodcasts")
def get_podcasts(c: Ctx) -> dict:
    return {"podcasts": {"channel": []}}


@method("getNewestPodcasts")
def get_newest_podcasts(c: Ctx) -> dict:
    return {"newestPodcasts": {"episode": []}}


@method("getInternetRadioStations")
def get_radio(c: Ctx) -> dict:
    return {"internetRadioStations": {"internetRadioStation": []}}


# Закладки Subsonic: приложения для аудиокниг хранят в них место, где остановились.
# Одна закладка на трек (так в протоколе); для книг она же двигает прогресс книги.


@method("getBookmarks")
def get_bookmarks(c: Ctx) -> dict:
    rows = list(c.db.scalars(select(Bookmark).where(Bookmark.user_id == c.user.id).order_by(desc(Bookmark.created_at))))
    tracks = {t.id: t for t in c.db.scalars(select(Track).where(Track.id.in_([m.track_id for m in rows] or [-1])))}
    allowed = set(c.all_libs())
    items = []
    for m in rows:
        t = tracks.get(m.track_id)
        if t is None or t.library_id not in allowed:
            continue
        items.append(
            {
                "position": int(m.position * 1000),
                "username": c.user.username,
                "comment": m.comment or None,
                "created": _iso(m.created_at),
                "changed": _iso(m.created_at),
                "entry": c.songs([t])[0],
            }
        )
    return {"bookmarks": {"bookmark": items}}


@method("createBookmark")
def create_bookmark(c: Ctx) -> dict:
    track = c.visible_track(c.p.req("id"))
    position = max(0.0, (c.p.int("position", 0, 0) or 0) / 1000)
    comment = (c.p.get("comment") or "")[:1000]
    m = c.db.scalar(select(Bookmark).where(Bookmark.user_id == c.user.id, Bookmark.track_id == track.id).order_by(desc(Bookmark.created_at)))
    if m is None:
        m = Bookmark(user_id=c.user.id, track_id=track.id)
        c.db.add(m)
    m.position, m.comment, m.created_at = position, comment, datetime.now(timezone.utc)
    c.db.commit()
    lib = c.db.get(Library, track.library_id)
    if lib is not None and lib.kind == "audiobooks":
        from .books import save_progress  # noqa: PLC0415

        album = c.db.get(Album, track.album_id)
        if album is not None:
            save_progress(c.db, c.user, album, track.id, position)
    return {}


@method("deleteBookmark")
def delete_bookmark(c: Ctx) -> dict:
    track = c.visible_track(c.p.req("id"))
    for m in c.db.scalars(select(Bookmark).where(Bookmark.user_id == c.user.id, Bookmark.track_id == track.id)):
        c.db.delete(m)
    c.db.commit()
    return {}


@method("getShares")
def get_shares(c: Ctx) -> dict:
    return {"shares": {"share": []}}


@method("getChatMessages")
def get_chat(c: Ctx) -> dict:
    return {"chatMessages": {"chatMessage": []}}


@method("getVideos")
def get_videos(c: Ctx) -> dict:
    return {"videos": {"video": []}}


# ---------------- бинарные методы ----------------


def _stream(c: Ctx, raw: bool = False) -> Response:
    track = c.visible_track(c.p.req("id"))
    if raw:
        return file_response(c.request, track_file(c.db, track), content_type(track.suffix), None)
    fmt = (c.p.get("format") or "").lower() or None
    return stream_track(
        c.request,
        c.db,
        track,
        max_bitrate=c.p.int("maxBitRate", 0, 0) or 0,
        fmt=fmt,
        offset=float(c.p.get("timeOffset") or 0),
    )


def _cover(c: Ctx) -> Response:
    raw = c.p.get("id") or ""
    size = c.p.int("size", 600, 32, 1200) or 600
    album: Album | None = None
    try:
        kind, num = _parse_id(raw, "al")
    except SubsonicError:
        kind, num = "", 0
    libs = c.all_libs()  # обложки книг тоже
    if kind == "al":
        album = c.db.get(Album, num)
    elif kind == "tr":
        track = c.db.get(Track, num)
        album = track.album if track else None
    elif kind == "ar":
        from ..metadata import artist_image_path  # noqa: PLC0415
        from ..models import ArtistMeta  # noqa: PLC0415

        meta = c.db.get(ArtistMeta, num)
        photo = artist_image_path(meta, size) if meta is not None else None
        if photo is not None:
            return image_response(photo)
        album = c.db.scalars(
            select(Album)
            .where(Album.artist_id == num, Album.library_id.in_(libs or [-1]), Album.cover.is_not(None))
            .order_by(desc(Album.year))
            .limit(1)
        ).first()
    elif kind == "pl":
        album = c.db.scalars(
            select(Album)
            .join(Track, Track.album_id == Album.id)
            .join(PlaylistEntry, PlaylistEntry.track_id == Track.id)
            .where(PlaylistEntry.playlist_id == num, Album.cover.is_not(None), Album.library_id.in_(libs or [-1]))
            .order_by(PlaylistEntry.position)
            .limit(1)
        ).first()
    if album is not None and album.library_id in libs:
        path = cover_path(c.db, album, size)
        if path:
            return image_response(path)
    return Response(
        placeholder_cover(raw or "selfmusic", size),
        media_type="image/jpeg",
        headers={"Cache-Control": "private, max-age=86400"},
    )


def _avatar(c: Ctx) -> Response:
    from .profile import avatar_file  # noqa: PLC0415

    name = c.p.get("username") or c.user.username
    target = c.db.scalar(select(User).where(User.username == name))
    if target is None or not target.avatar_version or not avatar_file(target.id).is_file():
        return Response(placeholder_cover(name, 256), media_type="image/jpeg", headers={"Cache-Control": "private, max-age=3600"})
    return image_response(avatar_file(target.id))


BINARY = {
    "stream": lambda c: _stream(c),
    "download": lambda c: _stream(c, raw=True),
    "getcoverart": _cover,
    "getavatar": _avatar,
}


# ---------------- маршрутизация ----------------


@router.api_route("/rest/{name}", methods=["GET", "POST"], include_in_schema=False)
async def subsonic(name: str, request: Request) -> Response:
    items = list(request.query_params.multi_items())
    if request.method == "POST":
        ctype = request.headers.get("content-type", "")
        if "form" in ctype:
            form = await request.form()
            items += [(k, str(v)) for k, v in form.multi_items()]
    params = Params(items)
    name = name.removesuffix(".view").lower()
    params._items.append(("__method", name))

    if not dbmod.is_configured():
        return render(params, {"error": {"code": 0, "message": "Сервер не настроен"}}, "failed")

    # Синхронная работа с БД — в пуле потоков, чтобы не блокировать event loop
    from starlette.concurrency import run_in_threadpool

    def handle() -> Response:
        with dbmod.session_scope() as db:
            try:
                user = _authenticate(db, params, request)
                ctx = Ctx(db, user, params, request)
                if name in BINARY:
                    return BINARY[name](ctx)
                handler = HANDLERS.get(name)
                if handler is None:
                    raise SubsonicError(0, f"Метод не поддерживается: {name}")
                return render(params, handler(ctx) or {})
            except SubsonicError as err:
                return render(params, {"error": {"code": err.code, "message": err.message}}, "failed")
            except Exception as err:  # noqa: BLE001
                import logging

                logging.getLogger("uvicorn.error").exception("Subsonic %s", name)
                return render(params, {"error": {"code": 0, "message": f"Ошибка сервера: {err.__class__.__name__}"}}, "failed")

    return await run_in_threadpool(handle)


