#!/usr/bin/env python3
"""Process public GitHub roster requests as data, never executable input.

Open issues with the [roster] prefix form a queue. Every run drains it, so a
superseded pending Actions run cannot lose a request. Results are committed
before issues close; an interrupted run is safe to repeat.
"""
import argparse
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from collect import ROOT, fetch_player, read_json, write_json

NICK = re.compile(r"[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}\Z")
PREFIX = "[roster] "


def parse_request(body):
    if not isinstance(body, str) or len(body) > 2048:
        raise ValueError("Неверный формат заявки")
    try:
        data = json.loads(body)
    except (ValueError, TypeError):
        raise ValueError("Заявка должна содержать JSON, созданный формой сайта")
    if not isinstance(data, dict) or set(data) != {"gymscape_roster", "action", "username"}:
        raise ValueError("Неверные поля заявки")
    if type(data["gymscape_roster"]) is not int or data["gymscape_roster"] != 1:
        raise ValueError("Неизвестная версия заявки")
    if data["action"] not in ("add", "remove"):
        raise ValueError("Неизвестное действие")
    if not isinstance(data["username"], str):
        raise ValueError("Ник должен быть строкой")
    name = data["username"].strip()
    if not NICK.fullmatch(name):
        raise ValueError("Ник: 1–64 символа, латинские буквы, цифры, пробел, точка, дефис и подчёркивание")
    return data["action"], name


def known_id(root, name):
    snapshots = [read_json(root / "history/baseline.json")]
    for folder in ("daily", "enrollments"):
        snapshots.extend(read_json(p) for p in (root / "history" / folder).glob("*.json"))
    for snapshot in sorted(snapshots, key=lambda s: s["captured_at"], reverse=True):
        for player in snapshot["players"]:
            if player["username"].casefold() == name.casefold():
                identity = (player.get("profile") or {}).get("id")
                if identity:
                    return identity
    return None


def apply_request(issue_number, body, root=ROOT, fetcher=fetch_player):
    if type(issue_number) is not int or issue_number < 1:
        raise ValueError("Invalid issue number")
    result_path = root / "history/roster-events" / (str(issue_number) + ".json")
    if result_path.exists():
        return read_json(result_path)
    now = datetime.now(timezone.utc).isoformat()
    try:
        action, name = parse_request(body)
    except ValueError as error:
        result = {"issue_number": issue_number, "status": "rejected", "at": now, "message": str(error)}
        write_json(result_path, result)
        return result
    names = read_json(root / "players.json")
    match = next((n for n in names if n.casefold() == name.casefold()), None)
    changed = False
    if action == "remove":
        if match:
            names.remove(match)
            name, changed = match, True
        message = "Игрок убран из отслеживания; история сохранена" if changed else "Игрока уже нет в списке"
    elif match:
        name = match
        message = "Игрок уже есть в списке"
    else:
        if len(names) >= 200:
            result = {"issue_number": issue_number, "status": "rejected", "at": now,
                      "message": "Достигнут лимит 200 участников"}
            write_json(result_path, result)
            return result
        # Only the public stats client is called; no supplied code/URLs are used.
        # An explicit new add means the current holder of the typed nickname.
        # Historical IDs are used only while continuously tracking a player.
        player = fetcher(name, read_json(root / "public_client.json"), None)
        if not player.get("profile") and player["status"] != "ok":
            result = {"issue_number": issue_number, "status": "rejected", "at": now,
                      "message": "Публичный профиль не найден; проверьте точное написание ника"}
            write_json(result_path, result)
            return result
        # A different spelling of an already tracked account is not a new player.
        identity = (player.get("profile") or {}).get("id")
        if identity and any(known_id(root, existing) == identity for existing in names):
            result = {"issue_number": issue_number, "status": "rejected", "at": now,
                      "message": "Этот игровой профиль уже отслеживается под другим ником"}
            write_json(result_path, result)
            return result
        enrollment = {"schema_version": 1, "kind": "enrollment", "captured_at": player.get("captured_at", now),
                      "source": "exercise_hiscores", "players": [player], "issue_number": issue_number}
        write_json(root / "history/enrollments" / (str(issue_number) + ".json"), enrollment)
        names.append(name)
        changed = True
        message = "Игрок добавлен; его первый снимок сохранён как отдельный тотал"
    write_json(root / "players.json", names)
    result = {"issue_number": issue_number, "status": "applied", "action": action,
              "username": name, "changed": changed, "at": now, "message": message}
    write_json(result_path, result)
    return result


def github_request(path, payload=None):
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if not token:
        raise ValueError("GitHub Actions token is required")
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    if repo != "seregqa-m/gymscape-clan":
        raise ValueError("Unexpected repository")
    req = Request("https://api.github.com/repos/" + repo + path,
                  data=json.dumps(payload).encode() if payload is not None else None,
                  method="PATCH" if payload is not None else "GET",
                  headers={"Authorization": "Bearer " + token, "Accept": "application/vnd.github+json",
                           "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28"})
    with urlopen(req, timeout=30) as response:
        return json.load(response)


def open_requests():
    issues = []
    for page in range(1, 11):
        batch = github_request("/issues?" + urlencode({"state": "open", "sort": "created", "direction": "asc",
                                                        "per_page": 100, "page": page}))
        issues.extend(i for i in batch if "pull_request" not in i and i.get("title", "").startswith(PREFIX))
        if len(batch) < 100:
            return issues
    raise ValueError("Too many open issues; refusing an incomplete queue")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--close-processed", action="store_true")
    args = parser.parse_args()
    for issue in open_requests():
        number = issue["number"]
        if args.close_processed:
            path = ROOT / "history/roster-events" / (str(number) + ".json")
            if not path.exists():
                continue
            result = read_json(path)
            ok = result["status"] == "applied"
            github_request("/issues/" + str(number), {
                "state": "closed", "state_reason": "completed" if ok else "not_planned",
                "title": ("[roster:done] " if ok else "[roster:error] ") + result["message"],
            })
        else:
            result = apply_request(number, issue.get("body"))
            print("Issue", number, result["status"], result["message"])


if __name__ == "__main__":
    main()
