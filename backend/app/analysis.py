"""Анализ звука для подборок: темп, энергия, «яркость», лад → две оси настроения.

Работает в одном фоновом потоке с минимальным приоритетом (nice 19 для потока и ffmpeg,
ionice «idle» для чтения с диска), только в разрешённые часы (по умолчанию ночью).
Каждый трек анализируется один раз; заново — только если файл изменился.

Из файла берём до 45 секунд из середины, моно 22 кГц, и считаем на numpy:
- громкость (RMS, dBFS) и её разброс;
- спектральный центроид — насколько звук «яркий»;
- огибающую атак (spectral flux) → плотность событий и темп (автокорреляция);
- хрому (12 нот) → мажор/минор по профилям Крумхансла.
Из этого — energy (спокойно ↔ энергично) и valence (грустно ↔ радостно), 0..1.
"""
from __future__ import annotations

import logging
import os
import shutil
import subprocess
import threading
import time
from datetime import datetime, timezone

import numpy as np
from sqlalchemy import or_, select

from . import db as dbmod
from .app_settings import get_setting, set_setting
from .config import settings
from .models import Library, Track, TrackFeature

log = logging.getLogger("uvicorn.error")

ANALYSIS_VERSION = 1
SR = 22050
SEGMENT = 45.0  # сек
N_FFT = 2048
HOP = 512

# Профили тональностей Крумхансла — Кесслер
_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
_NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _norm(x: float, lo: float, hi: float) -> float:
    return float(min(1.0, max(0.0, (x - lo) / (hi - lo))))


# ---------------- чтение звука ----------------


def _low_priority() -> None:
    try:
        os.nice(19)
    except OSError:
        pass


def decode(path: str, duration: float) -> np.ndarray | None:
    """Кусок трека из середины: моно float32, 22 кГц."""
    start = 0.0
    if duration > SEGMENT + 20:
        start = max(0.0, min(duration * 0.35, duration - SEGMENT - 5))
    cmd = [settings.ffmpeg, "-v", "error", "-nostdin", "-threads", "1"]
    if start > 0:
        cmd += ["-ss", f"{start:.1f}"]
    cmd += ["-t", f"{SEGMENT:.0f}", "-i", path, "-map", "0:a:0", "-vn", "-ac", "1", "-ar", str(SR), "-f", "s16le", "pipe:1"]
    if shutil.which("ionice"):
        cmd = ["ionice", "-c3", *cmd]  # диск — только когда он больше никому не нужен
    try:
        out = subprocess.run(cmd, capture_output=True, timeout=120, preexec_fn=_low_priority, check=False).stdout
    except (OSError, subprocess.TimeoutExpired):
        return None
    if len(out) < SR * 2 * 3:  # меньше 3 секунд звука
        return None
    return np.frombuffer(out, dtype="<i2").astype(np.float32) / 32768.0


# ---------------- признаки ----------------


def features(y: np.ndarray) -> dict:
    n_frames = 1 + (len(y) - N_FFT) // HOP
    if n_frames < 20:
        raise ValueError("слишком короткий фрагмент")
    idx = np.arange(N_FFT)[None, :] + HOP * np.arange(n_frames)[:, None]
    frames = y[idx] * np.hanning(N_FFT)[None, :].astype(np.float32)
    mag = np.abs(np.fft.rfft(frames, axis=1)).astype(np.float32)  # (кадры, частоты)
    freqs = np.fft.rfftfreq(N_FFT, 1 / SR)

    # громкость по кадрам; тишину (паузы, затухания) не учитываем
    rms = np.sqrt(np.mean((y[idx]) ** 2, axis=1) + 1e-12)
    db = 20 * np.log10(rms + 1e-9)
    loud = db[db > -60]
    if len(loud) < 10:
        raise ValueError("тишина")
    loudness = float(np.mean(loud))
    dynamics = float(np.std(loud))

    # «яркость»
    power = mag.sum(axis=1) + 1e-9
    centroid = float(np.median((mag * freqs[None, :]).sum(axis=1) / power))

    # огибающая атак: положительный прирост логарифмического спектра
    logmag = np.log1p(mag * 10)
    flux = np.maximum(0, np.diff(logmag, axis=0)).sum(axis=1)
    flux = flux - np.convolve(flux, np.ones(16) / 16, mode="same")  # убираем медленный тренд
    flux = np.maximum(flux, 0)
    env = flux / (flux.max() + 1e-9)
    fps = SR / HOP
    # плотность событий: атаки считаем относительно общего уровня спектра, иначе у ровного
    # тона (пэд, струнные) шум огибающей выглядел бы как частые удары
    raw_flux = np.maximum(0, np.diff(logmag, axis=0)).sum(axis=1)
    novelty = raw_flux / (logmag.sum(axis=1)[1:] + 1e-9)
    thr = max(0.08, float(novelty.mean() + novelty.std()))
    is_peak = (novelty[1:-1] > thr) & (novelty[1:-1] >= novelty[:-2]) & (novelty[1:-1] > novelty[2:])
    peak_idx = np.flatnonzero(is_peak)
    count, last = 0, -10
    for i in peak_idx:  # не чаще чем раз в ~0.1 с
        if i - last >= 4:
            count += 1
            last = i
    onset_rate = float(count / (len(novelty) / fps))
    percussive = float(np.clip(novelty.mean() / 0.15, 0, 1))  # насколько звук «ударный»

    # темп: автокорреляция огибающей в диапазоне 60–190 BPM с мягким предпочтением ~120
    e = env - env.mean()
    ac = np.correlate(e, e, mode="full")[len(e) - 1 :]
    ac = ac / (ac[0] + 1e-9)
    lags = np.arange(len(ac))
    bpm_axis = 60 * fps / np.maximum(lags, 1)
    band = (bpm_axis >= 60) & (bpm_axis <= 190)
    weight = np.exp(-0.5 * (np.log2(bpm_axis / 120) / 0.9) ** 2)
    scored = np.where(band, ac * weight, -1)
    best = int(np.argmax(scored))
    bpm = float(bpm_axis[best]) if band[best] else 0.0
    pulse = float(ac[best]) if band[best] else 0.0  # насколько ритм чёткий

    # хрома → лад
    sel = (freqs > 65) & (freqs < 2100)
    pitch = np.round(12 * np.log2(freqs[sel] / 440.0) + 69).astype(int) % 12
    spec = mag[:, sel].mean(axis=0)
    chroma = np.bincount(pitch, weights=spec, minlength=12)
    chroma = chroma / (chroma.sum() + 1e-9)
    best_major = max((np.corrcoef(np.roll(_MAJOR, k), chroma)[0, 1], k) for k in range(12))
    best_minor = max((np.corrcoef(np.roll(_MINOR, k), chroma)[0, 1], k) for k in range(12))
    mode = float(best_major[0] - best_minor[0])  # > 0 — скорее мажор
    key = (_NOTES[best_major[1]] if mode >= 0 else _NOTES[best_minor[1]] + "m")

    if count < 3:
        pulse = 0.0  # ударов нет — и «чёткого ритма» тоже
    energy = (
        0.30 * _norm(loudness, -28, -7)
        + 0.20 * _norm(onset_rate, 0.5, 5.0)
        + 0.15 * percussive
        + 0.15 * _norm(centroid, 700, 3200)
        + 0.10 * (_norm(bpm, 65, 170) if pulse > 0 else 0.0)
        + 0.10 * _norm(pulse, 0.05, 0.5)
    )
    valence = (
        0.45 * float(1 / (1 + np.exp(-mode * 12)))
        + 0.20 * _norm(centroid, 700, 3200)
        + 0.20 * (_norm(bpm, 65, 160) if pulse > 0 else 0.3)
        + 0.15 * _norm(loudness, -28, -7)
    )
    return {
        "bpm": round(bpm, 1),
        "loudness": round(loudness, 2),
        "dynamics": round(dynamics, 2),
        "centroid": round(centroid, 1),
        "onset_rate": round(onset_rate, 3),
        "pulse": round(pulse, 3),
        "mode": round(mode, 4),
        "musical_key": key,
        "energy": round(float(energy), 4),
        "valence": round(float(valence), 4),
    }


def analyze_file(path: str, duration: float) -> dict:
    y = decode(path, duration)
    if y is None:
        raise ValueError("не удалось прочитать звук")
    return features(y)


# ---------------- фоновый анализатор ----------------


def _parse_hm(value: str, default: int) -> int:
    try:
        h, m = value.strip().split(":")
        return (int(h) % 24) * 60 + int(m) % 60
    except (ValueError, AttributeError):
        return default


def in_window(start: str, end: str, now: datetime | None = None) -> bool:
    now = now or datetime.now().astimezone()  # TZ контейнера (TZ: Asia/Novosibirsk в compose)
    s, e = _parse_hm(start, 60), _parse_hm(end, 420)
    cur = now.hour * 60 + now.minute
    if s == e:
        return True  # «круглосуточно»
    return s <= cur < e if s < e else (cur >= s or cur < e)


class Analyzer:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._force_until_done = False
        self._wake = threading.Event()
        self.state: dict = {"running": False, "current": None, "done_session": 0, "last_error": None, "paused_reason": ""}

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._loop, daemon=True, name="analyzer")
        self._thread.start()

    def run_now(self) -> None:
        """Кнопка «Анализировать сейчас»: без учёта часов, пока не закончатся треки."""
        self._force_until_done = True
        self._wake.set()

    def stop_now(self) -> None:
        self._force_until_done = False

    def status(self) -> dict:
        with dbmod.session_scope() as db:
            total = db.scalar(select(_count()).select_from(Track).join(Library, Library.id == Track.library_id).where(Library.enabled.is_(True))) or 0
            done = db.scalar(
                select(_count()).select_from(TrackFeature).join(Track, Track.id == TrackFeature.track_id)
                .where(TrackFeature.version == ANALYSIS_VERSION, TrackFeature.error.is_(None))
            ) or 0
            failed = db.scalar(select(_count()).select_from(TrackFeature).where(TrackFeature.error.is_not(None))) or 0
            cfg = _config(db)
        with self._lock:
            st = dict(self.state)
        return {**st, **cfg, "total": total, "analyzed": done, "failed": failed, "forced": self._force_until_done}

    # ---------- внутреннее ----------

    def _loop(self) -> None:
        # Самый низкий приоритет CPU для этого потока (в Linux nice — свойство потока)
        try:
            os.setpriority(os.PRIO_PROCESS, threading.get_native_id(), 19)
        except (OSError, AttributeError):
            pass
        time.sleep(20)
        while True:
            try:
                worked = self._tick()
            except Exception:  # noqa: BLE001
                log.exception("Анализ звука")
                worked = False
            # между треками — короткая пауза, когда делать нечего — ждём минуту (или кнопку)
            self._wake.wait(0.05 if worked else 60)
            self._wake.clear()

    def _set(self, **kw) -> None:  # noqa: ANN003
        with self._lock:
            self.state.update(kw)

    def _tick(self) -> bool:
        if not dbmod.is_configured():
            return False
        from .scanner import scanner  # noqa: PLC0415 — избегаем циклического импорта

        with dbmod.session_scope() as db:
            cfg = _config(db)
        if not cfg["enabled"] and not self._force_until_done:
            self._set(running=False, paused_reason="Анализ выключен")
            return False
        if not self._force_until_done and not in_window(cfg["start"], cfg["end"]):
            self._set(running=False, paused_reason=f"Ждёт разрешённого времени ({cfg['start']}–{cfg['end']})")
            return False
        if scanner.status().get("running"):
            self._set(running=False, paused_reason="Ждёт окончания сканирования")
            return False

        with dbmod.session_scope() as db:
            row = db.execute(
                select(Track.id, Track.path, Track.duration, Track.mtime, Library.path)
                .join(Library, Library.id == Track.library_id)
                .outerjoin(TrackFeature, TrackFeature.track_id == Track.id)
                .where(
                    Library.enabled.is_(True),
                    or_(
                        TrackFeature.track_id.is_(None),
                        TrackFeature.version < ANALYSIS_VERSION,
                        TrackFeature.mtime != Track.mtime,
                    ),
                )
                .order_by(Track.id.desc())  # сначала свежие — они интереснее
                .limit(1)
            ).first()
        if row is None:
            if self._force_until_done:
                log.info("Анализ звука: все треки обработаны")
            self._force_until_done = False
            self._set(running=False, current=None, paused_reason="Все треки проанализированы")
            return False

        track_id, rel, duration, mtime, lib_path = row
        self._set(running=True, current=rel, paused_reason="")
        result: dict = {}
        error = None
        try:
            result = analyze_file(os.path.join(lib_path, rel), duration or 0)
        except Exception as exc:  # noqa: BLE001
            error = str(exc)[:255] or exc.__class__.__name__
        with dbmod.session_scope() as db:
            feat = db.get(TrackFeature, track_id) or TrackFeature(track_id=track_id)
            for k, v in result.items():
                setattr(feat, k, v)
            feat.version = ANALYSIS_VERSION
            feat.mtime = mtime
            feat.error = error
            feat.analyzed_at = utcnow()
            db.merge(feat)
            db.commit()
        with self._lock:
            self.state["done_session"] += 1
            if error:
                self.state["last_error"] = f"{rel}: {error}"
        return True


def _count():  # noqa: ANN202
    from sqlalchemy import func  # noqa: PLC0415

    return func.count()


def _config(db) -> dict:  # noqa: ANN001
    return {
        "enabled": get_setting(db, "analysis_enabled") == "1",
        "start": get_setting(db, "analysis_start"),
        "end": get_setting(db, "analysis_end"),
    }


def save_config(db, enabled: bool | None, start: str | None, end: str | None) -> None:  # noqa: ANN001
    if enabled is not None:
        set_setting(db, "analysis_enabled", "1" if enabled else "0")
    for key, value in (("analysis_start", start), ("analysis_end", end)):
        if value is not None:
            set_setting(db, key, f"{_parse_hm(value, 0) // 60:02d}:{_parse_hm(value, 0) % 60:02d}")


analyzer = Analyzer()
dbmod.on_ready(analyzer.start)
