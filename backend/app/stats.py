"""Статистика прослушиваний и «Итоги года».

Источник — таблица plays (скробблы: трек засчитывается после половины или 4 минут),
поэтому время прослушивания ≈ сумма длительностей засчитанных треков.
Агрегируем в Python, а не SQL-функциями дат: так одинаково работает на SQLite и MariaDB
и можно считать часы/дни недели в часовом поясе пользователя.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .models import Album, Artist, Play, Track, TrackFeature, User
from .scanner import UNKNOWN_ARTIST, VARIOUS
from .serialize import albums_out, artist_out, cover_url, tracks_out

SKIP_ARTISTS = {VARIOUS, UNKNOWN_ARTIST, ""}


def _aware(dt: datetime) -> datetime:
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt


@dataclass
class Row:
    at: datetime  # в часовом поясе пользователя (naive, уже сдвинуто)
    track_id: int
    album_id: int
    artist_id: int | None
    artist_name: str
    genre: str
    duration: float
    user_id: int


def _rows(db: Session, user_ids: list[int] | None, lib_ids: list[int], start: datetime | None, end: datetime | None, tz_min: int) -> list[Row]:
    q = (
        select(Play.played_at, Track.id, Track.album_id, Track.artist_id, Track.artist_name, Track.genre, Track.duration, Play.user_id)
        .join(Track, Track.id == Play.track_id)
        .where(Track.library_id.in_(lib_ids or [-1]))
    )
    if user_ids is not None:
        q = q.where(Play.user_id.in_(user_ids or [-1]))
    if start is not None:
        q = q.where(Play.played_at >= start)
    if end is not None:
        q = q.where(Play.played_at < end)
    shift = timedelta(minutes=tz_min)
    out = []
    for at, tid, aid, arid, aname, genre, dur, uid in db.execute(q.order_by(Play.played_at)):
        out.append(Row((_aware(at) + shift).replace(tzinfo=None), tid, aid, arid, aname or "", genre or "", float(dur or 0), uid))
    return out


def _artist_covers(db: Session, artist_ids: list[int], lib_ids: list[int]) -> dict[int, Album]:
    """Обложка исполнителя: свой альбом с обложкой, иначе альбом, где он есть в треках."""
    if not artist_ids:
        return {}
    own = db.execute(
        select(Album.artist_id, func.max(Album.id))
        .where(Album.artist_id.in_(artist_ids), Album.cover.is_not(None), Album.library_id.in_(lib_ids or [-1]))
        .group_by(Album.artist_id)
    ).all()
    ids = {a: alb for a, alb in own}
    missing = [a for a in artist_ids if a not in ids]
    if missing:
        for a, alb in db.execute(
            select(Track.artist_id, func.max(Album.id))
            .join(Album, Album.id == Track.album_id)
            .where(Track.artist_id.in_(missing), Album.cover.is_not(None), Album.library_id.in_(lib_ids or [-1]))
            .group_by(Track.artist_id)
        ):
            ids[a] = alb
    albums = {a.id: a for a in db.scalars(select(Album).where(Album.id.in_(list(ids.values()) or [-1])))}
    return {a: albums[alb] for a, alb in ids.items() if alb in albums}


def artist_cards(db: Session, counted: list[tuple[int, int, float]], lib_ids: list[int]) -> list[dict]:
    """counted: [(artist_id, plays, seconds)] → карточки исполнителей с числом прослушиваний."""
    ids = [a for a, _, _ in counted]
    artists = {a.id: a for a in db.scalars(select(Artist).where(Artist.id.in_(ids or [-1])))}
    covers = _artist_covers(db, ids, lib_ids)
    from .metadata import artist_images  # noqa: PLC0415

    photos = artist_images(db, ids)
    out = []
    for aid, plays, secs in counted:
        a = artists.get(aid)
        if a is None:
            continue
        out.append({**artist_out(a, 0, photos.get(aid) or cover_url(covers.get(aid))), "plays": plays, "seconds": int(secs)})
    return out


def favorite_artists(db: Session, user: User, lib_ids: list[int], limit: int = 10) -> list[dict]:
    """Любимые исполнители для главной: за последние 90 дней, при малой истории — за всё время."""
    for days in (90, None):
        q = (
            select(Track.artist_id, func.count(Play.id).label("cnt"), func.sum(Track.duration))
            .join(Track, Track.id == Play.track_id)
            .where(
                Play.user_id == user.id,
                Track.library_id.in_(lib_ids or [-1]),
                Track.artist_id.is_not(None),
                Track.artist_name.not_in(SKIP_ARTISTS),
            )
            .group_by(Track.artist_id)
            .order_by(func.count(Play.id).desc())
            .limit(limit)
        )
        if days:
            q = q.where(Play.played_at >= datetime.now(timezone.utc) - timedelta(days=days))
        rows = [(a, int(c), float(s or 0)) for a, c, s in db.execute(q)]
        if len(rows) >= 4 or days is None:
            return artist_cards(db, rows, lib_ids)
    return []


def years_with_plays(db: Session, user_ids: list[int] | None, tz_min: int = 0) -> list[int]:
    """Годы (в часовом поясе пользователя), в которые что-то слушали, — от свежего к старому."""
    q = select(func.min(Play.played_at), func.max(Play.played_at))
    if user_ids is not None:
        q = q.where(Play.user_id.in_(user_ids or [-1]))
    lo, hi = db.execute(q).one()
    if not lo:
        return []
    shift = timedelta(minutes=tz_min)
    return list(range((_aware(hi) + shift).year, (_aware(lo) + shift).year - 1, -1))


def _streak(days: set[date]) -> tuple[int, date | None]:
    best, best_end, cur, prev = 0, None, 0, None
    for d in sorted(days):
        cur = cur + 1 if prev and d - prev == timedelta(days=1) else 1
        if cur > best:
            best, best_end = cur, d
        prev = d
    return best, best_end


def _period(kind: str, year: int | None, tz_min: int) -> tuple[datetime | None, datetime | None, str]:
    """Границы периода в UTC и тип шкалы (day/month/year)."""
    shift = timedelta(minutes=tz_min)
    now_local = datetime.now(timezone.utc) + shift
    today = datetime(now_local.year, now_local.month, now_local.day)
    if kind == "week":
        start, end, scale = today - timedelta(days=6), today + timedelta(days=1), "day"
    elif kind == "month":
        start, end, scale = today - timedelta(days=29), today + timedelta(days=1), "day"
    elif kind == "year":
        y = year or now_local.year
        start, end, scale = datetime(y, 1, 1), datetime(y + 1, 1, 1), "month"
    else:
        return None, None, "year"
    # обратно в UTC
    return (start - shift).replace(tzinfo=timezone.utc), (end - shift).replace(tzinfo=timezone.utc), scale


def compute(
    db: Session,
    lib_ids: list[int],
    user_ids: list[int] | None,
    viewer: User,
    kind: str = "year",
    year: int | None = None,
    tz_min: int = 0,
) -> dict:
    start, end, scale = _period(kind, year, tz_min)
    rows = _rows(db, user_ids, lib_ids, start, end, tz_min)
    seconds = sum(r.duration for r in rows)

    # сравнение с предыдущим таким же периодом
    prev = None
    if start is not None and end is not None:
        span = end - start
        if kind == "year":
            p_start = start.replace(year=start.year - 1)
            p_end = start
        else:
            p_start, p_end = start - span, start
        pq = select(func.count(Play.id), func.coalesce(func.sum(Track.duration), 0)).join(Track, Track.id == Play.track_id)
        pq = pq.where(Track.library_id.in_(lib_ids or [-1]), Play.played_at >= p_start, Play.played_at < p_end)
        if user_ids is not None:
            pq = pq.where(Play.user_id.in_(user_ids or [-1]))
        pc, ps = db.execute(pq).one()
        prev = {"plays": int(pc or 0), "seconds": int(ps or 0)}

    # топы
    by_artist: dict[int, list[float]] = defaultdict(lambda: [0, 0.0])
    by_track: Counter[int] = Counter()
    by_album: Counter[int] = Counter()
    by_genre: Counter[str] = Counter()
    genre_secs: Counter[str] = Counter()
    for r in rows:
        if r.artist_id and r.artist_name not in SKIP_ARTISTS:
            by_artist[r.artist_id][0] += 1
            by_artist[r.artist_id][1] += r.duration
        by_track[r.track_id] += 1
        by_album[r.album_id] += 1
        for g in {g.strip() for g in r.genre.replace(";", "/").split("/") if g.strip()}:
            by_genre[g] += 1
            genre_secs[g] += r.duration

    top_artist_ids = sorted(by_artist.items(), key=lambda kv: (-kv[1][0], -kv[1][1]))[:10]
    top_artists = artist_cards(db, [(a, int(v[0]), v[1]) for a, v in top_artist_ids], lib_ids)

    track_ids = [t for t, _ in by_track.most_common(10)]
    tmap = {t.id: t for t in db.scalars(select(Track).where(Track.id.in_(track_ids or [-1])))}
    t_out = tracks_out(db, viewer.id, [tmap[i] for i in track_ids if i in tmap])
    for t in t_out:
        t["plays"] = by_track[t["id"]]

    album_ids = [a for a, _ in by_album.most_common(10)]
    amap = {a.id: a for a in db.scalars(select(Album).where(Album.id.in_(album_ids or [-1])))}
    a_out = albums_out(db, viewer.id, [amap[i] for i in album_ids if i in amap])
    for a in a_out:
        a["plays"] = by_album[a["id"]]

    total_g = sum(by_genre.values()) or 1
    genres = [{"name": g, "plays": n, "share": round(n / total_g, 4), "seconds": int(genre_secs[g])} for g, n in by_genre.most_common(8)]

    # время: шкала, часы, дни недели
    hours = [0.0] * 24
    weekdays = [0.0] * 7
    days: Counter[date] = Counter()
    day_secs: Counter[date] = Counter()
    for r in rows:
        hours[r.at.hour] += r.duration
        weekdays[r.at.weekday()] += r.duration
        days[r.at.date()] += 1
        day_secs[r.at.date()] += r.duration

    timeline: list[dict] = []
    if scale == "month":
        y = (start + timedelta(minutes=tz_min)).year if start else datetime.now().year
        per = Counter()
        for r in rows:
            per[r.at.month] += r.duration
        timeline = [{"key": f"{y}-{m:02d}", "seconds": int(per[m])} for m in range(1, 13)]
    elif scale == "day" and start is not None and end is not None:
        d0 = (start + timedelta(minutes=tz_min)).date()
        n = (end - start).days
        timeline = [{"key": (d0 + timedelta(days=i)).isoformat(), "seconds": int(day_secs[d0 + timedelta(days=i)])} for i in range(n)]
    else:
        per = Counter()
        for r in rows:
            per[r.at.year] += r.duration
        timeline = [{"key": str(y), "seconds": int(per[y])} for y in sorted(per)]

    # хайлайты
    streak, streak_end = _streak(set(days))
    top_day = max(day_secs.items(), key=lambda kv: kv[1]) if day_secs else None
    # «на повторе»: больше всего прослушиваний одного трека за день
    per_day_track: Counter[tuple[date, int]] = Counter((r.at.date(), r.track_id) for r in rows)
    repeat = per_day_track.most_common(1)[0] if per_day_track else None
    repeat_out = None
    if repeat and repeat[1] >= 3:
        t = db.get(Track, repeat[0][1])
        if t:
            repeat_out = {"date": repeat[0][0].isoformat(), "count": repeat[1], "track": tracks_out(db, viewer.id, [t])[0]}
    first_out = None
    if rows:
        t = db.get(Track, rows[0].track_id)
        if t:
            first_out = {"at": rows[0].at.isoformat(), "track": tracks_out(db, viewer.id, [t])[0]}

    # открытия: исполнители, которых раньше не слушали
    new_artists = 0
    if start is not None and by_artist:
        q = select(Track.artist_id).join(Play, Play.track_id == Track.id).where(Play.played_at < start, Track.artist_id.in_(list(by_artist)))
        if user_ids is not None:
            q = q.where(Play.user_id.in_(user_ids or [-1]))
        before = set(db.scalars(q.distinct()))
        new_artists = len(set(by_artist) - before)

    # звучание: энергия, настроение, темп (если библиотека проанализирована)
    sound = None
    if rows:
        feats = {
            f.track_id: f
            for f in db.scalars(select(TrackFeature).where(TrackFeature.track_id.in_(list({r.track_id for r in rows}))))
            if f.error is None and f.energy is not None
        }
        w = e = v = b = 0.0
        bw = 0.0
        for r in rows:
            f = feats.get(r.track_id)
            if not f:
                continue
            w += 1
            e += float(f.energy or 0)
            v += float(f.valence or 0)
            if f.bpm:
                b += float(f.bpm)
                bw += 1
        if w >= max(5, len(rows) * 0.3):
            sound = {
                "energy": round(e / w, 3),
                "valence": round(v / w, 3),
                "bpm": round(b / bw) if bw else None,
                "coverage": round(w / len(rows), 3),
            }
            le, lv = db.execute(
                select(func.avg(TrackFeature.energy), func.avg(TrackFeature.valence))
                .join(Track, Track.id == TrackFeature.track_id)
                .where(TrackFeature.error.is_(None), Track.library_id.in_(lib_ids or [-1]))
            ).one()
            sound["library_energy"] = round(float(le or 0.5), 3)
            sound["library_valence"] = round(float(lv or 0.5), 3)

    # по пользователям (для администратора в режиме «весь сервер»)
    users_out = None
    if user_ids is None:
        per_user: dict[int, list[float]] = defaultdict(lambda: [0, 0.0])
        for r in rows:
            per_user[r.user_id][0] += 1
            per_user[r.user_id][1] += r.duration
        umap = {u.id: u for u in db.scalars(select(User).where(User.id.in_(list(per_user) or [-1])))}
        users_out = [
            {"id": uid, "name": umap[uid].display_name or umap[uid].username, "avatar": umap[uid].avatar, "plays": int(v[0]), "seconds": int(v[1])}
            for uid, v in sorted(per_user.items(), key=lambda kv: -kv[1][1])
            if uid in umap
        ]

    return {
        "kind": kind,
        # какой год на самом деле показан (без явного — текущий в часовом поясе пользователя)
        "year": (year or (datetime.now(timezone.utc) + timedelta(minutes=tz_min)).year) if kind == "year" else None,
        "scale": scale,
        "totals": {
            "plays": len(rows),
            "seconds": int(seconds),
            "tracks": len(by_track),
            "artists": len(by_artist),
            "albums": len(by_album),
            "days": len(days),
            "new_artists": new_artists,
        },
        "previous": prev,
        "top_artists": top_artists,
        "top_tracks": t_out,
        "top_albums": a_out,
        "genres": genres,
        "timeline": timeline,
        "hours": [int(h) for h in hours],
        "weekdays": [int(d) for d in weekdays],
        "highlights": {
            "streak": streak,
            "streak_end": streak_end.isoformat() if streak_end else None,
            "top_day": {"date": top_day[0].isoformat(), "seconds": int(top_day[1]), "plays": days[top_day[0]]} if top_day else None,
            "repeat": repeat_out,
            "first": first_out,
        },
        "sound": sound,
        "users": users_out,
    }
