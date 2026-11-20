#!/usr/bin/env python3
"""Build the static dashboard; baseline is never counted as daily exercise."""
import json
from copy import deepcopy
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo
from collect import ROOT, read_json, write_json

MSK = ZoneInfo("Europe/Moscow")


def stamp(snapshot):
    return datetime.fromisoformat(snapshot["captured_at"])


def player_map(snapshot):
    return {p["username"]: p for p in snapshot["players"]}


def normalize_chain(chain):
    """A previously positive missing exercise stays unknown, not an implicit 0."""
    result, previously_seen = deepcopy(chain), {}
    for snapshot in result:
        for player in snapshot["players"]:
            seen = previously_seen.setdefault(player["username"], set())
            if player["status"] != "ok":
                continue
            for exercise in seen - player["values"].keys():
                player["values"][exercise] = None
            seen.update(k for k, v in player["values"].items() if v is None or v > 0)
    return result


def totals(snapshot, names):
    players = player_map(snapshot)
    return [{"username": n, "status": players.get(n, {}).get("status", "missing"),
             "values": players.get(n, {}).get("values", {}),
             "anomalies": [k for k, v in players.get(n, {}).get("values", {}).items() if v is None]} for n in names]


def difference(before, after, names):
    old, new = player_map(before), player_map(after)
    out = []
    for name in names:
        a, b = old.get(name), new.get(name)
        if not b or b["status"] != "ok":
            out.append({"username": name, "status": "missing", "values": {}, "anomalies": []})
            continue
        if not a or a["status"] != "ok":
            out.append({"username": name, "status": "no_baseline", "values": {}, "anomalies": []})
            continue
        old_id, new_id = (a.get("profile") or {}).get("id"), (b.get("profile") or {}).get("id")
        if old_id and new_id and old_id != new_id:
            out.append({"username": name, "status": "no_baseline", "values": {}, "anomalies": ["identity_changed"]})
            continue
        values, anomalies = {}, []
        for exercise in sorted(a["values"].keys() | b["values"].keys()):
            first, last = a["values"].get(exercise, 0), b["values"].get(exercise, 0)
            if first is None or last is None:
                values[exercise] = None
                anomalies.append(exercise)
                continue
            delta = last - first
            values[exercise] = delta if delta >= 0 else None
            if delta < 0:
                anomalies.append(exercise)
        out.append({"username": name, "status": "ok", "values": values, "anomalies": anomalies})
    return out


def interval(before, after, names):
    start, end = stamp(before).astimezone(MSK), stamp(after).astimezone(MSK)
    gap = (end.date() - start.date()).days
    partial = before["kind"] == "baseline" or gap != 1
    return {"date": (end.date() - timedelta(days=1)).isoformat(),
            "from": before["captured_at"], "to": after["captured_at"],
            "partial": partial, "gap_days": gap,
            "rows": difference(before, after, names)}


def window_rows(chain, names):
    """Sum intervals, preserving counter resets and missing data within window."""
    chain = normalize_chain(chain)
    all_rows = [difference(a, b, names) for a, b in zip(chain, chain[1:])]
    result = []
    for name in names:
        rows = [next(r for r in group if r["username"] == name) for group in all_rows]
        if any(r["status"] != "ok" for r in rows):
            result.append({"username": name, "status": "no_baseline", "values": {}, "anomalies": []})
            continue
        keys = set().union(*(r["values"] for r in rows))
        values, anomalies = {}, []
        for key in sorted(keys):
            amounts = [r["values"].get(key, 0) for r in rows]
            if any(v is None for v in amounts):
                values[key] = None
                anomalies.append(key)
            else:
                values[key] = sum(amounts)
        result.append({"username": name, "status": "ok", "values": values, "anomalies": anomalies})
    return result


def build(root=ROOT):
    names = read_json(root / "players.json")
    baseline = read_json(root / "history/baseline.json")
    daily = sorted((read_json(p) for p in (root / "history/daily").glob("*.json")), key=stamp)
    if any(stamp(s) <= stamp(baseline) for s in daily):
        raise ValueError("A daily snapshot predates baseline")
    if len({s["boundary_date"] for s in daily}) != len(daily):
        raise ValueError("Duplicate daily boundary")
    chain = normalize_chain([baseline] + daily)
    baseline = chain[0]
    latest = chain[-1]
    periods = [
        {"id": "baseline", "label": "Стартовый тотал", "available": True,
         "from": None, "to": baseline["captured_at"], "partial": False,
         "description": "Первый снимок рейтинга. Не входит в дневной прогресс.", "rows": totals(baseline, names)},
        {"id": "total", "label": "Текущий тотал", "available": True,
         "from": None, "to": latest["captured_at"], "partial": False,
         "description": "Счётчики публичного рейтинга на момент последнего снимка.", "rows": totals(latest, names)},
    ]
    history = [interval(a, b, names) for a, b in zip(chain, chain[1:])]
    for ident, days, label in [("day", 1, "Последний интервал"), ("week", 7, "7 дней"), ("month", 30, "30 дней")]:
        if not daily:
            periods.append({"id": ident, "label": label, "available": False, "from": None,
                            "to": latest["captured_at"], "partial": True,
                            "description": "Разница появится после следующего снимка в 00:00 МСК.", "rows": []})
            continue
        if days == 1:
            reference_index = len(chain) - 2
        else:
            # Calendar boundaries in Moscow; never invent split daily values.
            cutoff = stamp(latest).astimezone(MSK).date() - timedelta(days=days)
            candidates = [i for i, s in enumerate(chain[:-1]) if stamp(s).astimezone(MSK).date() <= cutoff]
            reference_index = candidates[-1] if candidates else 0
        reference = chain[reference_index]
        window = chain[reference_index:]
        segments = [interval(a, b, names) for a, b in zip(window, window[1:])]
        covered = (stamp(latest).astimezone(MSK).date() - stamp(reference).astimezone(MSK).date()).days
        partial = reference["kind"] == "baseline" or covered != days or any(s["partial"] for s in segments)
        periods.append({"id": ident, "label": label, "available": True,
                        "from": reference["captured_at"], "to": latest["captured_at"], "partial": partial,
                        "description": ("Неполный период: показана разница за фактический интервал." if partial else
                                        "Разница между ежедневными снимками. Время границ может немного сдвигаться."),
                        "rows": window_rows(window, names)})
    catalog = read_json(root / "exercises.json")
    known = {e["id"] for e in catalog}
    discovered = set().union(*(p["values"].keys() for s in chain for p in s["players"]))
    for exercise in sorted(discovered - known - {"tutorial", "wilderness"}):
        catalog.append({"id": exercise, "label": exercise, "unit": "unknown", "include_in_rep_total": False})
    players = []
    for name in names:
        p = player_map(latest).get(name, {"username": name, "status": "missing"})
        profile = p.get("profile")
        players.append({"username": name, "canonical_username": p.get("canonical_username", name),
                        "status": p["status"], "profile": {k: v for k, v in profile.items() if k != "id"} if profile else None})
    dashboard = {"schema_version": 1, "timezone": "Europe/Moscow", "schedule": "00:00 МСК",
                 "generated_at": latest["captured_at"], "baseline_at": baseline["captured_at"],
                 "latest_at": latest["captured_at"], "exercises": catalog, "players": players,
                 "periods": periods, "history": history}
    write_json(root / "site/data/dashboard.json", dashboard)
    print("Built dashboard:", len(players), "players,", len(history), "daily intervals")
    return dashboard


if __name__ == "__main__":
    build()
