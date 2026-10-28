"""Чтение тегов и встроенных обложек через mutagen.

Поддерживаются ID3 (MP3, AIFF, WAV, DSF), MP4 (M4A/AAC/ALAC), Vorbis comments
(FLAC, OGG, Opus), APEv2 (APE, WavPack, Musepack) и ASF (WMA).
"""
from __future__ import annotations

import base64
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path

import mutagen
from mutagen.apev2 import APEv2File
from mutagen.asf import ASF
from mutagen.flac import FLAC, Picture
from mutagen.id3 import ID3
from mutagen.mp4 import MP4

log = logging.getLogger("uvicorn.error")


@dataclass
class TrackMeta:
    title: str = ""
    artist: str = ""
    album_artist: str = ""
    album: str = ""
    track_no: int | None = None
    disc_no: int | None = None
    year: int | None = None
    genre: str = ""
    compilation: bool = False
    lyrics: str | None = None
    duration: float = 0.0
    bitrate: int = 0  # кбит/с
    sample_rate: int = 0
    bit_depth: int = 0
    channels: int = 2
    codec: str = ""
    has_cover: bool = False
    extra: dict = field(default_factory=dict)


# Имена полей в разных форматах тегов → наши поля
_ID3 = {
    "title": ["TIT2"],
    "artist": ["TPE1"],
    "album_artist": ["TPE2", "TXXX:ALBUMARTIST", "TXXX:album artist"],
    "album": ["TALB"],
    "track": ["TRCK"],
    "disc": ["TPOS"],
    "year": ["TDRC", "TYER", "TDOR", "TORY"],
    "genre": ["TCON"],
    "compilation": ["TCMP"],
}
_MP4 = {
    "title": ["©nam"],
    "artist": ["©ART"],
    "album_artist": ["aART"],
    "album": ["©alb"],
    "track": ["trkn"],
    "disc": ["disk"],
    "year": ["©day"],
    "genre": ["©gen"],
    "compilation": ["cpil"],
    "lyrics": ["©lyr"],
}
_VORBIS = {
    "title": ["title"],
    "artist": ["artist"],
    "album_artist": ["albumartist", "album artist", "album_artist"],
    "album": ["album"],
    "track": ["tracknumber", "track"],
    "disc": ["discnumber", "disc"],
    "year": ["date", "year", "originaldate"],
    "genre": ["genre"],
    "compilation": ["compilation"],
    "lyrics": ["lyrics", "unsyncedlyrics"],
}
_APE = {
    "title": ["Title"],
    "artist": ["Artist"],
    "album_artist": ["Album Artist", "AlbumArtist"],
    "album": ["Album"],
    "track": ["Track"],
    "disc": ["Disc"],
    "year": ["Year", "Date"],
    "genre": ["Genre"],
    "compilation": ["Compilation"],
    "lyrics": ["Lyrics"],
}
_ASF = {
    "title": ["Title"],
    "artist": ["Author", "WM/AlbumArtist"],
    "album_artist": ["WM/AlbumArtist"],
    "album": ["WM/AlbumTitle"],
    "track": ["WM/TrackNumber", "WM/Track"],
    "disc": ["WM/PartOfSet"],
    "year": ["WM/Year"],
    "genre": ["WM/Genre"],
    "lyrics": ["WM/Lyrics"],
}

_NUM = re.compile(r"\d+")


def fix_encoding(text: str) -> str:
    """Старые MP3: русские теги в Windows-1251, помеченные как Latin-1 → «Ñèëà ðèôìîâàííûõ».

    Перекодируем, только если строка целиком укладывается в Latin-1 и в ней большинство
    букв — из верхней половины таблицы (так выглядит кириллица в cp1251). «Beyoncé»,
    «Mötley Crüe», «Señor» с одной-двумя такими буквами не трогаем.
    """
    if not text or text.isascii():
        return text
    try:
        raw = text.encode("latin-1")
    except UnicodeEncodeError:
        return text  # уже нормальный Unicode (кириллица, иероглифы и т. п.)
    high = sum(1 for ch in text if "\xc0" <= ch <= "\xff")
    letters = sum(1 for ch in text if ch.isalpha())
    if high < 2 or high < letters * 0.5:
        return text
    try:
        return raw.decode("cp1251")
    except UnicodeDecodeError:
        return text


def _text(value) -> str:  # noqa: ANN001
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        for v in value:
            t = _text(v)
            if t:
                return t
        return ""
    if hasattr(value, "text"):  # фреймы ID3
        return _text(value.text)
    if isinstance(value, bytes):
        try:
            return value.decode("utf-8").strip("\x00 ").strip()
        except UnicodeDecodeError:
            return value.decode("cp1251", "replace").strip("\x00 ").strip()
    return fix_encoding(str(value).strip("\x00 ").strip())


def _int(value) -> int | None:  # noqa: ANN001
    if isinstance(value, (list, tuple)) and value and isinstance(value[0], tuple):
        value = value[0][0]  # MP4: trkn = [(номер, всего)]
    if isinstance(value, int):
        return value or None
    m = _NUM.search(_text(value))
    if not m:
        return None
    n = int(m.group())
    return n if 0 < n < 100000 else None


def _year(value) -> int | None:  # noqa: ANN001
    m = re.search(r"(1[0-9]{3}|20[0-9]{2})", _text(value))
    return int(m.group()) if m else None


def _bool(value) -> bool:  # noqa: ANN001
    if isinstance(value, bool):
        return value
    return _text(value).lower() in ("1", "true", "yes")


def _lookup(tags, keys: list[str], case_insensitive: bool = False):  # noqa: ANN001
    for key in keys:
        try:
            if key in tags:
                return tags[key]
        except (KeyError, ValueError, TypeError):
            pass
        if case_insensitive:
            low = key.lower()
            for k in tags.keys():
                if str(k).lower() == low:
                    return tags[k]
    return None


def _mapping(audio) -> tuple[dict, bool]:  # noqa: ANN001
    tags = audio.tags
    if isinstance(audio, MP4):
        return _MP4, False
    if isinstance(audio, ASF):
        return _ASF, False
    if isinstance(tags, ID3):
        return _ID3, False
    if isinstance(audio, APEv2File) or type(tags).__name__ == "APEv2":
        return _APE, True
    return _VORBIS, True


def _codec(audio) -> str:  # noqa: ANN001
    info = audio.info
    codec = getattr(info, "codec", None)
    if codec:  # MP4: mp4a.40.2 / alac
        return "alac" if "alac" in str(codec).lower() else "aac"
    return type(audio).__name__.lower().replace("file", "")


def _has_picture(audio) -> bool:  # noqa: ANN001
    tags = audio.tags
    if isinstance(audio, FLAC) and audio.pictures:
        return True
    if tags is None:
        return False
    if isinstance(tags, ID3):
        return bool(tags.getall("APIC"))
    if isinstance(audio, MP4):
        return bool(tags.get("covr"))
    if isinstance(audio, ASF):
        return bool(tags.get("WM/Picture"))
    try:
        keys = [str(k).lower() for k in tags.keys()]
    except Exception:  # noqa: BLE001
        return False
    return "metadata_block_picture" in keys or "cover art (front)" in keys


def read_meta(path: Path) -> TrackMeta:
    audio = mutagen.File(path)
    if audio is None:
        raise ValueError("неизвестный формат")
    meta = TrackMeta()
    info = audio.info
    meta.duration = float(getattr(info, "length", 0) or 0)
    bitrate = int(getattr(info, "bitrate", 0) or 0)
    meta.bitrate = round(bitrate / 1000) if bitrate > 10000 else bitrate
    meta.sample_rate = int(getattr(info, "sample_rate", 0) or 0)
    meta.bit_depth = int(getattr(info, "bits_per_sample", 0) or 0)
    meta.channels = int(getattr(info, "channels", 2) or 2)
    meta.codec = _codec(audio)
    if not meta.bitrate and meta.duration > 0:
        meta.bitrate = round(path.stat().st_size * 8 / meta.duration / 1000)

    tags = audio.tags
    if tags is not None:
        mapping, ci = _mapping(audio)
        get = lambda field_: _lookup(tags, mapping.get(field_, []), ci)  # noqa: E731
        meta.title = _text(get("title"))
        meta.artist = _text(get("artist"))
        meta.album_artist = _text(get("album_artist"))
        meta.album = _text(get("album"))
        meta.track_no = _int(get("track"))
        meta.disc_no = _int(get("disc"))
        meta.year = _year(get("year"))
        meta.genre = _text(get("genre"))[:128]
        meta.compilation = _bool(get("compilation"))
        if isinstance(tags, ID3):
            uslt = tags.getall("USLT")
            if uslt:
                meta.lyrics = fix_encoding(str(uslt[0].text).strip()) or None
        elif "lyrics" in mapping:
            meta.lyrics = _text(get("lyrics")) or None
        meta.has_cover = _has_picture(audio)
    return meta


def embedded_cover(path: Path) -> bytes | None:
    """Первая встроенная картинка (предпочтительно «передняя обложка»)."""
    try:
        audio = mutagen.File(path)
    except Exception:  # noqa: BLE001
        return None
    if audio is None:
        return None
    if isinstance(audio, FLAC) and audio.pictures:
        pics = sorted(audio.pictures, key=lambda p: p.type != 3)
        return pics[0].data
    tags = audio.tags
    if tags is None:
        return None
    try:
        if isinstance(tags, ID3):
            frames = tags.getall("APIC")
            if frames:
                frames.sort(key=lambda f: f.type != 3)
                return frames[0].data
            return None
        if isinstance(audio, MP4):
            covr = tags.get("covr")
            return bytes(covr[0]) if covr else None
        if isinstance(audio, ASF):
            pics = tags.get("WM/Picture")
            if pics:
                # Формат WM/Picture: тип(1) + длина(4) + mime(utf16, \0\0) + описание(utf16, \0\0) + данные
                raw = pics[0].value
                pos = 5
                for _ in range(2):
                    end = raw.find(b"\x00\x00", pos)
                    while end != -1 and (end - pos) % 2:
                        end = raw.find(b"\x00\x00", end + 1)
                    pos = end + 2
                return raw[pos:]
            return None
        for key in tags.keys():
            low = str(key).lower()
            if low == "metadata_block_picture":
                values = tags[key]
                data = base64.b64decode(values[0] if isinstance(values, list) else values)
                return Picture(data).data
            if low == "cover art (front)":
                raw = tags[key].value
                # APEv2: «имя файла\0данные»
                return raw.split(b"\x00", 1)[1] if b"\x00" in raw else raw
    except Exception:  # noqa: BLE001
        log.debug("Не удалось достать обложку из %s", path, exc_info=True)
    return None


# ---------------- запись тегов ----------------

EDITABLE = ("title", "artist", "album_artist", "album", "track", "disc", "year", "genre", "lyrics")


class TagWriteError(Exception):
    pass


def write_tags(path: Path, changes: dict[str, str | None]) -> None:
    """Записать изменённые поля в файл. Значение "" удаляет поле, None/отсутствие — не трогает."""
    from mutagen.id3 import TALB, TCON, TDRC, TIT2, TPE1, TPE2, TPOS, TRCK, USLT
    from mutagen.mp4 import MP4Tags

    changes = {k: v for k, v in changes.items() if k in EDITABLE and v is not None}
    if not changes:
        return
    try:
        audio = mutagen.File(path)
    except Exception as exc:  # noqa: BLE001
        raise TagWriteError(f"Не удалось открыть файл: {exc}")
    if audio is None:
        raise TagWriteError("Неизвестный формат файла")

    def num(v: str) -> int:
        m = _NUM.search(v or "")
        return int(m.group()) if m else 0

    if isinstance(audio, MP4):
        if audio.tags is None:
            audio.tags = MP4Tags()
        tags = audio.tags
        keys = {"title": "©nam", "artist": "©ART", "album_artist": "aART", "album": "©alb", "year": "©day", "genre": "©gen", "lyrics": "©lyr"}
        for fld, value in changes.items():
            if fld in ("track", "disc"):
                key = "trkn" if fld == "track" else "disk"
                if value == "":
                    tags.pop(key, None)
                else:
                    total = tags.get(key, [(0, 0)])[0][1] if tags.get(key) else 0
                    tags[key] = [(num(value), total)]
            elif value == "":
                tags.pop(keys[fld], None)
            else:
                tags[keys[fld]] = [value]
    elif isinstance(audio.tags, ID3) or (audio.tags is None and path.suffix.lower() in (".mp3", ".aif", ".aiff", ".wav", ".dsf")):
        if audio.tags is None:
            audio.add_tags()
        tags = audio.tags
        frames = {"title": TIT2, "artist": TPE1, "album_artist": TPE2, "album": TALB, "track": TRCK, "disc": TPOS, "year": TDRC, "genre": TCON}
        for fld, value in changes.items():
            if fld == "lyrics":
                tags.delall("USLT")
                if value:
                    tags.add(USLT(encoding=3, lang="rus", desc="", text=value))
                continue
            frame = frames[fld]
            tags.delall(frame.__name__)
            if value:
                tags.add(frame(encoding=3, text=[value]))
    elif isinstance(audio, ASF):
        if audio.tags is None:
            audio.add_tags()
        keys = {"title": "Title", "artist": "Author", "album_artist": "WM/AlbumArtist", "album": "WM/AlbumTitle", "track": "WM/TrackNumber", "disc": "WM/PartOfSet", "year": "WM/Year", "genre": "WM/Genre", "lyrics": "WM/Lyrics"}
        for fld, value in changes.items():
            if value == "":
                audio.tags.pop(keys[fld], None)
            else:
                audio.tags[keys[fld]] = [value]
    else:
        if audio.tags is None:
            try:
                audio.add_tags()
            except Exception as exc:  # noqa: BLE001
                raise TagWriteError(f"Формат не поддерживает теги: {exc}")
        tags = audio.tags
        is_ape = type(tags).__name__ == "APEv2"
        keys = _APE if is_ape else _VORBIS
        for name, value in changes.items():
            key = keys[name][0]
            # убираем все варианты имени поля (например, albumartist и album artist)
            for alt in keys.get(name, []):
                for k in list(tags.keys()):
                    if str(k).lower() == alt.lower():
                        del tags[k]
            if value:
                tags[key] = value if is_ape else [value]
    try:
        audio.save()
    except PermissionError:
        raise TagWriteError("Нет прав на запись файла — папка смонтирована только для чтения?")
    except Exception as exc:  # noqa: BLE001
        raise TagWriteError(f"Не удалось сохранить теги: {exc}")


def read_editable(path: Path) -> dict:
    meta = read_meta(path)
    return {
        "title": meta.title,
        "artist": meta.artist,
        "album_artist": meta.album_artist,
        "album": meta.album,
        "track": str(meta.track_no or ""),
        "disc": str(meta.disc_no or ""),
        "year": str(meta.year or ""),
        "genre": meta.genre,
        "lyrics": meta.lyrics or "",
    }
