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


def player_at(snapshot, name):
    return next((p for p in snapshot["players"] if p["username"].casefold() == name.casefold()), None)


def measured_at(snapshot, player):
    return player.get("captured_at", snapshot["captured_at"]) if player else snapshot["captured_at"]


def is_late_capture(snapshot):
    """Old daily snapshots have no flag; their actual capture time is authoritative."""
    if not snapshot or snapshot["kind"] != "daily":
        return False
    return snapshot.get("late_capture", stamp(snapshot).astimezone(MSK).hour >= 6)


def normalize_chain(chain):
    """A previously positive missing exercise stays unknown, not an implicit 0."""
    result, previously_seen, identities = deepcopy(chain), {}, {}
    for snapshot in result:
        for player in snapshot["players"]:
            name = player["username"].casefold()
            identity = (player.get("profile") or {}).get("id")
            if identity and identities.get(name) not in (None, identity):
                previously_seen[name] = set()
            if identity:
                identities[name] = identity
            seen = previously_seen.setdefault(name, set())
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
    out = []
    for name in names:
        a, b = player_at(before, name), player_at(after, name)
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
    late = is_late_capture(before) or is_late_capture(after)
    partial = before["kind"] != "daily" or gap != 1 or late
    rows = difference(before, after, names)
    for row in rows:
        row.update({"partial": partial, "late_capture": late})
    return {"date": (end.date() - timedelta(days=1)).isoformat(),
            "from": before["captured_at"], "to": after["captured_at"],
            "partial": partial, "gap_days": gap, "late_capture": late,
            "rows": rows}


def tracked_intervals(chain, names):
    """Enrollment resets one player's reference, never creates an activity day.

    An absent player in a daily snapshot was outside the roster. An explicit
    missing player was being tracked but could not be measured. Only the latter
    makes an otherwise covered aggregate unknown.
    """
    references, intervals, boundary = {}, [], None
    current_ids = {}
    for snapshot in chain:
        for name in names:
            player = player_at(snapshot, name)
            identity = (player.get("profile") or {}).get("id") if player else None
            if identity:
                current_ids[name] = identity

    def same_account(player, name):
        identity = (player.get("profile") or {}).get("id") if player else None
        return not identity or not current_ids.get(name) or identity == current_ids[name]

    for snapshot in chain:
        kind = snapshot["kind"]
        if kind in ("baseline", "enrollment"):
            for name in names:
                player = player_at(snapshot, name)
                if player is not None and same_account(player, name):
                    references[name] = snapshot
            if kind == "baseline":
                boundary = snapshot
            continue
        if kind != "daily":
            raise ValueError("Unknown snapshot kind: " + kind)
        if boundary is None:
            raise ValueError("A daily snapshot has no global baseline")
        item = interval(boundary, snapshot, [])
        for name in names:
            current = player_at(snapshot, name)
            if current is not None and not same_account(current, name):
                current = None
            reference = references.get(name)
            previous = player_at(reference, name) if reference else None
            start = measured_at(reference, previous) if reference else None
            end = measured_at(snapshot, current)
            if current is None:
                row = {"username": name, "status": "no_baseline", "values": {},
                       "anomalies": [], "inactive": True}
                references.pop(name, None)
            elif reference is None:
                row = {"username": name, "status": "no_baseline" if current["status"] == "ok" else "missing",
                       "values": {}, "anomalies": [], "baseline_only": current["status"] == "ok"}
                references[name] = snapshot
            else:
                row = difference(reference, snapshot, [name])[0]
                references[name] = snapshot
            gap = ((datetime.fromisoformat(end).astimezone(MSK).date() -
                    datetime.fromisoformat(start).astimezone(MSK).date()).days if start else None)
            late = is_late_capture(reference) or is_late_capture(snapshot)
            row.update({"from": start, "to": end, "late_capture": late,
                        "partial": reference is None or reference["kind"] != "daily" or gap != 1 or late})
            item["rows"].append(row)
        item["partial"] = item["partial"] or any(r["partial"] for r in item["rows"] if r["status"] == "ok")
        intervals.append(item)
        boundary = snapshot
    return intervals


def sum_interval_rows(segments, names):
    """Sum measured participation intervals, preserving missing data and resets."""
    result = []
    for name in names:
        all_rows = [next(r for r in segment["rows"] if r["username"] == name) for segment in segments]
        rows = [r for r in all_rows if not r.get("inactive") and not r.get("baseline_only")]
        first = rows[0].get("from") if rows else None
        last = rows[-1].get("to") if rows else (all_rows[-1].get("to") if all_rows else None)
        partial = len(rows) != len(all_rows) or any(r.get("partial", False) for r in rows)
        common = {"username": name, "from": first, "to": last, "partial": partial}
        if not rows or any(r["status"] != "ok" for r in rows):
            anomalies = sorted({a for row in rows for a in row["anomalies"]})
            result.append({**common, "status": "no_baseline", "values": {}, "anomalies": anomalies})
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
        result.append({**common, "status": "ok", "values": values, "anomalies": anomalies})
    return result


def window_rows(chain, names):
    """Compatibility helper for standalone daily/enrollment chains."""
    chain = normalize_chain(chain)
    if chain and chain[0]["kind"] == "daily":
        # This API treats the first supplied observation as the window boundary.
        first = deepcopy(chain[0])
        first["kind"] = "baseline"
        chain = [first] + chain[1:]
    return sum_interval_rows(tracked_intervals(chain, names), names)


def individual_totals(chain, names, first=False):
    """First successful measurement or latest attempt, independently per player."""
    rows, records = [], {}
    for name in names:
        observations = [(s, player_at(s, name)) for s in chain if player_at(s, name) is not None]
        if first:
            # A reused name must not inherit a different account's starting total.
            current_id = next(((p.get("profile") or {}).get("id") for _, p in reversed(observations)
                               if (p.get("profile") or {}).get("id")), None)
            observations = [(s, p) for s, p in observations if p["status"] == "ok" and
                            (not current_id or (p.get("profile") or {}).get("id") in (None, current_id))]
        if not observations:
            rows.append({"username": name, "status": "missing", "values": {}, "anomalies": [],
                         "from": None, "to": None, "captured_at": None})
            continue
        snapshot, player = observations[0] if first else observations[-1]
        recorded = measured_at(snapshot, player)
        records[name] = (snapshot, player)
        rows.append({"username": name, "status": player["status"], "values": player["values"],
                     "anomalies": [k for k, v in player["values"].items() if v is None],
                     "from": None, "to": recorded, "captured_at": recorded})
    return rows, records


def build(root=ROOT):
    names = read_json(root / "players.json")
    baseline = read_json(root / "history/baseline.json")
    daily = sorted((read_json(p) for p in (root / "history/daily").glob("*.json")), key=stamp)
    if any(stamp(s) <= stamp(baseline) for s in daily):
        raise ValueError("A daily snapshot predates baseline")
    if len({s["boundary_date"] for s in daily}) != len(daily):
        raise ValueError("Duplicate daily boundary")
    enrollments = [read_json(p) for p in (root / "history/enrollments").glob("*.json")]
    if any(s["kind"] != "enrollment" or stamp(s) < stamp(baseline) for s in enrollments):
        raise ValueError("Invalid enrollment snapshot")
    order = {"baseline": 0, "enrollment": 1, "daily": 2}
    chain = normalize_chain(sorted([baseline] + daily + enrollments, key=lambda s: (stamp(s), order[s["kind"]])))
    boundaries = [s for s in chain if s["kind"] in ("baseline", "daily")]
    baseline = boundaries[0]
    latest_boundary = boundaries[-1]
    starting_rows, _ = individual_totals(chain, names, first=True)
    latest_rows, latest_records = individual_totals(chain, names)
    latest_at = max((r["captured_at"] for r in latest_rows if r["captured_at"]),
                    key=datetime.fromisoformat, default=chain[-1]["captured_at"])
    starting_at = max((r["captured_at"] for r in starting_rows if r["captured_at"]),
                      key=datetime.fromisoformat, default=baseline["captured_at"])
    periods = [
        {"id": "baseline", "label": "Стартовый тотал", "available": True,
         "from": None, "to": starting_at, "partial": False,
         "description": "Первый доступный снимок каждого участника. Дата старта может различаться; тотал не входит в дневной прогресс.",
         "rows": starting_rows},
        {"id": "total", "label": "Текущий тотал", "available": True,
         "from": None, "to": latest_at, "partial": False,
         "description": "Последний доступный снимок каждого участника, включая снимки при добавлении.", "rows": latest_rows},
    ]
    history = tracked_intervals(chain, names)
    for ident, days, label in [("day", 1, "Последний интервал"), ("week", 7, "7 дней"), ("month", 30, "30 дней")]:
        if not daily:
            periods.append({"id": ident, "label": label, "available": False, "from": None,
                            "to": latest_at, "partial": True,
                            "description": "Разница появится после следующего снимка в 00:00 МСК.", "rows": []})
            continue
        if days == 1:
            reference_index = len(boundaries) - 2
        else:
            # Calendar boundaries in Moscow; never invent split daily values.
            cutoff = stamp(latest_boundary).astimezone(MSK).date() - timedelta(days=days)
            candidates = [i for i, s in enumerate(boundaries[:-1]) if stamp(s).astimezone(MSK).date() <= cutoff]
            reference_index = candidates[-1] if candidates else 0
        reference = boundaries[reference_index]
        segments = history[reference_index:]
        rows = sum_interval_rows(segments, names)
        covered = (stamp(latest_boundary).astimezone(MSK).date() - stamp(reference).astimezone(MSK).date()).days
        partial = reference["kind"] == "baseline" or covered != days or any(s["partial"] for s in segments)
        partial = partial or any(r["partial"] for r in rows if r["status"] == "ok")
        periods.append({"id": ident, "label": label, "available": True,
                        "from": reference["captured_at"], "to": latest_boundary["captured_at"], "partial": partial,
                        "description": ("Неполный период: показана разница за фактический интервал." if partial else
                                        "Разница между ежедневными снимками. Время границ может немного сдвигаться."),
                        "rows": rows})
    catalog = read_json(root / "exercises.json")
    known = {e["id"] for e in catalog}
    discovered = set().union(*(p["values"].keys() for s in chain for p in s["players"]))
    for exercise in sorted(discovered - known - {"tutorial", "wilderness"}):
        catalog.append({"id": exercise, "label": exercise, "unit": "unknown", "include_in_rep_total": False})
    players, day_references = [], []
    for name in names:
        snapshot, p = latest_records.get(name, (None, {"username": name, "status": "missing"}))
        profile = p.get("profile")
        known_id = next(((player_at(s, name).get("profile") or {}).get("id")
                         for s in reversed(chain) if player_at(s, name) is not None and
                         (player_at(s, name).get("profile") or {}).get("id")), None)
        players.append({"username": name, "canonical_username": p.get("canonical_username", name),
                        "id": known_id,
                        "status": p["status"], "profile": {k: v for k, v in profile.items() if k != "id"} if profile else None,
                        "captured_at": measured_at(snapshot, p) if snapshot else None})
        day_references.append({"username": name, "status": p["status"], "values": p.get("values", {}),
                               "captured_at": measured_at(snapshot, p) if snapshot else None,
                               "kind": snapshot["kind"] if snapshot else None,
                               "boundary_date": snapshot.get("boundary_date") if snapshot else None,
                               "late_capture": is_late_capture(snapshot),
                               "profile_id": (profile or {}).get("id") or known_id})
    config_path = root / "public_client.json"
    config = read_json(config_path) if config_path.exists() else None
    source = {key: config[key] for key in ("base_url", "publishable_key")} if config else None
    dashboard = {"schema_version": 1, "timezone": "Europe/Moscow", "schedule": "00:00 МСК",
                 "generated_at": latest_at, "baseline_at": baseline["captured_at"],
                 "latest_at": latest_at, "exercises": catalog, "players": players,
                 "periods": periods, "history": history,
                 "source": source, "day_references": day_references}
    write_json(root / "site/data/dashboard.json", dashboard)
    print("Built dashboard:", len(players), "players,", len(history), "daily intervals")
    return dashboard


if __name__ == "__main__":
    build()
