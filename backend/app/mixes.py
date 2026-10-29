"""Личные подборки: по времени суток, настроению, времени года и по истории.

Как выбирается трек:
1. «Характер» трека — две оси 0..1: energy (спокойно ↔ энергично) и valence (грустно ↔ радостно).
   Берём из анализа звука (после ранговой нормализации по медиатеке пользователя), смешивая
   с оценкой по жанру. Пока трек не проанализирован — только по жанру.
2. Насколько трек подходит подборке — близость к её «точке» на этих осях.
3. Личное: избранное, сколько раз слушали, в какие часы обычно слушаете этот трек,
   давно ли он звучал; ключевые слова для времён года («зима», «snow», «лето»…).
4. Немного случайности (своя на каждый день), не больше 2 треков исполнителя,
   порядок — плавная кривая энергии.
Подборка запоминается на день; «Обновить» собирает её заново, «Не подходит» убирает трек навсегда.
"""
from __future__ import annotations

import json
import math
import random
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from .access import allowed_library_ids
from .models import Album, MixFeedback, Play, Star, Track, TrackFeature, User, UserMix

MIX_SIZE = 50
ARTIST_CAP = 2
ALBUM_CAP = 3


@dataclass(frozen=True)
class MixDef:
    key: str
    group: str  # time | mood | season | personal
    title: str
    subtitle: str
    icon: str
    colors: tuple[str, str]
    energy: float = 0.5
    valence: float = 0.5
    spread: float = 0.2  # насколько строго держаться «точки»
    order: str = "wave"  # rising | falling | wave | flat
    hours: tuple[int, int] | None = None  # для подборок по времени суток
    months: tuple[int, ...] = ()
    keywords: tuple[str, ...] = ()
    genres_plus: tuple[str, ...] = ()
    genres_minus: tuple[str, ...] = ()
    extra: dict = field(default_factory=dict)


MIXES: list[MixDef] = [
    # ---- время суток ----
    MixDef("morning", "time", "Утренняя", "Мягкое начало и всё бодрее", "sunrise", ("#ffb36b", "#ff6f91"),
           energy=0.55, valence=0.72, spread=0.22, order="rising", hours=(5, 11)),
    MixDef("day", "time", "Дневная", "Энергия и хорошее настроение", "sun", ("#ffd166", "#06d6a0"),
           energy=0.74, valence=0.66, spread=0.2, order="wave", hours=(11, 17)),
    MixDef("evening", "time", "Вечерняя", "Тепло и неспешно", "sunset", ("#f78c6b", "#7b5ea7"),
           energy=0.42, valence=0.52, spread=0.2, order="falling", hours=(17, 22)),
    MixDef("night", "time", "Ночная", "Тихо, медленно, глубоко", "moon", ("#3a3f8f", "#0f1a3d"),
           energy=0.2, valence=0.38, spread=0.18, order="falling", hours=(22, 5),
           genres_plus=("ambient", "jazz", "chill", "lo-fi", "lofi", "lounge", "classical", "downtempo", "trip")),
    # ---- настроение ----
    MixDef("energetic", "mood", "Энергия", "Громко, быстро, на подъёме", "zap", ("#ff3d68", "#ff9a3d"),
           energy=0.9, valence=0.58, spread=0.16, order="wave"),
    MixDef("happy", "mood", "Радость", "Светлое и солнечное", "smile", ("#ffd23f", "#ff7eb6"),
           energy=0.64, valence=0.9, spread=0.17, order="wave"),
    MixDef("calm", "mood", "Спокойствие", "Выдохнуть и замедлиться", "leaf", ("#7dd3c0", "#3a7bd5"),
           energy=0.25, valence=0.58, spread=0.17, order="flat"),
    MixDef("melancholy", "mood", "Меланхолия", "Под дождь за окном", "cloud-rain", ("#6b7a99", "#2c3550"),
           energy=0.34, valence=0.16, spread=0.16, order="flat"),
    MixDef("focus", "mood", "Концентрация", "Ровный фон для работы", "target", ("#4facfe", "#2b5876"),
           energy=0.45, valence=0.5, spread=0.14, order="flat",
           genres_plus=("ambient", "electronic", "instrumental", "classical", "post-rock", "lo-fi", "lofi", "soundtrack", "score"),
           genres_minus=("rap", "hip-hop", "hip hop", "шансон", "chanson", "comedy", "юмор")),
    MixDef("sleep", "mood", "Для сна", "Очень тихо и медленно", "bed", ("#2b2d6e", "#0b0d24"),
           energy=0.08, valence=0.42, spread=0.14, order="falling",
           genres_plus=("ambient", "classical", "new age", "piano", "sleep"),
           genres_minus=("metal", "punk", "hardcore", "drum", "dubstep")),
    # ---- времена года ----
    MixDef("winter", "season", "Зима", "Уютно и тепло внутри", "snowflake", ("#a1c4fd", "#c2e9fb"),
           energy=0.38, valence=0.56, spread=0.24, months=(12, 1, 2),
           keywords=("зим", "снег", "снеж", "мороз", "новый год", "новогод", "ёлк", "елк", "рождеств", "декабр", "январ",
                     "winter", "snow", "christmas", "xmas", "new year", "frost", "december", "january", "cold", "ice")),
    MixDef("spring", "season", "Весна", "Всё оживает", "flower", ("#c3f584", "#ff9a9e"),
           energy=0.56, valence=0.76, spread=0.24, months=(3, 4, 5),
           keywords=("весн", "апрел", "май", "март", "цвет", "spring", "april", "may", "bloom", "flower", "rain")),
    MixDef("summer", "season", "Лето", "Солнце, море, громче", "sun", ("#f9d423", "#ff4e50"),
           energy=0.76, valence=0.82, spread=0.22, months=(6, 7, 8),
           keywords=("лет", "солн", "мор", "пляж", "жар", "июн", "июл", "август", "summer", "sun", "beach", "sea", "hot",
                     "june", "july", "august", "holiday", "island", "tropic")),
    MixDef("autumn", "season", "Осень", "Листопад и тёплый свитер", "leaf", ("#f6a35b", "#7a4b35"),
           energy=0.36, valence=0.32, spread=0.22, months=(9, 10, 11),
           keywords=("осен", "дожд", "лист", "сентябр", "октябр", "ноябр", "autumn", "fall", "rain", "leaves",
                     "september", "october", "november", "grey", "gray")),
    # ---- из истории ----
    MixDef("forgotten", "personal", "Забытое любимое", "Что вы любили, но давно не включали", "history",
           ("#ee9ca7", "#5f2c82"), order="wave"),
    MixDef("last_season", "personal", "Год назад", "Что вы слушали в это время в прошлом году", "calendar",
           ("#84fab0", "#3f5efb"), order="wave"),
]
BY_KEY = {m.key: m for m in MIXES}

# Примерный «характер» по жанру — пока звук не проанализирован, и как добавка к анализу
GENRE_HINTS: list[tuple[tuple[str, ...], float, float]] = [
    (("metal", "hardcore", "grind", "thrash", "metalcore"), 0.92, 0.35),
    (("punk",), 0.85, 0.55),
    (("drum and bass", "drum'n'bass", "dnb", "dubstep", "hardstyle", "techno"), 0.88, 0.55),
    (("house", "edm", "dance", "trance", "electro", "eurodance", "club"), 0.82, 0.72),
    (("disco", "funk"), 0.75, 0.82),
    (("reggae", "ska", "latin", "salsa", "samba", "bossa"), 0.6, 0.8),
    (("hip-hop", "hip hop", "rap", "trap", "грайм"), 0.68, 0.5),
    (("rock", "рок", "grunge", "alternative"), 0.7, 0.5),
    (("pop", "поп", "эстрад"), 0.62, 0.7),
    (("r&b", "rnb", "soul"), 0.48, 0.6),
    (("indie", "инди"), 0.55, 0.55),
    (("electronic", "электрон", "synth"), 0.62, 0.58),
    (("country", "кантри"), 0.5, 0.65),
    (("folk", "фолк", "acoustic", "singer", "бард", "авторск"), 0.33, 0.5),
    (("blues", "блюз"), 0.42, 0.35),
    (("jazz", "джаз", "swing"), 0.4, 0.6),
    (("шансон", "chanson", "романс"), 0.45, 0.42),
    (("soundtrack", "score", "ost", "саундтрек"), 0.35, 0.45),
    (("classical", "классик", "baroque", "opera", "symphon", "piano"), 0.25, 0.5),
    (("lo-fi", "lofi", "chill", "lounge", "downtempo", "trip-hop", "trip hop"), 0.25, 0.52),
    (("ambient", "эмбиент", "new age", "drone", "sleep", "meditat"), 0.12, 0.5),
    (("gothic", "doom", "darkwave", "post-punk", "emo"), 0.55, 0.2),
]


def genre_hint(genre: str) -> tuple[float, float] | None:
    g = (genre or "").lower()
    if not g:
        return None
    for words, e, v in GENRE_HINTS:
        if any(w in g for w in words):
            return e, v
    return None


# ---------------- время ----------------


def local_now() -> datetime:
    return datetime.now().astimezone()  # TZ контейнера


def current_time_mix(now: datetime | None = None) -> str:
    h = (now or local_now()).hour
    for m in MIXES:
        if m.hours:
            a, b = m.hours
            if (a <= h < b) if a < b else (h >= a or h < b):
                return m.key
    return "day"


def current_season(now: datetime | None = None) -> str:
    month = (now or local_now()).month
    return next(m.key for m in MIXES if m.group == "season" and month in m.months)


def season_months(key: str) -> tuple[int, ...]:
    return BY_KEY[key].months


# ---------------- данные пользователя ----------------


@dataclass
class Cand:
    id: int
    artist_id: int | None
    album_id: int
    genre: str
    text: str  # название + альбом — для ключевых слов
    energy: float = 0.5
    valence: float = 0.5
    analyzed: bool = False
    starred: float = 0.0
    plays: int = 0
    last_played: datetime | None = None
    hours: list[int] = field(default_factory=list)
    year: int | None = None
    bpm: float = 0.0


def _rank(values: list[float]) -> list[float]:
    """Перцентильный ранг 0..1 — подборки не зависят от абсолютной калибровки анализа."""
    if not values:
        return []
    order = sorted(range(len(values)), key=lambda i: values[i])
    ranks = [0.0] * len(values)
    n = max(1, len(values) - 1)
    for pos, i in enumerate(order):
        ranks[i] = pos / n
    return ranks


def load_pool(db: Session, user: User) -> dict[int, Cand]:
    libs = allowed_library_ids(db, user)
    if not libs:
        return {}
    rows = db.execute(
        select(Track.id, Track.artist_id, Track.album_id, Track.genre, Track.title, Album.name,
               TrackFeature.energy, TrackFeature.valence, TrackFeature.version, TrackFeature.error,
               Track.year, TrackFeature.bpm)
        .join(Album, Album.id == Track.album_id)
        .outerjoin(TrackFeature, TrackFeature.track_id == Track.id)
        .where(Track.library_id.in_(libs))
    ).all()
    pool: dict[int, Cand] = {}
    analyzed: list[Cand] = []
    for tid, artist_id, album_id, genre, title, album, e, v, ver, err, year, bpm in rows:
        c = Cand(tid, artist_id, album_id, genre or "", f"{title} {album}".lower(), year=year, bpm=float(bpm or 0))
        if ver and err is None and e is not None:
            c.energy, c.valence, c.analyzed = float(e), float(v), True
            analyzed.append(c)
        pool[tid] = c
    # анализ → ранги по медиатеке пользователя, плюс немного жанра
    for c, re_, rv in zip(analyzed, _rank([c.energy for c in analyzed]), _rank([c.valence for c in analyzed])):
        hint = genre_hint(c.genre)
        if hint:
            c.energy, c.valence = 0.8 * re_ + 0.2 * hint[0], 0.8 * rv + 0.2 * hint[1]
        else:
            c.energy, c.valence = re_, rv
    for c in pool.values():
        if not c.analyzed:
            hint = genre_hint(c.genre)
            c.energy, c.valence = hint if hint else (0.5, 0.5)

    # избранное
    stars = db.execute(select(Star.kind, Star.item_id).where(Star.user_id == user.id)).all()
    s_track = {i for k, i in stars if k == "track"}
    s_album = {i for k, i in stars if k == "album"}
    s_artist = {i for k, i in stars if k == "artist"}
    for c in pool.values():
        c.starred = (0.35 if c.id in s_track else 0) + (0.2 if c.album_id in s_album else 0) + (
            0.15 if c.artist_id in s_artist else 0
        )
    # история: сколько раз, когда последний раз, в какие часы
    since = datetime.now(timezone.utc) - timedelta(days=730)
    for tid, played_at in db.execute(
        select(Play.track_id, Play.played_at).where(Play.user_id == user.id, Play.played_at >= since)
    ):
        c = pool.get(tid)
        if c is None:
            continue
        at = played_at if played_at.tzinfo else played_at.replace(tzinfo=timezone.utc)
        c.plays += 1
        if c.last_played is None or at > c.last_played:
            c.last_played = at
        c.hours.append(at.astimezone().hour)
    return pool


# ---------------- генерация ----------------


def _in_hours(h: int, hours: tuple[int, int]) -> bool:
    a, b = hours
    return (a <= h < b) if a < b else (h >= a or h < b)


def _score(m: MixDef, c: Cand, now: datetime, rng: random.Random) -> float:
    de = (c.energy - m.energy) / m.spread
    dv = (c.valence - m.valence) / (m.spread * 1.25)  # «настроение» определяется менее уверенно — мягче
    fit = math.exp(-0.5 * (de * de + dv * dv))
    g = c.genre.lower()
    if m.genres_plus and any(w in g for w in m.genres_plus):
        fit = min(1.0, fit * 1.35 + 0.1)
    if m.genres_minus and any(w in g for w in m.genres_minus):
        fit *= 0.25
    personal = c.starred + 0.25 * min(1.0, math.log1p(c.plays) / math.log(20))
    if m.hours and len(c.hours) >= 2:
        share = sum(1 for h in c.hours if _in_hours(h, m.hours)) / len(c.hours)
        personal += 0.35 * share
    if m.keywords and any(k in c.text for k in m.keywords):
        fit = max(fit, 0.6)
        personal += 0.5
    if c.last_played and now - c.last_played < timedelta(days=2):
        personal -= 0.35  # недавно звучало — пусть отдохнёт
    elif c.plays == 0:
        personal += 0.08  # немного «открытий»
    return fit * max(0.2, 1 + personal) * rng.uniform(0.75, 1.25)


def _arrange(m: MixDef, picked: list[Cand]) -> list[Cand]:
    if m.order == "rising":
        picked.sort(key=lambda c: c.energy)
    elif m.order == "falling":
        picked.sort(key=lambda c: -c.energy)
    elif m.order == "wave":
        # «холм»: от спокойного к пику в середине и обратно
        s = sorted(picked, key=lambda c: c.energy)
        picked = s[0::2] + s[1::2][::-1]
    # тот же исполнитель не подряд
    for i in range(1, len(picked)):
        if picked[i].artist_id is not None and picked[i].artist_id == picked[i - 1].artist_id:
            for j in range(i + 1, len(picked)):
                if picked[j].artist_id != picked[i - 1].artist_id:
                    picked[i], picked[j] = picked[j], picked[i]
                    break
    return picked


def _pick(scored: list[tuple[float, Cand]], size: int = MIX_SIZE) -> list[Cand]:
    scored.sort(key=lambda x: -x[0])
    by_artist: dict = {}
    by_album: dict = {}
    out: list[Cand] = []
    for _, c in scored:
        if by_artist.get(c.artist_id, 0) >= ARTIST_CAP or by_album.get(c.album_id, 0) >= ALBUM_CAP:
            continue
        out.append(c)
        by_artist[c.artist_id] = by_artist.get(c.artist_id, 0) + 1
        by_album[c.album_id] = by_album.get(c.album_id, 0) + 1
        if len(out) >= size:
            break
    return out


def generate(db: Session, user: User, key: str, pool: dict[int, Cand], seed: str) -> list[int]:
    m = BY_KEY[key]
    rng = random.Random(f"{user.id}:{key}:{seed}")
    now = datetime.now(timezone.utc)
    hidden = set(db.scalars(select(MixFeedback.track_id).where(MixFeedback.user_id == user.id, MixFeedback.key == key)))
    cands = [c for c in pool.values() if c.id not in hidden]

    if key == "forgotten":
        # любимое или часто игравшее, но не звучавшее больше двух месяцев
        old = now - timedelta(days=60)
        cands = [c for c in cands if (c.starred > 0 or c.plays >= 3) and (c.last_played is None or c.last_played < old)]
        scored = [((c.starred + math.log1p(c.plays)) * rng.uniform(0.7, 1.3), c) for c in cands]
        return [c.id for c in _arrange(m, _pick(scored))]
    if key == "last_season":
        months = season_months(current_season())
        counts: dict[int, int] = {}
        start = now - timedelta(days=430)
        end = now - timedelta(days=300)
        for tid, played_at in db.execute(
            select(Play.track_id, Play.played_at).where(Play.user_id == user.id, Play.played_at >= start, Play.played_at <= end)
        ):
            at = played_at if played_at.tzinfo else played_at.replace(tzinfo=timezone.utc)
            if at.astimezone().month in months and tid in pool and tid not in hidden:
                counts[tid] = counts.get(tid, 0) + 1
        scored = [(n * rng.uniform(0.8, 1.2), pool[tid]) for tid, n in counts.items()]
        return [c.id for c in _arrange(m, _pick(scored))]

    scored = [(_score(m, c, now, rng), c) for c in cands]
    # совсем неподходящие не берём, но если медиатека маленькая — порог мягче
    good = [x for x in scored if x[0] > 0.12]
    if len(good) < MIX_SIZE // 2:
        good = scored
    return [c.id for c in _arrange(m, _pick(good))]


def _today() -> str:
    return local_now().strftime("%Y-%m-%d")


def forget_user(db: Session, user: User) -> None:
    """Сменился состав медиатеки пользователя («Вся / Общая / Моя») — подборки на сегодня собрать заново."""
    for key in [k for k in _pool_cache if isinstance(k, tuple) and k[0] == user.id]:
        _pool_cache.pop(key, None)
    db.execute(delete(UserMix).where(UserMix.user_id == user.id))


def get_mix(db: Session, user: User, key: str, pool_cache: dict | None = None, refresh: bool = False) -> list[int]:
    """Треки подборки на сегодня (из кэша или собранные заново)."""
    row = db.get(UserMix, (user.id, key))
    today = _today()
    if row and row.day == today and not refresh:
        return json.loads(row.track_ids or "[]")
    if pool_cache is not None and "pool" in pool_cache:
        pool = pool_cache["pool"]
    else:
        pool = load_pool(db, user)
        if pool_cache is not None:
            pool_cache["pool"] = pool
    seed = (row.seed + 1) if row else 1
    ids = generate(db, user, key, pool, f"{today}:{seed}")  # своя случайность на каждый день и «Обновить»
    if row is None:
        row = UserMix(user_id=user.id, key=key)
        db.add(row)
    row.day = today
    row.seed = seed
    row.track_ids = json.dumps(ids)
    row.created_at = datetime.now(timezone.utc)
    db.commit()
    return ids


def hide_track(db: Session, user: User, key: str, track_id: int) -> None:
    if not db.get(MixFeedback, (user.id, key, track_id)):
        db.add(MixFeedback(user_id=user.id, key=key, track_id=track_id))
    row = db.get(UserMix, (user.id, key))
    if row:
        ids = [i for i in json.loads(row.track_ids or "[]") if i != track_id]
        row.track_ids = json.dumps(ids)
    db.commit()


def visible_mixes() -> list[MixDef]:
    return MIXES


def subsonic_keys() -> list[str]:
    """Какие подборки показывать Subsonic-приложениям как плейлисты (чтобы не засорять список)."""
    return [current_time_mix(), current_season(), "energetic", "happy", "calm", "melancholy", "focus", "sleep", "forgotten"]



# ---------------- «Радио»: похожие треки ----------------

_pool_cache: dict[tuple[int, str], tuple[float, dict[int, Cand]]] = {}


def cached_pool(db: Session, user: User, ttl: float = 600) -> dict[int, Cand]:
    """Радио дозапрашивает треки много раз подряд — пул держим в памяти 10 минут."""
    import time  # noqa: PLC0415

    now = time.monotonic()
    key = (user.id, getattr(user, "library_scope", "all"))
    hit = _pool_cache.get(key)
    if hit and now - hit[0] < ttl:
        return hit[1]
    pool = load_pool(db, user)
    _pool_cache[key] = (now, pool)
    if len(_pool_cache) > 50:
        _pool_cache.pop(next(iter(_pool_cache)))
    return pool


def _genre_words(g: str) -> set[str]:
    return {w for w in re.split(r"[\s/,;&-]+", g.lower()) if len(w) > 2}


def radio(
    db: Session,
    user: User,
    *,
    track_id: int | None = None,
    artist_id: int | None = None,
    exclude: set[int] | None = None,
    count: int = 25,
) -> list[int]:
    """Похожие на трек (или на исполнителя) по энергии, настроению, темпу, жанру и году,
    с учётом вкуса пользователя. Повторов из exclude нет, одного исполнителя — не больше двух подряд в выдаче."""
    pool = cached_pool(db, user)
    exclude = set(exclude or ())
    seeds: list[Cand] = []
    if track_id and track_id in pool:
        seeds = [pool[track_id]]
        exclude.add(track_id)
    elif artist_id:
        seeds = [c for c in pool.values() if c.artist_id == artist_id]
    if not seeds:
        return []
    e = sum(c.energy for c in seeds) / len(seeds)
    v = sum(c.valence for c in seeds) / len(seeds)
    bpms = [c.bpm for c in seeds if c.bpm]
    bpm = sum(bpms) / len(bpms) if bpms else 0
    years = [c.year for c in seeds if c.year]
    year = sum(years) / len(years) if years else None
    genres: set[str] = set()
    for c in seeds[:50]:
        genres |= _genre_words(c.genre)
    seed_artists = {c.artist_id for c in seeds}

    rng = random.Random()
    now = datetime.now(timezone.utc)
    scored: list[tuple[float, Cand]] = []
    for c in pool.values():
        if c.id in exclude:
            continue
        d2 = ((c.energy - e) / 0.16) ** 2 + ((c.valence - v) / 0.2) ** 2
        if bpm and c.bpm:
            ratio = max(c.bpm, bpm) / min(c.bpm, bpm)
            ratio = min(ratio, abs(ratio - 2) + 1)  # 70 и 140 — один «грув»
            d2 += ((ratio - 1) / 0.12) ** 2
        fit = math.exp(-0.5 * d2)
        cg = _genre_words(c.genre)
        if genres and cg & genres:
            fit = fit * 1.6 + 0.15
        elif genres and cg:
            fit *= 0.6
        if year and c.year:
            fit *= math.exp(-abs(c.year - year) / 15)
        if c.artist_id in seed_artists:
            fit *= 1.3 if track_id else 1.6
        personal = c.starred + 0.2 * min(1.0, math.log1p(c.plays) / math.log(20))
        if c.last_played and now - c.last_played < timedelta(hours=6):
            personal -= 0.4
        scored.append((fit * max(0.2, 1 + personal) * rng.uniform(0.7, 1.3), c))
    scored.sort(key=lambda x: -x[0])
    out: list[Cand] = []
    per_artist: dict = {}
    for _, c in scored[: count * 8]:
        cap = 3 if c.artist_id in seed_artists else 2
        if per_artist.get(c.artist_id, 0) >= cap:
            continue
        out.append(c)
        per_artist[c.artist_id] = per_artist.get(c.artist_id, 0) + 1
        if len(out) >= count:
            break
    rng.shuffle(out)
    # тот же исполнитель не подряд
    for i in range(1, len(out)):
        if out[i].artist_id == out[i - 1].artist_id:
            for j in range(i + 1, len(out)):
                if out[j].artist_id != out[i - 1].artist_id:
                    out[i], out[j] = out[j], out[i]
                    break
    return [c.id for c in out]
