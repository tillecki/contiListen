# ContiListen

Bookmarks your position in Spotify Hörspiele (*Die drei ???*, *Sherlock Holmes*) and
resumes exactly where you stopped. Spotify only does this for podcasts, not for
albums.

A web page, so nothing gets installed — it works on a locked-down work phone.

**You need:** Spotify Premium, a GitHub account, and the Spotify app open on some
device when you press play.

---

# Part 1 — Get it working

About 10 minutes. Do all five steps.

## 1. Create a Spotify app

Go to <https://developer.spotify.com/dashboard> → **Create app**.

- Name: anything
- Redirect URI: leave blank for now
- APIs used: tick **Web API**

Click into the app → **Settings** → copy the **Client ID**. Keep the tab open.

## 2. Put the files on GitHub

1. Create a **new repository** called `contilisten`. Make it **Public**.
2. **Add file → Upload files** → drag in `index.html` and `sw.js` → **Commit**.
3. **Settings → Pages** → Source: *Deploy from a branch* → Branch `main`, folder
   `/ (root)` → **Save**.

Wait a minute and reload. Your address appears at the top:

```
https://YOURNAME.github.io/contilisten/
```

Copy it, including the trailing slash.

## 3. Register that address with Spotify

Back in the Spotify tab: **Settings → Edit** → under **Redirect URIs** paste your
Pages address exactly → **Add** → **Save**.

It must match character for character. A missing trailing slash counts as different.

## 4. Add your Client ID

On GitHub, open `index.html` → pencil icon → find this near the top:

```js
const CLIENT_ID = 'PASTE_YOUR_SPOTIFY_CLIENT_ID';
```

Paste your Client ID between the quotes. **Commit changes.** Wait a minute.

## 5. Open it on your phone

1. Open your Pages address in **Safari** (must be Safari, not Chrome).
2. Tap **Connect Spotify** and approve.
3. Share button → **Add to Home Screen**.

Done. Play something in Spotify, then open ContiListen — it appears under
**Continue**. Tap it to resume.

---

# Part 2 — Sync your phone and laptop

Optional, 5 minutes. Without this, each browser keeps its own separate list.

1. Go to <https://github.com/settings/tokens> → **Tokens (classic)** →
   **Generate new token (classic)**.
2. Note: `contilisten`. Expiration: *No expiration*.
3. Tick **only** the `gist` checkbox. Nothing else.
4. **Generate token** and copy it (starts with `ghp_`).
5. In ContiListen: **⋯ → Connect**, paste, tap **Connect**.

On your other devices, paste the same token. They find each other automatically.

> Must be a *classic* token. Fine-grained tokens can't access gists.

---

# Part 3 — Record position while the app is closed

Optional, 15 minutes. Without this, your position is only saved while ContiListen is
open. With it, a job runs every 5 minutes and saves your position even when nothing
is open.

## 1. Get your client secret

Spotify dashboard → your app → **Settings** → **View client secret** → copy it.

On the same page, **Edit** and add a second redirect URI:

```
http://127.0.0.1:8080/callback
```

## 2. Run the setup script once, on your computer

Download `scripts/bootstrap_token.py`, then:

```bash
export SPOTIFY_CLIENT_ID=your_client_id
export SPOTIFY_CLIENT_SECRET=your_client_secret
python3 bootstrap_token.py
```

Your browser opens, you approve, and the terminal prints a long token. Copy it.

## 3. Upload the job files

Upload to your repo, keeping the folder structure:

- `scripts/poll.py`
- `.github/workflows/poller.yml`

## 4. Add the secrets

Repo → **Settings → Secrets and variables → Actions → New repository secret**.
Add these four:

| Name | Value |
|---|---|
| `SPOTIFY_CLIENT_ID` | from the dashboard |
| `SPOTIFY_CLIENT_SECRET` | from the dashboard |
| `SPOTIFY_REFRESH_TOKEN` | printed by the script |
| `GIST_TOKEN` | the same `ghp_` token from Part 2 |

## 5. Start it

Play something in Spotify. Then repo → **Actions** tab → **ContiListen position
poller** → **Run workflow**. Open the run and check the log — it prints what it saw.

From now on it runs by itself every 5 minutes.

> **Keep the repo public.** Private repos only get 2,000 free Action minutes a month
> and this would exceed that. Your secrets stay encrypted either way.
>
> GitHub switches off scheduled jobs after 60 days of no repo activity and emails
> you. One click in the Actions tab restarts it.

---

# Using it

**Continue** — tap any row to resume. It starts 15 seconds early so you don't come
back mid-sentence (change under **⋯ → Rewind on resume**).

**👤 chip** — switch between listeners. Each profile keeps its own bookmarks, so you
and your partner won't overwrite each other in the same series.

**🔈 chip** — choose where playback goes. Pin your phone here if you're tired of
audio landing on the kitchen speaker. Speakers are never picked automatically.

**★ button** — follow an artist and get their full episode list, so you can start any
episode straight from the app. Or add an album, or a keyword.

**⋯ on a row** — Continue, **Jump back to earlier**, Mark as finished, Forget.

**Jump back to earlier** is the fell-asleep fix. Positions are saved as breadcrumbs
while you listen, so if you doze off in chapter 12 and Spotify runs on to chapter 40,
you can pick "22:35 · Chapter 12" and carry on from there.

Episodes past 97% move themselves into a collapsed **Finished** list.

---

# If something goes wrong

| What you see | Fix |
|---|---|
| `INVALID_CLIENT: Invalid redirect URI` | Pages address and Spotify redirect URI don't match. Check the trailing slash. |
| Sign-in loops back to the start | `CLIENT_ID` in `index.html` is still the placeholder. |
| "Spotify Premium is required" | Free account, or you authorised the wrong Spotify account. |
| Everything fails with 403 | Your Spotify account isn't on the app's allowlist. Dashboard → Settings → **User Management** → add the email. Development mode allows five people. |
| "No Spotify device found" | Spotify isn't open anywhere. Tap **Open Spotify here** in the 🔈 menu, then try again. |
| Playback goes to the wrong speaker | Pin the right device via the 🔈 chip. |
| Bookmarks disappeared | Safari clears site data after ~7 days of not visiting. Set up Part 2 and it's recoverable. |
| GitHub token rejected | Must be a classic token with the `gist` scope. Fine-grained tokens don't work. |

**Position is up to 5 minutes behind** if you use Part 3, because that's GitHub's
minimum schedule and runs are often later. Without Part 3, position only saves while
the app is open.
