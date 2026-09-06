#!/usr/bin/env python3
"""
Polls Spotify for the current playback position and merges it into the gist that
ContiListen syncs with. Runs on a schedule in GitHub Actions, so your position is
recorded even when neither the app nor the website is open.

Standard library only, so the Action needs no pip install and finishes in seconds.

Environment:
    SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REFRESH_TOKEN
    GIST_TOKEN   classic PAT with the gist scope
    GIST_ID      optional; discovered automatically if omitted
    PROFILE      optional; whose bookmarks these are. Defaults to "Me".
                 If you and a partner share this Spotify account, run one
                 workflow per person with separate tokens and profiles.
"""

import base64
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

FILE = "contilisten.json"
UA = "ContiListen-Poller"

CLIENT_ID = os.environ["SPOTIFY_CLIENT_ID"]
CLIENT_SECRET = os.environ["SPOTIFY_CLIENT_SECRET"]
REFRESH_TOKEN = os.environ["SPOTIFY_REFRESH_TOKEN"]
GIST_TOKEN = os.environ["GIST_TOKEN"]
GIST_ID = os.environ.get("GIST_ID", "").strip()
PROFILE = os.environ.get("PROFILE", "Me").strip() or "Me"
HISTORY_CAP = 24          # ~2 hours of 5-minute samples
HISTORY_GAP_MS = 4 * 60 * 1000


def now_iso():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def ts(value):
    """ISO-8601 to epoch millis. Unparseable or missing sorts oldest."""
    if not value:
        return 0
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000
    except ValueError:
        return 0


def request(url, method="GET", headers=None, data=None):
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header("User-Agent", UA)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    if body:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw) if raw else None
        except json.JSONDecodeError:
            return e.code, {"raw": raw.decode("utf-8", "replace")}


# ── Spotify ──────────────────────────────────────────────────

def access_token():
    auth = base64.b64encode(f"{CLIENT_ID}:{CLIENT_SECRET}".encode()).decode()
    req = urllib.request.Request(
        "https://accounts.spotify.com/api/token",
        data=urllib.parse.urlencode({
            "grant_type": "refresh_token",
            "refresh_token": REFRESH_TOKEN,
        }).encode(),
        headers={
            "Authorization": "Basic " + auth,
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": UA,
        },
    )
    with urllib.request.urlopen(req, timeout=25) as r:
        return json.load(r)["access_token"]


def now_playing(token):
    status, data = request(
        "https://api.spotify.com/v1/me/player",
        headers={"Authorization": "Bearer " + token},
    )
    if status == 204 or not data or not data.get("item"):
        return None
    if status != 200:
        print(f"Spotify returned {status}: {data}", file=sys.stderr)
        return None

    item = data["item"]
    album = item.get("album") or {}
    images = album.get("images") or []
    artists = item.get("artists") or []

    return {
        "trackURI": item["uri"],
        "trackName": item["name"],
        "trackNumber": item.get("track_number"),
        "durationMs": item.get("duration_ms", 0),
        "positionMs": data.get("progress_ms") or 0,
        "isPlaying": bool(data.get("is_playing")),
        "contextURI": (data.get("context") or {}).get("uri"),
        "albumURI": album.get("uri"),
        "albumName": album.get("name") or item["name"],
        "artistName": artists[0]["name"] if artists else "",
        "artistURI": artists[0].get("uri") if artists else None,
        "art": (images[1] if len(images) > 1 else images[0])["url"] if images else None,
    }


# ── Gist ─────────────────────────────────────────────────────

GH_HEADERS = {
    "Authorization": "Bearer " + GIST_TOKEN,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
}


def find_gist():
    status, gists = request("https://api.github.com/gists?per_page=100", headers=GH_HEADERS)
    if status != 200:
        raise SystemExit(f"Could not list gists ({status}): {gists}")
    for g in gists:
        if FILE in (g.get("files") or {}):
            return g["id"]
    return None


def read_gist(gist_id):
    status, gist = request(f"https://api.github.com/gists/{gist_id}", headers=GH_HEADERS)
    if status != 200:
        raise SystemExit(f"Could not read gist ({status}): {gist}")
    f = (gist.get("files") or {}).get(FILE)
    if not f:
        return {}
    content = f.get("content")
    if f.get("truncated") and f.get("raw_url"):
        with urllib.request.urlopen(f["raw_url"], timeout=25) as r:
            content = r.read().decode()
    return json.loads(content or "{}")


def write_gist(gist_id, payload):
    body = {"files": {FILE: {"content": json.dumps(payload, indent=2, ensure_ascii=False)}}}
    if gist_id:
        status, res = request(f"https://api.github.com/gists/{gist_id}",
                              method="PATCH", headers=GH_HEADERS, data=body)
    else:
        body |= {"description": "ContiListen bookmarks", "public": False}
        status, res = request("https://api.github.com/gists",
                              method="POST", headers=GH_HEADERS, data=body)
    if status not in (200, 201):
        raise SystemExit(f"Could not write gist ({status}): {res}")
    return res["id"]


# ── Bookmark rules — mirrors the browser's logic ─────────────

def watch_matches(playing, watchlist):
    def has(hay, needle):
        return needle.lower() in (hay or "").lower()

    for w in watchlist:
        kind, name, uri = w.get("kind"), w.get("name", ""), w.get("uri")
        if kind == "artist":
            if uri and uri == playing["artistURI"]:
                return True
            if has(playing["artistName"], name):
                return True
        elif kind == "album":
            if uri and uri in (playing["albumURI"], playing["contextURI"]):
                return True
        else:
            if any(has(playing[k], name) for k in ("albumName", "artistName", "trackName")):
                return True
    return False


def trim_history(history, entry):
    """Keeps a rolling trail of positions so you can undo an accidental
    all-night playthrough. One sample per few minutes is plenty."""
    history = list(history or [])
    sample = {
        "t": entry["updatedAt"],
        "p": entry["positionMs"],
        "u": entry["trackURI"],
        "n": entry["trackNumber"],
    }
    last = history[-1] if history else None
    if last and last.get("u") == sample["u"] \
            and ts(sample["t"]) - ts(last.get("t")) < HISTORY_GAP_MS:
        history[-1] = sample          # same chapter, recent: replace
    else:
        history.append(sample)
    return history[-HISTORY_CAP:]


def record(payload, playing):
    if payload.get("mode") == "watchlist" and not watch_matches(playing, payload.get("watchlist", [])):
        print("Playing something outside the watchlist; ignoring.")
        return False

    key = playing["contextURI"] or playing["albumURI"] or playing["trackURI"]
    bookmark_id = f"{PROFILE}::{key}"
    tomb = payload.get("tombstones", {})
    entry = {
        "id": bookmark_id,
        "profile": PROFILE,
        "key": key,
        "albumName": playing["albumName"],
        "artistName": playing["artistName"],
        "art": playing["art"],
        "contextURI": playing["contextURI"],
        "trackURI": playing["trackURI"],
        "trackName": playing["trackName"],
        "trackNumber": playing["trackNumber"],
        "positionMs": playing["positionMs"],
        "durationMs": playing["durationMs"],
        "updatedAt": now_iso(),
    }

    bookmarks = payload.setdefault("bookmarks", [])
    existing = next((b for b in bookmarks if b.get("id") == bookmark_id), None)

    if existing:
        # Don't let a restart at 0:01 clobber a good position.
        if (existing.get("trackURI") == entry["trackURI"]
                and entry["positionMs"] < 3000
                and existing.get("positionMs", 0) > 10000):
            print("Ignoring a restart near 0:00.")
            return False
        # Never move a bookmark backwards past a deletion from another device.
        if bookmark_id in tomb and ts(tomb[bookmark_id]) >= ts(existing.get("updatedAt")):
            print("Bookmark was deleted elsewhere; not resurrecting.")
            return False
        # Playing it again un-archives it.
        entry["archived"] = False
        entry["history"] = trim_history(existing.get("history"), entry)
        bookmarks[bookmarks.index(existing)] = entry
    else:
        if playing["positionMs"] < 3000 and not playing["isPlaying"]:
            return False
        entry["archived"] = False
        entry["history"] = trim_history([], entry)
        bookmarks.append(entry)

    bookmarks.sort(key=lambda b: ts(b.get("updatedAt")), reverse=True)
    payload["updatedAt"] = now_iso()
    payload.setdefault("version", 1)
    return True


def main():
    playing = now_playing(access_token())
    if not playing:
        print("Nothing playing.")
        return

    gist_id = GIST_ID or find_gist()
    payload = read_gist(gist_id) if gist_id else {}

    label = f"{playing['albumName']} - {playing['trackName']}"
    position = playing["positionMs"] // 1000
    print(f"{label} at {position // 60}:{position % 60:02d}")

    if record(payload, playing):
        write_gist(gist_id, payload)
        print("Bookmark saved.")


if __name__ == "__main__":
    main()
