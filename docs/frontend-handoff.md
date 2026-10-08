# Resonance Frontend: Hand-off Document

Repository: `radardogfly/music-discovery`
File covered: `index.html` (single-file application, no build step)
Companion documents: `docs/worker-handoff.md` (Phase 4), `docs/setup.md` (Phase 5)

## 1. Purpose

A single-page static web app, served from GitHub Pages, that:

1. Authenticates the user with Spotify (Authorization Code with PKCE, no client secret)
2. Pulls the user's listening data directly from the Spotify Web API in the browser
3. Builds a weighted taste profile client-side
4. Sends that profile to a Cloudflare Worker, which asks Claude for artist recommendations
5. Resolves each recommendation to a real Spotify artist via Search and renders twelve of them in a film-grain, Unsplash-style masonry grid
6. Captures Keep/Pass verdicts with reason tags and sends them to the Worker for storage in D1, so the next batch improves

Listening data never leaves the browser except as the aggregated profile. Only verdicts and the recommendation log are persisted.

## 2. File Structure

```
music-discovery/
  index.html                 the entire app: styles, markup, script
  assets/photos/             ten Unsplash JPEGs (user-supplied, see section 9)
    README.md
  docs/
    frontend-handoff.md      this file
```

Inside `index.html`, in order:

| Block | Lines (approx) | Contents |
|---|---|---|
| `<style>` 1 to 3 | 15 to 150 | Design tokens, base reset, grain and mood grading |
| `<style>` 4 to 11 | 150 to 330 | Nav, screens, masonry, card, profile, trends, history, footer |
| Markup | 335 to 450 | Nav, login, loading, four views, footer, notice |
| Script: CONFIG | 455 to 470 | All deployment constants |
| Script: Auth | 500 to 560 | PKCE flow, token storage, refresh |
| Script: Spotify | 565 to 610 | API wrapper, data pull, artist search |
| Script: buildProfile | 615 to 680 | Taste profile construction |
| Script: Api | 685 to 705 | Worker client |
| Script: views | 710 to 830 | Discover, Profile, Trends, History renderers |
| Script: boot | 835 to 855 | Navigation wiring and startup sequence |

## 3. Configuration

All deployment-specific values live in the `CONFIG` object at the top of the script.

```js
const CONFIG = {
  SPOTIFY_CLIENT_ID: "YOUR_SPOTIFY_CLIENT_ID",
  REDIRECT_URI: "https://radardogfly.github.io/music-discovery/",
  API_BASE: "https://music-discovery.haidew.workers.dev",
  SCOPES: "user-top-read user-follow-read user-library-read user-read-recently-played",
  BATCH: 12,
};
```

- `SPOTIFY_CLIENT_ID` is the only value that must be filled in before first use. It comes from the Spotify Developer Dashboard (Phase 5). It is safe to commit; Client IDs are public by design under PKCE.
- `REDIRECT_URI` must match the Spotify app settings exactly, including the trailing slash.
- `API_BASE` has no trailing slash.
- `BATCH` is how many artists render per refresh. The Worker is asked for 16 so filtering leaves twelve.

Other tunables:

- `WEIGHTS` controls how each Spotify source contributes to the taste profile.
- `TAGS` defines the reason tags shown after Keep or Pass.
- `MOODS` is the closed list the Worker must return from; unknown values fall back to `serene`.

## 4. Authentication

Standard PKCE:

1. `Auth.login()` generates a 64-character verifier, stores it in `sessionStorage`, computes the S256 challenge, and redirects to `accounts.spotify.com/authorize`.
2. On return, `Auth.handleCallback()` reads `?code=`, exchanges it at `accounts.spotify.com/api/token` with the verifier, then cleans the URL with `history.replaceState`.
3. Tokens are stored in `localStorage` as `sp_access`, `sp_expires`, `sp_refresh`.
4. `Auth.ensure()` runs on every load: uses the stored access token if not expired, otherwise refreshes silently.
5. `Spotify.get()` retries once on 401 after a refresh, and honours `Retry-After` on 429.
6. Sign out clears the three keys and reloads.

The scopes requested are the minimum needed. Adding scopes requires users to re-authorize.

## 5. Spotify Data Pull

`Spotify.pullAll()` runs nine requests in parallel and stores the results in `state.raw`:

| Key | Endpoint | Used by |
|---|---|---|
| `topArtists.long/medium/short` | `/me/top/artists?time_range=` | Profile, Trends, taste profile |
| `topTracks.long/medium/short` | `/me/top/tracks?time_range=` | Taste profile, era distribution |
| `following` | `/me/following?type=artist` | Taste profile (highest weight), anchors |
| `liked` | `/me/tracks` | Taste profile |
| `recent` | `/me/player/recently-played` | Taste profile, low weight. Wrapped in a catch because this endpoint fails on accounts with no playback history |

All endpoints are limited to 50 items, the maximum per request. No pagination is performed; for a single user's taste profile the top 50 of each is sufficient signal.

## 6. Taste Profile Construction

`buildProfile()` produces `state.profile`, the only payload sent to the Worker:

```json
{
  "topGenres":          [{ "genre": "...", "weight": 0.0 to 1.0 }],   up to 15
  "anchorArtists":      ["..."],                                        top 12 names
  "eraDistribution":    { "1990s": 0.12, "2010s": 0.44 },               shares summing to 1
  "libraryArtistIds":   ["..."],                                        every artist id seen
  "libraryArtistNames": ["..."],                                        every artist name seen
  "trendSignal":        { "emerging": ["..."], "fading": ["..."] }
}
```

Scoring logic:

- Every artist encountered in any source accumulates a score. Weights per source are in `WEIGHTS`. Ranked lists decay linearly by position (`1 - index/100`) so the first entry counts more than the fiftieth.
- Genres are only present on full artist objects, not on the partial artist objects attached to tracks. A second pass copies genres from any full artist object with the same id onto track-only artists, so their score contributes to the genre vector.
- `eraDistribution` is built from album release years on tracks, bucketed by decade.
- `emerging` is artists in the short-term top 50 but absent from long-term; `fading` is the reverse.
- `libraryArtistIds` and `libraryArtistNames` are the exclusion list. Nothing already in the library is ever shown as a discovery.

Also stored for the Profile view: `state.anchors` (top 18 with images), `state.genres`, `state.eras`.

## 7. Recommendation Flow

`loadRecommendations()`:

1. `POST {API_BASE}/recommend` with `{ profile, count: 16 }`. Expects `{ candidates: [{ name, reason, mood, confidence }] }`.
2. For each candidate, in order: skip if already seen this batch, previously passed (from history), or present in library names.
3. `Spotify.searchArtist(name)` resolves the name. Exact normalized match preferred, else first result. Skip if nothing found or the resolved id is in `libraryArtistIds`.
4. Stop at `BATCH` resolved artists.
5. Fire-and-forget `POST /shown` with the batch so the Worker can avoid repeats across sessions.
6. Render.

If the Worker is unreachable, an empty state renders and a notice appears. The app is still usable for Profile and Trends, which need no Worker.

## 8. Feedback Flow

1. Clicking a card's photo toggles the inline detail panel.
2. "Keep" or "Pass" sets `r.verdict` and reveals the matching tag set from `TAGS`.
3. Tag chips are multi-select; the selection is held in `r.tags`.
4. "Done" calls `commitFeedback()`: dims the card to 60 percent, stamps the verdict in the corner, and `POST /feedback` with:

```json
{ "artist_name", "spotify_id", "verdict": "up" | "down", "mood", "genres": [], "tags": [] }
```

5. The verdict is prepended to `state.history` so the History view updates without a refetch.

## 9. Visual System Implementation

All of Phase 2 is implemented in CSS; nothing is image-processed server-side.

**Grain** is a single `::after` pseudo-element on every `.photo` container, using an inline SVG `feTurbulence` tile at 220px, `mix-blend-mode: overlay`. Opacity is set per mood through the `--grain` custom property (0.08 light, 0.14 medium, 0.22 heavy).

**Mood grading** is applied by adding `mood-<name>` to any `.photo` container. Each class sets a CSS `filter` on the image, a multiply-blended `.tint` layer colour, the `--grain` weight, and `--mood` (the accent colour used by the card's left border and mood label). To change a grade, edit the three rules for that mood in section 3 of the stylesheet.

**Vignette and light leak** come from the `::before` pseudo-element; `.leak` adds the warm diagonal gradient and is only used on hero-scale images.

**Masonry** uses CSS `column-count` (3, 2, 1 by breakpoint) with `break-inside: avoid`. Cards cycle through three aspect ratios (`r34`, `r11`, `r43`) in a fixed sequence so the grid never looks uniform.

**Theme** follows the system by default. Setting `data-theme="light"` or `data-theme="dark"` on `<html>` overrides it; no toggle is exposed in the UI.

**Photographs** load from `assets/photos/<slot>.jpg`. Every `<img>` has an `onerror` that swaps in a dark gradient `div.fill`, so the app renders correctly before photos are added. Slots and search direction:

| File | Search direction on Unsplash |
|---|---|
| `melancholic.jpg` | overcast coastline, rain on window, muted |
| `euphoric.jpg` | backlit figure, golden hour, lens flare |
| `restless.jpg` | night street, motion blur, neon reflections |
| `serene.jpg` | still interior, soft daylight, linen or wood |
| `driving.jpg` | highway at night, long exposure |
| `hazy.jpg` | fogged field, faded landscape |
| `login.jpg` | empty concert hall or vinyl close-up, low light |
| `loading.jpg` | abstract light leak, out of focus |
| `empty.jpg` | single chair in an empty room |
| `profile.jpg` | analog mixing desk or tape reel |

Recommended export: 2000px on the long edge, JPEG quality 80, to keep each under 400KB. Unsplash licence permits this use; attribution is already present in the footer.

## 10. Worker Contract

The frontend expects these endpoints on `API_BASE`, all JSON, CORS enabled for the Pages origin:

| Method | Path | Request | Response |
|---|---|---|---|
| POST | `/recommend` | `{ profile, count }` | `{ candidates: [{ name, reason, mood, confidence }] }` |
| POST | `/feedback` | `{ artist_name, spotify_id, verdict, mood, genres, tags }` | `{ ok: true }` |
| POST | `/shown` | `{ items: [{ artist_name, spotify_id, reason, mood }] }` | `{ ok: true }` |
| GET | `/history` | none | `{ items: [{ artist_name, verdict, tags, mood, created_at }] }` |

`/history` should return both rated entries (from `feedback`) and unrated shown entries (from `recommendation_log`), newest first. Entries without a verdict render under the "Unrated" filter.

## 11. Running Locally

The app can be opened as a file for layout work, but Spotify auth requires the registered redirect URI, so a real login only works at the deployed Pages URL or an additional redirect URI registered in the Spotify app. For local auth testing, add `http://127.0.0.1:8080/` to the Spotify app's redirect list, set `CONFIG.REDIRECT_URI` to match temporarily, and serve with `python3 -m http.server 8080`.

## 12. Known Limits and Future Work

- Spotify Development Mode caps the app at 5 authorized users and requires the owner to hold Premium. This build is single-user by design.
- `/me/player/recently-played` returns nothing for accounts that have not played anything recently; the profile still builds from the other eight sources.
- Artist resolution via Search can mismatch on very common names. The exact-match preference reduces this; a future improvement is to let Claude return the artist's best-known album alongside the name and verify against it.
- Masonry via CSS columns orders cards top-to-bottom per column, not left-to-right. This matches Unsplash's reading order and is intentional.
- There is no pagination of history. For a single user this stays fast for years.
