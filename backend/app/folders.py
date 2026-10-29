"""Исключение подпапок из медиатеки.

Library.folder_rules — JSON {"путь/от/корня": false|true}: false — папка и всё внутри
не попадает в медиатеку, true — вернуть подпапку внутри исключённой.
Действует ближайшее правило вверх по дереву; без правил всё включено.
Файлы на диске не трогаются.
"""
from __future__ import annotations

import json
import posixpath


def norm(rel: str) -> str:
    rel = (rel or "").replace("\\", "/").strip("/")
    rel = posixpath.normpath(rel) if rel else ""
    if rel in (".", "") or rel.startswith("../") or rel == "..":
        return ""
    return rel


def parse(raw: str | None) -> dict[str, bool]:
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except ValueError:
        return {}
    return {norm(k): bool(v) for k, v in data.items() if norm(k)} if isinstance(data, dict) else {}


def dump(rules: dict[str, bool]) -> str | None:
    return json.dumps(dict(sorted(rules.items())), ensure_ascii=False) if rules else None


def included(rules: dict[str, bool], rel_dir: str) -> bool:
    """Входит ли папка (путь от корня библиотеки) в медиатеку."""
    if not rules:
        return True
    p = norm(rel_dir)
    while p:
        if p in rules:
            return rules[p]
        p = posixpath.dirname(p)
    return True


def own_rule(rules: dict[str, bool], rel_dir: str) -> bool | None:
    return rules.get(norm(rel_dir))


def included_below(rules: dict[str, bool], rel_dir: str) -> bool:
    """Есть ли внутри папки включённые обратно подпапки (тогда исключённую папку всё равно обходим)."""
    prefix = norm(rel_dir) + "/"
    return any(v and k.startswith(prefix) for k, v in rules.items())


def file_included(rules: dict[str, bool], rel_file: str) -> bool:
    return included(rules, posixpath.dirname(norm(rel_file)))


def set_rule(rules: dict[str, bool], rel_dir: str, include: bool | None) -> dict[str, bool]:
    """Поставить/снять правило и убрать лишние (совпадающие с унаследованным состоянием)."""
    rules = dict(rules)
    p = norm(rel_dir)
    if not p:
        return rules
    rules.pop(p, None)
    if include is not None and included(rules, p) != include:
        rules[p] = include
    # правила ниже, ставшие лишними после изменения
    for k in sorted([k for k in rules if k.startswith(p + "/")], key=len):
        v = rules.pop(k)
        if included(rules, k) != v:
            rules[k] = v
    return rules
