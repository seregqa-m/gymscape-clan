#!/usr/bin/env python3
"""Read public counters. Baseline is immutable; daily runs are idempotent."""
import argparse
import json
import os
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
MSK = ZoneInfo("Europe/Moscow")


def read_json(path):
    return json.loads(path.read_text())


def write_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n")
    os.replace(tmp, path)


def request_rows(config, table, query):
    req = Request(config["base_url"] + "/rest/v1/" + table + "?" + urlencode(query),
                  headers={"apikey": config["publishable_key"], "Accept": "application/json"})
    for attempt in range(3):
        try:
            with urlopen(req, timeout=25) as response:
                rows = json.load(response)
            if not isinstance(rows, list):
                raise ValueError("API returned an unexpected response for " + table)
            return rows
        except HTTPError as exc:
            if exc.code not in (429, 500, 502, 503, 504) or attempt == 2:
                raise
        except (URLError, TimeoutError):
            if attempt == 2:
                raise
        time.sleep(2 ** (attempt + 1))


def fetch_player(name, config, known_id=None):
    # IDs from the player's public leaderboard retain identity across renames.
    profile_query = {"select": "id,username,total_level,combat_level,coins,skills_xp", "limit": "2"}
    if known_id:
        profile_query["id"] = "eq." + known_id
    else:
        # Roster names are literal; escape LIKE metacharacters.
        literal = name.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_").replace("*", "\\*")
        profile_query["username"] = "ilike." + literal
    profiles = request_rows(config, "hiscores_full_v2", profile_query)
    if len(profiles) > 1:
        raise ValueError("Ambiguous profile for " + name)
    profile = profiles[0] if profiles else None
    if known_id and not profile:
        # Never attribute a reused nickname to a previously identified player.
        return {"username": name, "canonical_username": name, "status": "missing",
                "values": {}, "profile": None, "captured_at": datetime.now(timezone.utc).isoformat()}
    canonical = profile["username"] if profile else name
    rows = request_rows(config, "exercise_hiscores", {
        "select": "username,exercise_id,reps", "username": "eq." + canonical,
        "order": "exercise_id.asc", "limit": "500",
    })
    if len(rows) >= 500:
        raise ValueError("Possibly truncated response for " + name)
    values = {}
    for row in rows:
        exercise, count = row.get("exercise_id"), row.get("reps")
        if row.get("username") != canonical or not isinstance(exercise, str) or not exercise:
            raise ValueError("Unexpected identity or exercise for " + name)
        if exercise in values or type(count) is not int or count < 0:
            raise ValueError("Invalid or duplicate counter for " + name)
        values[exercise] = count
    return {"username": name, "canonical_username": canonical,
            "status": "ok" if rows else "missing", "values": values,
            "profile": profile, "captured_at": datetime.now(timezone.utc).isoformat()}


def collect(mode, root=ROOT):
    now = datetime.now(timezone.utc)
    local = now.astimezone(MSK)
    if mode == "auto":
        if local.hour >= 6:
            print("Outside midnight capture window; no daily snapshot needed")
            return
        mode = "daily"
    baseline_path = root / "history/baseline.json"
    if mode == "baseline":
        path = baseline_path
    else:
        if not baseline_path.exists():
            raise ValueError("Create the baseline before collecting daily snapshots")
        # Scheduled 00:00 Moscow, allowing realistic queue delays but not noon
        # manual runs misrepresented as midnight boundaries.
        if local.hour >= 6:
            raise ValueError("Daily capture is allowed only 00:00–05:59 Moscow")
        path = root / "history/daily" / (local.date().isoformat() + ".json")
    if path.exists():
        print("Snapshot already exists; left unchanged:", path.name)
        return
    names = read_json(root / "players.json")
    if len({n.casefold() for n in names}) != len(names):
        raise ValueError("Roster must contain unique player names")
    previous = [read_json(baseline_path)] if baseline_path.exists() else []
    previous += sorted((read_json(p) for p in (root / "history/daily").glob("*.json")),
                       key=lambda s: s["captured_at"])
    previous += [read_json(p) for p in (root / "history/enrollments").glob("*.json")]
    previous.sort(key=lambda s: s["captured_at"])
    known_ids = {}
    for snapshot in previous:
        for player in snapshot["players"]:
            player_id = (player.get("profile") or {}).get("id")
            if player_id:
                known_ids[player["username"]] = player_id
    config = read_json(root / "public_client.json")
    with ThreadPoolExecutor(max_workers=3) as pool:
        players = list(pool.map(lambda n: fetch_player(n, config, known_ids.get(n)), names))
    # Network/auth failures abort the entire capture; no false zero deltas.
    if names and not any(p["status"] == "ok" for p in players):
        raise ValueError("No player counters returned; refusing an empty snapshot")
    snapshot = {"schema_version": 1, "kind": mode, "timezone": "Europe/Moscow",
                "captured_at": datetime.now(timezone.utc).isoformat(),
                "started_at": now.isoformat(), "boundary_date": local.date().isoformat() if mode == "daily" else None,
                "source": "exercise_hiscores", "players": players}
    write_json(path, snapshot)
    for p in players:
        print(p["username"], p["status"], len(p["values"]), "exercises")
    print("Saved", path)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("baseline", "daily", "auto"), required=True)
    args = parser.parse_args()
    collect(args.mode)
