# Resonance Worker: Hand-off Document

Repository: `radardogfly/music-discovery`, folder `worker/`
Deployed: Cloudflare Worker `music-discovery` at `https://music-discovery.haidew.workers.dev`
Database: D1 `music-discovery-db`, id `ec5a29ee-7ae1-49a8-b700-05349f8efd11`, region ENAM
Deployment: GitHub Actions, `.github/workflows/deploy-worker.yml`, on every push touching `worker/`
Companion documents: `docs/frontend-handoff.md`, `docs/setup.md`
Revision: October 2026

## 1. What it does

The Worker is the only server-side component. It:

1. Holds every secret: the Claude key, the Unsplash key, the token-encryption key, and (encrypted) the user's Spotify refresh token
2. Issues device keys to browsers and requires one on every route
3. Owns the D1 database: shelf, verdicts, diary, genre labels
4. Runs an hourly scheduled job that pulls recent plays into the diary
5. Calls Claude for recommendations and genre labels, under an hourly ceiling

## 2. Files

```
worker/wrangler.toml   name, D1 binding, public vars, cron trigger
worker/schema.sql      full schema, all applied to the live database
worker/src/index.js    the Worker, no dependencies
```

## 3. Configuration

Public vars in `wrangler.toml`:

| Var | Value | Purpose |
|---|---|---|
| `ALLOWED_ORIGIN` | `https://radardogfly.github.io` | CORS; localhost is also allowed |
| `CLAUDE_MODEL` | `claude-sonnet-5-5` | recommendations |
| `GENRE_MODEL` | `claude-haiku-5-5` | genre labelling |
| `SPOTIFY_CLIENT_ID` | `b55a1fcd...` | needed to refresh Spotify tokens |
| `[triggers] crons` | `0 * * * *` | hourly diary sync |

Secrets, held as GitHub repository secrets and pushed to Cloudflare by the workflow:

| Secret | Purpose |
|---|---|
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | lets the workflow deploy |
| `ANTHROPIC_API_KEY` | Claude |
| `UNSPLASH_ACCESS_KEY` | photographs |
| `TOKEN_KEY` | base64 of 32 random bytes; AES-GCM key for the stored Spotify refresh token |

Rotating a secret: change it in GitHub, then run the workflow (Actions, Deploy Worker, Run workflow). Rotating `TOKEN_KEY` makes the stored Spotify token unreadable; the next browser open re-links automatically.

## 4. Authentication model

- `POST /link` takes a Spotify refresh token (from the browser's PKCE exchange), proves it by refreshing once, stores the rotated token encrypted in `settings`, inserts a hashed random **device key** into `devices`, and returns the key with a current access token.
- Every other route except `/health` requires `Authorization: Bearer <device key>`; `requireDevice()` hashes it and looks it up. Unknown or missing keys get 401.
- `GET /token` returns a cached access token if it has more than two minutes left, otherwise refreshes with Spotify and stores the rotated refresh token. Because the Worker is the sole refresher, Spotify's rotation never invalidates a browser.
- `POST /unlink` deletes the token and all device keys.
- CORS is enforced on browser requests; the device key is what stops non-browser callers.

Encryption: `seal()` and `open()` use AES-GCM with a fresh 12-byte IV per write; stored as `base64(iv).base64(ciphertext)`.

## 5. Routes

| Method | Path | Body or query | Returns |
|---|---|---|---|
| GET | `/health` | | `{ ok }` |
| POST | `/link` | `{ refresh_token, label }` | `{ device_key, access_token, expires_in }` |
| GET | `/token` | | `{ access_token, expires_in }` |
| POST | `/unlink` | | `{ ok }` |
| POST | `/recommend` | `{ profile, count }` | `{ candidates: [{ name, reason, mood, confidence }] }` |
| POST | `/feedback` | `{ artist_name, spotify_id, verdict, mood, genres, tags }` | `{ ok, id }` |
| POST | `/shown` | `{ items: [{ artist_name, spotify_id, reason, mood, image_url, spotify_url, genres }] }` | `{ ok, logged }` |
| GET | `/shelf` | | `{ items }` active, oldest first |
| POST | `/shelf/clear` | | `{ ok, dismissed }` |
| GET | `/history` | | `{ items }` rated plus unrated shown, newest first |
| POST | `/plays` | `{ items: [{ played_at, track_id, track_name, artist_id, artist_name, album_name, release_date, duration_ms, image_url }] }` | `{ ok, added, total, since }` |
| GET | `/plays` | `?since=ISO` | `{ items, total, since, linked, lastSync }` |
| POST | `/genres` | `{ artists: [{ id, name }] }` | `{ genres: { id: [..] }, labelled }` |
| GET | `/photo` | `?slot=` | `{ ok, url, photographer, photographerUrl, photoUrl }` |

## 6. Recommendation pipeline

1. Read feedback memory: last 120 verdicts with tags, rejection-tag counts, last 300 distinct shown artists.
2. Exclusion set: library names from the profile, every rated artist, every shown artist.
3. Build the prompt (`buildPrompt`): listener profile, kept and passed lists with tags, rejection pattern, nine rules. Rule 2 forbids obvious adjacent names; rule 3 turns rejection tags into constraints; rule 5 forces spread.
4. Call Claude with the `recommend_artists` tool available and `tool_choice: auto` plus a system line instructing the tool call. (The forced `tool_choice: tool` mode is not supported by this model.) A text fallback parses JSON if the model answers in prose.
5. Drop exclusions and duplicates; normalise mood.

## 7. Genre labelling

`getGenres` returns cached labels from `artist_genres` and labels missing artists in batches of 60 with Haiku, feeding the 80 most-used existing labels as a vocabulary so names stay consistent. Labels are stored once per artist id. First run for ~100 artists costs well under a cent.

## 8. Shelf and verdicts

`recommendation_log.status` is `active` (on the shelf), `rated` (a verdict was given) or `dismissed` (Replace all). `/feedback` marks the matching active row rated. `/shown` stores image, link and genres so the shelf renders without Spotify. `/history` merges rated rows from `feedback` with unrated rows from `recommendation_log`.

## 9. Diary and hourly sync

`/plays` inserts with `INSERT OR IGNORE` on `played_at`, so re-sending the same 50 is free. The scheduled handler (`syncPlays`) runs hourly: refresh token, fetch `/me/player/recently-played?limit=50`, insert, record the outcome in `settings.last_sync`. The frontend shows that status.

## 10. Claude call ceiling

`claudeBudget()` counts rows in `api_calls` from the last hour before any Claude call and refuses with 429 at 40. Both recommendations and genre labelling count. A monthly spend limit in the Claude console is the hard stop and should also be set.

## 11. Database

Tables: `feedback`, `feedback_tags`, `recommendation_log`, `plays`, `artist_genres`, `settings`, `devices`, `api_calls`. Full definitions in `schema.sql`. Everything is applied to the live database; the file is a record and a way to rebuild.

Useful queries (Cloudflare dashboard, D1, Console):

```sql
SELECT verdict, COUNT(*) FROM feedback GROUP BY verdict;                         -- keep rate
SELECT artist_name, COUNT(*) n FROM plays WHERE played_at > date('now','-30 days') GROUP BY artist_name ORDER BY n DESC LIMIT 10;
SELECT value, updated_at FROM settings WHERE key = 'last_sync';                    -- did the hourly sync run
SELECT COUNT(*) FROM api_calls WHERE at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour');
```

Reset verdicts and shelf: `DELETE FROM feedback_tags; DELETE FROM feedback; DELETE FROM recommendation_log;`
Reset the diary: `DELETE FROM plays;`
Force every browser to log in again: `DELETE FROM devices; DELETE FROM settings WHERE key LIKE 'spotify_%';`

## 12. Errors

400 bad input · 401 missing or unknown device key · 409 `/token` with nothing linked · 429 Claude ceiling · 502 upstream (Claude, Spotify, Unsplash) with the first part of the message · 503 `TOKEN_KEY` not configured.

## 13. Local testing

```
cd worker && npx wrangler dev --remote
```
`--remote` uses the live D1 and secrets. Scheduled handler: `npx wrangler dev --remote --test-scheduled`, then open `http://localhost:8787/__scheduled`.

## 14. Costs

Recommendations: roughly 1,500 input and 1,200 output tokens per call on Sonnet, under a cent. Genres: Haiku, a fraction of that, once per artist. Workers, D1, cron: free tier for one user. Unsplash: 50 requests per hour on the demo tier, far above actual use.
