"""Android-приложение: администратор кладёт APK на сервер (файлом или ссылкой на сборку Expo),
пользователи скачивают его со страницы профиля в браузере.

Файл — data/app/selfmusic.apk, сведения о нём — data/app/meta.json.
"""
from __future__ import annotations

import json
import os
import re
import time
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from ..config import DATA_DIR
from ..models import User
from ..security import get_current_user, get_media_user, require_admin

router = APIRouter(prefix="/api", tags=["android"])

APP_DIR = DATA_DIR / "app"
APK = APP_DIR / "selfmusic.apk"
META = APP_DIR / "meta.json"
MAX_SIZE = 300 * 1024 * 1024
APK_TYPE = "application/vnd.android.package-archive"


def _meta() -> dict | None:
    if not APK.is_file():
        return None
    try:
        data = json.loads(META.read_text())
    except (OSError, ValueError):
        data = {}
    st = APK.stat()
    return {
        "available": True,
        "version": data.get("version") or "",
        "size": st.st_size,
        "uploaded_at": data.get("uploaded_at") or datetime.fromtimestamp(st.st_mtime, timezone.utc).isoformat(),
    }


def _check_apk(path: Path) -> None:
    """APK — это zip с AndroidManifest.xml внутри; всё остальное отбрасываем."""
    try:
        with zipfile.ZipFile(path) as z:
            names = set(z.namelist())
    except zipfile.BadZipFile:
        raise HTTPException(400, "Это не APK-файл")
    if "AndroidManifest.xml" not in names:
        raise HTTPException(400, "Это не APK-файл (нет AndroidManifest.xml)")
    if "classes.dex" not in names:
        raise HTTPException(400, "Похоже на набор для Google Play (.aab), а нужен .apk — профиль сборки preview")


def _install(tmp: Path, version: str) -> dict:
    _check_apk(tmp)
    APP_DIR.mkdir(parents=True, exist_ok=True)
    os.replace(tmp, APK)
    META.write_text(json.dumps({"version": version.strip()[:32], "uploaded_at": datetime.now(timezone.utc).isoformat()}))
    return _meta() or {"available": False}


def _tmp() -> Path:
    APP_DIR.mkdir(parents=True, exist_ok=True)
    return APP_DIR / f".upload-{time.time_ns()}.apk"


@router.get("/app/info")
def app_info(_: User = Depends(get_current_user)) -> dict:
    return _meta() or {"available": False}


@router.get("/app/download")
def app_download(_: User = Depends(get_media_user)) -> FileResponse:
    m = _meta()
    if not m:
        raise HTTPException(404, "Приложение ещё не загружено на сервер")
    version = re.sub(r"[^\w.-]+", "", m["version"])
    name = f"SelfMusic-{version}.apk" if version else "SelfMusic.apk"
    return FileResponse(APK, media_type=APK_TYPE, filename=name)


@router.post("/admin/app")
def upload_app(file: UploadFile = File(...), version: str = Form(""), _: User = Depends(require_admin)) -> dict:
    tmp = _tmp()
    size = 0
    try:
        with tmp.open("wb") as out:
            while chunk := file.file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_SIZE:
                    raise HTTPException(413, "Файл больше 300 МБ")
                out.write(chunk)
        return _install(tmp, version)
    finally:
        tmp.unlink(missing_ok=True)


class AppUrlIn(BaseModel):
    url: str = Field(min_length=8, max_length=2000)
    version: str = Field(default="", max_length=32)


@router.post("/admin/app/url")
def fetch_app(data: AppUrlIn, _: User = Depends(require_admin)) -> dict:
    """Скачать APK по ссылке (например, из сборки Expo: expo.dev/artifacts/eas/….apk)."""
    if not data.url.startswith("https://"):
        raise HTTPException(400, "Нужна ссылка https://")
    tmp = _tmp()
    try:
        req = urllib.request.Request(data.url, headers={"User-Agent": "SelfMusic"})
        try:
            with urllib.request.urlopen(req, timeout=60) as resp, tmp.open("wb") as out:  # noqa: S310 — только https
                if "text/html" in (resp.headers.get("Content-Type") or ""):
                    raise HTTPException(400, "По ссылке страница, а не файл — скопируйте ссылку на сам .apk (кнопка Install / Download в сборке)")
                size = 0
                while chunk := resp.read(1024 * 1024):
                    size += len(chunk)
                    if size > MAX_SIZE:
                        raise HTTPException(413, "Файл больше 300 МБ")
                    out.write(chunk)
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(400, f"Не удалось скачать: {exc}")
        return _install(tmp, data.version)
    finally:
        tmp.unlink(missing_ok=True)


@router.delete("/admin/app")
def delete_app(_: User = Depends(require_admin)) -> dict:
    APK.unlink(missing_ok=True)
    META.unlink(missing_ok=True)
    return {"available": False}

