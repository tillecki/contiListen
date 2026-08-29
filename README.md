# ContiListen — web version

One HTML file. No build step, no backend, no home server. Everything runs in the
browser: OAuth via PKCE (which is why no client secret is needed), and the Spotify
Web API for reading and setting playback position.

Works on a locked-down work iPhone, because nothing gets installed — it's a web page
you add to the Home Screen.

## What carries over, what doesn't

**Kept:** bookmark-per-Hörspiel, resume in album context so playback rolls on into the
next chapter, watchlist with artist/album/keyword, browsable episode list per followed
artist, "remember everything" vs "watchlist only".

**Lost, unavoidably:**

| | |
|---|---|
| Home Screen widget | Web pages can't provide widgets. |
| Siri / Shortcuts | Needs a native App Intent. |
| Background position capture | A web page only runs while open. Position is read every 5s while the tab is visible, and once whenever you reopen it. |

That last one matters less than it sounds. Spotify keeps reporting the last player
state for a while after you stop, so opening the page after a listening session
usually catches the right position anyway — same as the native app in practice.

## Requirements

- **Spotify Premium.** The Web API refuses playback control on Free accounts.
- **A Spotify app registration** (free) for the Client ID.
- **The Spotify app running somewhere** — phone, desktop, or web player. The page
  sends commands to a device; it isn't a player itself.

---

## Route A — GitHub Pages (needed for the iPhone)

Spotify requires an HTTPS redirect URI, so the page has to be hosted. GitHub Pages
is free and takes about five minutes.

### 1. Put the file on GitHub

1. Create a GitHub account if you don't have one.
2. **New repository** → name it `contilisten` → **Public** → Create.
3. On the repo page: **Add file** → **Upload files** → drag in `index.html` →
   **Commit changes**.

Public only affects the source, which contains no secrets — PKCE has none, and your
tokens live in your own browser. Private repos need a paid plan for Pages.

### 2. Turn on Pages

**Settings** → **Pages** (left sidebar) → Source: **Deploy from a branch** →
Branch: `main`, folder `/ (root)` → **Save**.

Wait a minute, reload, and the URL appears at the top:

```
https://YOURNAME.github.io/contilisten/
```

Copy it exactly, including the trailing slash.

### 3. Register that URL with Spotify

<https://developer.spotify.com/dashboard> → your app → **Settings** → **Edit** →
under Redirect URIs add your Pages URL verbatim. Save.

Spotify matches protocol, host, port and path exactly. A missing trailing slash is a
different URI as far as it's concerned.

### 4. Add your Client ID

Edit `index.html` on GitHub (open the file → pencil icon), find line ~120:

```js
const CLIENT_ID = 'PASTE_YOUR_SPOTIFY_CLIENT_ID';
```

Paste the Client ID from the dashboard between the quotes. Commit. Pages redeploys in
under a minute.

You don't set the redirect URI in the file — it uses the page's own address, so it
stays correct wherever you host it.

### 5. Use it on the iPhone

1. Open the Pages URL in **Safari** (not Chrome — Home Screen apps only work from Safari).
2. Tap **Connect Spotify**, approve the three scopes.
3. Share button → **Add to Home Screen**. It gets an icon and opens without browser chrome.

If sign-in bounces you into Safari and back oddly from the Home Screen version, sign
in from a normal Safari tab first, then add to Home Screen.

---

## Route B — straight off your computer, no hosting

For desktop-only use you can skip GitHub. Loopback addresses are the one case where
Spotify permits HTTP.

Put `index.html` in a folder and run:

```bash
cd /path/to/folder
python3 -m http.server 8080 --bind 127.0.0.1
```

Register this redirect URI in the Spotify dashboard — the numeric form, not `localhost`,
which Spotify stopped accepting in February 2025:

```
http://127.0.0.1:8080/
```

Then open <http://127.0.0.1:8080/> in your browser.

This only works on the machine running the command. Your phone can't reach it, which
is why the iPhone needs Route A.

---

## Using it from a computer

Worth knowing: **the web version controls any of your Spotify devices**, not just the
one it's running on. Open the page on your laptop and tap an episode, and it resumes
on whichever device is active — including your phone, if Spotify is open there.

The app picks a device in this order: whatever's currently active → the last device it
used → any phone → anything else. If nothing is awake it opens Spotify and asks you to
tap again.

So a realistic pattern: bookmark gets written while you listen on the phone, and next
morning you continue from the laptop, or vice versa. The bookmarks aren't synced
between browsers though — see below.

## Things to know

- **Bookmarks live in one browser.** They're in `localStorage`, per-browser and
  per-device. Your phone and laptop keep separate lists. Syncing would need a server.
- **iOS clears unused site data after about 7 days.** Open the page at least weekly, or
  keep it on the Home Screen and use it — normal use resets the clock. This is Safari's
  storage policy, not a bug.
- **Private browsing loses everything** on tab close. The app detects this and says so
  in Settings.
- **Development Mode allows five users**, each added manually under Dashboard → your
  app → Settings → User Management, and the app owner needs Premium. Add your
  partner's Spotify email there or their calls will return 403.
- **Rate limits** are computed over a rolling 30-second window. The page polls every 5s
  only while visible, which is well inside them, but don't leave it open all day.

## If something misbehaves

| Symptom | Cause |
|---|---|
| `INVALID_CLIENT: Invalid redirect URI` | Pages URL and dashboard entry don't match exactly. Check the trailing slash. |
| Sign-in loops back to the start | Client ID still says `PASTE_...`, or the wrong one was pasted. |
| "Spotify Premium is required" | Free account, or the wrong Spotify account was authorised. |
| Everything 403s | Your Spotify account isn't on the app's User Management allowlist. |
| Bookmarks vanished | Safari cleared site data after a week of not opening it. |
