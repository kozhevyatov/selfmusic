"""Поиск дубликатов: один и тот же трек в разных папках, альбомах или форматах (MP3 и FLAC).

Сравниваем «нормализованные» исполнителя и название: без регистра, «ё», пунктуации, «feat. …»
и пометок вроде «(Remastered 2011)». Строгий режим дополнительно требует совпадения длительности
(±3 с) — так «концертная» и «студийная» версии не считаются дублями.
"""
from __future__ import annotations

import hashlib
import json
import re

from sqlalchemy import select
from sqlalchemy.orm import Session

from .access import can_write
from .app_settings import get_setting, set_setting
from .models import Album, Library, Track, User
from .serialize import track_quality

LOSSLESS = {"flac", "wav", "aiff", "aif", "ape", "wv", "alac", "dsf"}
_BRACKETS = re.compile(r"[\(\[][^\)\]]*(remaster|explicit|album version|single version|bonus|deluxe|radio edit|mono|stereo)[^\)\]]*[\)\]]", re.I)
_FEAT = re.compile(r"\s+(feat\.?|ft\.?|featuring|при уч\.?)\s.*$", re.I)
_PUNCT = re.compile(r"[^\w]+", re.U)


def norm(text: str) -> str:
    t = (text or "").lower().replace("ё", "е")
    t = _BRACKETS.sub(" ", t)
    t = _FEAT.sub("", t)
    t = _PUNCT.sub(" ", t)
    return " ".join(t.split())


def norm_artist(text: str) -> str:
    first = re.split(r"\s*(?:,|;|&|/| feat\.? | ft\.? | и )\s*", text or "", maxsplit=1)[0]
    return norm(first)


def quality_score(t: Track) -> float:
    """Чем выше — тем лучше оставить: без потерь > битрейт > разрядность > частота."""
    lossless = (t.suffix or "").lower() in LOSSLESS or t.codec == "alac"
    return (1_000_000 if lossless else 0) + (t.bit_depth or 0) * 10_000 + (t.sample_rate or 0) / 10 + (t.bitrate or 0) * 10


def _ignored(db: Session) -> set[str]:
    try:
        return set(json.loads(get_setting(db, "duplicates_ignored") or "[]"))
    except ValueError:
        return set()


def ignore(db: Session, key: str) -> None:
    keys = _ignored(db)
    keys.add(key)
    set_setting(db, "duplicates_ignored", json.dumps(sorted(keys)))


def find(db: Session, user: User, strict: bool = True) -> list[dict]:
    libs = {lib.id: lib for lib in db.scalars(select(Library).where(Library.kind == "music", Library.enabled.is_(True)))}
    rows = list(db.scalars(select(Track).where(Track.library_id.in_(list(libs) or [-1]))))
    groups: dict[tuple, list[Track]] = {}
    for t in rows:
        title = norm(t.title)
        if not title:
            continue
        groups.setdefault((norm_artist(t.artist_name), title), []).append(t)
    ignored = _ignored(db)
    writable = {lid: can_write(db, user, lib) for lid, lib in libs.items()}
    albums = {a.id: a for a in db.scalars(select(Album).where(Album.id.in_({t.album_id for g in groups.values() if len(g) > 1 for t in g} or {-1})))}
    out: list[dict] = []
    for (artist, title), tracks in groups.items():
        if len(tracks) < 2:
            continue
        clusters: list[list[Track]] = []
        if strict:
            for t in sorted(tracks, key=lambda x: x.duration or 0):
                if clusters and abs((clusters[-1][-1].duration or 0) - (t.duration or 0)) <= 3:
                    clusters[-1].append(t)
                else:
                    clusters.append([t])
        else:
            clusters = [tracks]
        for cl in clusters:
            if len(cl) < 2:
                continue
            key = hashlib.sha1(("|".join(sorted(str(t.id) for t in cl))).encode()).hexdigest()[:16]
            if key in ignored:
                continue
            best = max(cl, key=quality_score)
            out.append(
                {
                    "key": key,
                    "title": cl[0].title,
                    "artist": cl[0].artist_name,
                    "tracks": [
                        {
                            "id": t.id,
                            "title": t.title,
                            "path": t.path,
                            "library": libs[t.library_id].name,
                            "album": albums[t.album_id].name if t.album_id in albums else "",
                            "album_id": t.album_id,
                            "quality": track_quality(t),
                            "size": t.size,
                            "duration": round(t.duration or 0, 1),
                            "best": t.id == best.id,
                            "can_delete": writable.get(t.library_id, False),
                        }
                        for t in sorted(cl, key=quality_score, reverse=True)
                    ],
                }
            )
    out.sort(key=lambda g: (g["artist"].lower(), g["title"].lower()))
    return out
