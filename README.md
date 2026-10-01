# ContiListen

Bookmarks your position in Spotify Hörspiele, audiobooks and podcasts, and resumes
exactly where you stopped. Spotify only does this for podcasts, not for albums.

The app is a web page you add to your Home Screen — nothing gets installed, so it
works on a locked-down work phone. A small Cloudflare Worker holds your Spotify login,
merges bookmarks across devices, polls playback every minute, and does the one thing a
web page can't: **wait for Spotify to finish launching before resuming.**

Multiple people can sign in. Each gets their own bookmarks; nobody sees anyone else's.

**You need:** Spotify Premium, a GitHub account (free hosting), and a Cloudflare
account (free).

---

# Part 1 — The Worker

This is the backend. Do it first; the app needs its address.

## 1. Create the Spotify app

<https://developer.spotify.com/dashboard> → **Create app**. Tick **Web API**.
From **Settings**, copy both the **Client ID** and the **Client secret**.

Leave the Redirect URI blank for now — you'll add it in step 4.

## 2. Set up the project

```bash
cd worker
npm init -y
npm install --save-dev wrangler
npx wrangler login
npx wrangler d1 create contilisten
```

> Installed into the project rather than globally. `npm install -g` fails on macOS
> with `EACCES: permission denied, mkdir '/usr/local/lib/node_modules/...'` because
> your user doesn't own `/usr/local`. Don't `sudo` it — that leaves root-owned files
> that break later installs. A local install also pins the version to the project,
> which you want anyway.

That prints a `database_id`. Open `wrangler.toml` and fill in three things:

- `database_id` — from the command above
- `SPOTIFY_CLIENT_ID` — from the dashboard
- `APP_ORIGIN` — your GitHub Pages address from Part 2, e.g.
  `https://yourname.github.io/contilisten/`

If you haven't done Part 2 yet, come back and fix `APP_ORIGIN` afterwards.

## 3. Create the tables and deploy

```bash
npx wrangler d1 execute contilisten --remote --file=./schema.sql
npx wrangler secret put SPOTIFY_CLIENT_SECRET     # paste when prompted
npx wrangler deploy
```

Deploy prints your Worker address, something like
`https://contilisten.yourname.workers.dev`. Copy it.

Check it: opening `https://your-worker.workers.dev/health` should return
`{"ok":true,...}`.

## 4. Tell Spotify about the Worker

Dashboard → your app → **Settings** → **Edit** → **Redirect URIs**, add exactly:

```
https://your-worker.workers.dev/auth/callback
```

The client secret lives only in the Worker, so your phone never holds Spotify
credentials — just a session token you can revoke.

---

# Part 2 — The app

## 1. Put it on GitHub

1. New repository called `contilisten`, **Public**.
2. **Add file → Upload files** → drag in `index.html` and `sw.js` → **Commit**.
3. **Settings → Pages** → Source *Deploy from a branch* → `main`, folder `/ (root)`.

Your address appears after a minute: `https://yourname.github.io/contilisten/`

## 2. Point it at the Worker

Edit `index.html` on GitHub, near the top:

```js
const WORKER = 'https://contilisten.yourname.workers.dev';   // no trailing slash
```

Commit. Make sure `APP_ORIGIN` in `wrangler.toml` matches your Pages address, and
`npx wrangler deploy` again if you changed it.

## 3. Install it

Open the Pages address in **Safari** (must be Safari), tap **Sign in with Spotify**,
approve. Then Share → **Add to Home Screen**.

---

# Part 3 — Siri and the Home Screen button

This is what makes resuming a single tap. A Shortcut can launch Spotify and *keep
running*; a web page gets suspended the moment you switch apps.

In the app: **⋯ → Siri & Shortcuts**, and copy your resume link.

Then in the **Shortcuts** app → **+** → add three actions:

| | Action | Setting |
|---|---|---|
| 1 | **Open App** | Spotify |
| 2 | **Wait** | 2 seconds |
| 3 | **Get Contents of URL** | paste your resume link |

Name it **Continue listening**. That name becomes the Siri phrase — *"Hey Siri,
Continue listening"*.

Then pick your favourites:

- Long-press the Shortcut → **Add to Home Screen** for an icon
- Settings → **Action Button** → Shortcut (iPhone 15 Pro and later)
- Settings → Accessibility → Touch → **Back Tap** → double tap
- Add a **Shortcuts widget** to the Home Screen — a real widget, no Developer Mode

Tap it and you can pocket the phone. Spotify launches, the Worker notices it come
online, and playback starts at your saved position.

> Anyone with that link can start your playback, so treat it as a password. **New
> key** in the same screen invalidates the old one.

---

# Using it

**Continue** — tap any row to resume, starting 15 seconds early so you don't come
back mid-sentence (**⋯ → Rewind on resume**).

**👤 chip** — switch listeners. Each profile keeps its own bookmarks, so you and a
partner sharing one Spotify account don't overwrite each other. Separate Spotify
accounts are separate logins and never mix.

**🔈 chip** — tap a device to move what's playing there now; tap its star to pin it
for every future resume. Pinning is strict. On automatic, a phone or computer always
wins — a speaker is only used after ~13 seconds of waiting, since an always-on Echo
would otherwise beat a phone that's still launching.

**★ next to Playing now** — follow what's playing: the artist, the album, the
podcast, or the playlist it's playing from.

**★ in the header** — search and follow artists, podcasts, albums, audiobooks, or
plain keywords.

**⋯ on a row** — Continue, **Jump back to earlier**, switch whole-book vs this-part
progress, mark finished, forget.

**Swipe** left or right anywhere on the list to reach the device picker or the
profile picker without scrolling back to the top.

**Sleep timer** (⋯ → Sleep timer) pauses Spotify after 15–60 minutes. It runs on the
server, so it works with the phone asleep and nothing open, and your position is
recorded on the same pass just before playback stops.

**Renaming a profile** (✎ in the 👤 menu) moves every bookmark with it.

**Jump back to earlier** is the fell-asleep fix. Positions are saved as breadcrumbs
while you listen, so if you doze off in chapter 12 and Spotify runs to chapter 40,
pick "22:35 · Chapter 12" and carry on.

Rows show a percentage. Hörspiele and audiobooks measure across the whole thing
("Chapter 17 of 42"); podcasts measure within the episode. Spotify is inconsistent
about which is which, so ⋯ lets you switch.

Episodes past 97% move into a collapsed **Finished** list.

---

# How it holds together

| | |
|---|---|
| **Sync** | Every bookmark is its own row. The Worker keeps the newest of each, so two devices editing different titles can never collide. Closing the page mid-edit no longer loses the write. |
| **Recording** | The Worker polls Spotify every minute for everyone signed in, whether or not anything is open. The app polls every 5s while on screen for finer detail. |
| **Resume** | The Worker waits up to 18 seconds for your device to register, then transfers and seeks. This is why one tap is enough. |
| **Credentials** | Spotify refresh tokens never leave the Worker. Your phone holds a session token and a shortcut key, both revocable. |
| **Chapter maps** | Fetched once, cached server-side, shared by everyone. |

Free-tier headroom is comfortable: the cron uses 1,440 of 100,000 daily requests,
and D1 gives 500 MB where you need kilobytes. Waiting on network doesn't count
against Worker CPU time, so the resume loop is nearly free.

---

# If something goes wrong

| What you see | Fix |
|---|---|
| `INVALID_CLIENT: Invalid redirect URI` | The Redirect URI must be your **Worker** address + `/auth/callback`, not the Pages address. |
| Sign-in returns with `#error=bad_state` | Took longer than an hour, or the Worker redeployed mid-login. Just try again. |
| Sign-in works, then everything 401s | `APP_ORIGIN` in `wrangler.toml` doesn't match your Pages address exactly, so CORS blocks it. Fix and redeploy. |
| "Spotify never came online" | Spotify wasn't installed or was force-quit. Open it once manually. |
| Everything fails with 403 | Your Spotify account isn't on the app's allowlist. Dashboard → Settings → **User Management**. Development mode allows five people. |
| "Spotify Premium is required" | Free accounts can't be controlled by the API. |
| Playback goes to the wrong speaker | Pin the right device via the 🔈 chip. |
| No percentage on a row | The chapter list is still loading, or Spotify won't return it. ⋯ → **Clear chapter cache** forces a retry. |
| Audiobook shows only the current chapter | ⋯ on that row → **Measure progress across the whole book**. |
| Shortcut does nothing | Check the link still matches; pressing **New key** invalidates the old one. |

## Upgrading an existing install

Schema changes ship as files in `worker/migrations/`. Run each once:

```bash
npx wrangler d1 execute contilisten --remote --file=./migrations/001-sleep-timer.sql
```

Then `npx wrangler deploy`. Fresh installs get everything from `schema.sql` and can
skip this.

To see what the Worker is doing: `npx wrangler tail` streams live logs, including
every cron run.
