#!/usr/bin/env python3
"""
Run this ONCE on your computer to get a refresh token for the GitHub Action.

The web app uses PKCE, whose refresh tokens rotate on every use — two clients
sharing one would keep invalidating each other. A server-side app can use the
client secret instead, and those refresh tokens are stable, so the Action can
reuse the same one indefinitely.

    export SPOTIFY_CLIENT_ID=xxxx
    export SPOTIFY_CLIENT_SECRET=yyyy
    python3 bootstrap_token.py

First add this redirect URI in the Spotify dashboard:

    http://127.0.0.1:8080/callback
"""

import base64
import http.server
import json
import os
import secrets
import threading
import urllib.parse
import urllib.request
import webbrowser

CLIENT_ID = os.environ.get("SPOTIFY_CLIENT_ID", "").strip()
CLIENT_SECRET = os.environ.get("SPOTIFY_CLIENT_SECRET", "").strip()
REDIRECT = "http://127.0.0.1:8080/callback"
SCOPES = "user-read-playback-state user-read-currently-playing user-read-recently-played"

if not CLIENT_ID or not CLIENT_SECRET:
    raise SystemExit("Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET first.")

state = secrets.token_urlsafe(16)
result = {}
done = threading.Event()


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        query = urllib.parse.urlparse(self.path).query
        params = urllib.parse.parse_qs(query)
        result.update({k: v[0] for k, v in params.items()})
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        ok = "code" in result and result.get("state") == state
        self.wfile.write(
            b"<h2>Done - close this tab and check your terminal.</h2>"
            if ok else b"<h2>Something went wrong. Check the terminal.</h2>"
        )
        done.set()

    def log_message(self, *args):
        pass


def post_token(payload):
    auth = base64.b64encode(f"{CLIENT_ID}:{CLIENT_SECRET}".encode()).decode()
    req = urllib.request.Request(
        "https://accounts.spotify.com/api/token",
        data=urllib.parse.urlencode(payload).encode(),
        headers={
            "Authorization": "Basic " + auth,
            "Content-Type": "application/x-www-form-urlencoded",
        },
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)


server = http.server.HTTPServer(("127.0.0.1", 8080), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()

url = "https://accounts.spotify.com/authorize?" + urllib.parse.urlencode({
    "client_id": CLIENT_ID,
    "response_type": "code",
    "redirect_uri": REDIRECT,
    "scope": SCOPES,
    "state": state,
})

print("Opening Spotify authorisation in your browser...")
print("If it doesn't open, paste this:\n\n" + url + "\n")
webbrowser.open(url)

done.wait(timeout=300)
server.shutdown()

if result.get("state") != state:
    raise SystemExit("State mismatch - start over.")
if "code" not in result:
    raise SystemExit("No code returned: " + result.get("error", "unknown error"))

tokens = post_token({
    "grant_type": "authorization_code",
    "code": result["code"],
    "redirect_uri": REDIRECT,
})

print("\n" + "=" * 62)
print("Add this as the GitHub secret SPOTIFY_REFRESH_TOKEN:\n")
print(tokens["refresh_token"])
print("=" * 62)
