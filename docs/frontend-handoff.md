# Resonance Frontend: Hand-off Document

Repository: `radardogfly/music-discovery`
Live: `https://radardogfly.github.io/music-discovery/`
File covered: `index.html` (single-file application, no build step), `manifest.webmanifest`, `assets/icon/`
Companion documents: `docs/worker-handoff.md`, `docs/setup.md`
Revision: October 2026, after the shelf, diary, Taste and Diary tabs, device keys and embedded player

## 1. What it is

A single-page web app, served from GitHub Pages, with four tabs:

| Tab | Question it answers | Data |
|---|---|---|
| Discover | What should I listen to next? | A persistent shelf of twelve Claude-recommended artists |
| Taste | Who am I as a listener? | Genre record, Core/orbit/passing |
| Diary | When and how much do I listen? | Listening clock, top ten by week/month/year, library rings |
| History | What has the app shown me? | Every recommendation, with verdicts and tags |

Display name inside the app: Resonance. Home-screen name: Music Discovery.

## 2. Files

```
index.html                 the app: styles, markup, script
manifest.webmanifest       home-screen install: name, icons, colours
assets/icon/icon.svg       source of the app icon (midnight and brass record)
assets/icon/*.png          renders: apple-touch-icon 180, 192, 512, favicon 32
assets/photos/README.md    legacy: bundled photos were replaced by live Unsplash
```

Inside `index.html`, in order: tokens and base CSS; grain and mood grading; nav; screens and heroes; masonry and cards; Taste (record, orbit); Diary (clock, top ten, rings); History; then the script in blocks: CONFIG, state, utilities, Auth, Spotify, diary and genres, taste profile, Api, photographs, Discover, Taste, Diary, History, navigation and boot.

## 3. Configuration

```js
const CONFIG = {
  SPOTIFY_CLIENT_ID: "b55a1fcd707849d4937235a08fe48bf3",
  REDIRECT_URI: "https://radardogfly.github.io/music-discovery/",
  API_BASE: "https://music-discovery.haidew.workers.dev",
  SCOPES: "user-top-read user-follow-read user-library-read user-read-recently-played",
  BATCH: 12,
};
```

Other tunables near the top of the script: `WEIGHTS` (how each Spotify source contributes to the taste profile), `TAGS` (reason chips after Keep or Pass), `MOODS` (the closed list the Worker returns from). The eight-slot categorical palette for the genre record is in CSS as `--g1` to `--g8`; it was validated for colour-vision deficiency and contrast on both surfaces and must be kept in that order.

## 4. Authentication and the device key

Login is Authorization Code with PKCE in the browser, so there is no client secret anywhere.

What changed from the first build: the browser no longer keeps the Spotify refresh token. After the code exchange, `Auth.link()` posts the refresh token to the Worker's `/link`, which stores it encrypted and returns a **device key**. The browser keeps `device_key`, `sp_access` and `sp_expires` in `localStorage`, and removes `sp_refresh`.

- Every call to the Worker sends `Authorization: Bearer <device_key>` (see `Api.headers()`).
- When the access token expires, `Auth.refresh()` asks the Worker's `/token` for a new one. The Worker is the only party that refreshes with Spotify, which matters because Spotify rotates PKCE refresh tokens on every use.
- A browser that still has a legacy `sp_refresh` from before linking refreshes locally once, then links. This path can be removed in a future revision.
- Sign out posts `/unlink` (which wipes the token and every device key on the Worker), then clears local storage.
- If `/link` fails (for example the Worker's `TOKEN_KEY` is unset), the app falls back to holding the token in the browser and keeps working without hourly sync.

## 5. Data pulled from Spotify

`Spotify.pullAll()` runs nine requests in parallel: top artists and top tracks for `short_term`, `medium_term`, `long_term`; followed artists; the first 50 saved tracks; recently played (kept with `played_at` as `recentPlays`). The Diary tab additionally pages the entire saved-tracks library (`loadLibrary()`, 50 per request, four in parallel, capped at 6,000) the first time it is opened.

Spotify data that is **no longer available** to this app and must not be relied on: audio features, recommendations, related artists, artist top tracks, popularity, followers. Artist `genres` still exists but is being emptied by Spotify; see section 6.

## 6. Genres

`applyGenres()` runs before the profile is built. It sends every full artist object the app holds (followed plus the three top-artist lists) to the Worker's `/genres`, which returns stored Claude labels and labels anything new. Those labels overwrite `artist.genres` in memory, so the taste profile, the genre record and Claude's own recommendation prompt all use the same vocabulary.

## 7. Taste profile

`buildProfile()` scores every artist seen across sources with `WEIGHTS`, decaying by list position, and produces the payload sent to `/recommend`: `topGenres`, `anchorArtists`, `eraDistribution`, `libraryArtistIds`, `libraryArtistNames`, `trendSignal`. The two library lists are the exclusion set; nothing already yours is ever shown as a discovery.

## 8. Discover: the shelf

The twelve are persistent. `loadShelf()` reads them from `/shelf` (image, link, genres included, so no Spotify lookups), renders, then `topUpShelf()` fills only the empty slots with one `/recommend` call for `need + 4` candidates. Each candidate is resolved against Spotify Search (`Spotify.searchArtist`, exact normalised match preferred), filtered against the library and the current shelf, and the first `need` survivors are appended and logged with `/shown`.

Card interactions: clicking the photo expands the card; the first expansion injects Spotify's embedded player for that artist (`open.spotify.com/embed/artist/<id>`, dark theme, 152px). Keep or Pass reveals tag chips; Done posts `/feedback`, dims the card, then after a beat removes it and tops up one replacement. "Replace all" posts `/shelf/clear` and rebuilds.

The hero's mood is the most common mood on the shelf; its photograph is swapped when that changes.

## 9. Taste

**Genre record** (`renderRecord`): shares computed from the chosen window's top-artist list (rank-weighted), top eight plus "everything else", drawn as thick arcs on one radius with a 2px surface gap, faint grooves over them, a paper label in the centre. Hover or tap a band or its list row to see share and the three artists behind it. The window switch recomputes.

**Core, orbit, passing** (`renderOrbit`): artists placed on three rings by how many of the three windows contain them. Right half is arriving (present in the shorter window), left half is leaving. Face size per ring is computed from available arc so neighbours never touch. Tapping a face shows its rank in each window. A one-line takeaway is written from the counts.

## 10. Diary

Loaded on first visit (`openDiary`): `/plays` for the diary, then the full library.

- **Status line** (`renderDiaryStatus`): total plays, start date, progress toward the first week or month, and whether plays are collected hourly (Worker linked) or only on open.
- **Your day** (`renderClock`): 24 bars on a dial, midnight at top, busiest hour in brass, weekday bars beside it. Needs at least 10 plays.
- **Top ten** (`renderTopTen`): a **Your diary / Spotify** source switch, an **Artists / Tracks** switch, three columns (tabs on phones). Diary mode counts real plays for the last 7, 30 and 365 days via `diaryLists()`; Spotify mode uses the three native windows. Movement chevrons compare with the longer window. The app defaults to diary mode once 30 plays exist.
- **All your years** (`renderRings`): one dot per saved song, rings per year oldest at centre, months clockwise from the top; deterministic jitter spreads dots across the band. Hover or tap a month sector for its count and top artists.

## 11. Photographs

`setPhoto(container, slot)` asks the Worker's `/photo` for one Unsplash image for the slot (`login`, the six moods, `profile`, `diary`, `history`), fades it in over the gradient fallback, and writes the photographer credit. Every open gets a fresh image. If the request fails, the gradient stays.

## 12. Visual system

Unchanged in principle from the design spec: Fraunces and Inter; warm paper light mode, dark follows system; one CSS grain (`feTurbulence` tile, `mix-blend-mode: overlay`, weight per mood via `--grain`); mood grading by `filter` plus a multiplied `.tint`; vignette and light leak on heroes; CSS-column masonry. Safe-area insets are applied on nav, heroes, footer and notices. On touch devices the card reason line is always visible.

## 13. Known limits

- Spotify Development Mode: owner needs Premium; at most 5 authorised users.
- Spotify remembers only 50 plays; the hourly Worker sync keeps the diary complete for normal listening, but a very long session between two hourly checks can still drop plays.
- Search resolution can mismatch on very common artist names.
- CSS-column masonry orders cards top-to-bottom per column, by design.
- The library read is capped at 6,000 songs.
