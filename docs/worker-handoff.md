# Resonance Worker: Hand-off Document

Repository: `radardogfly/music-discovery`, folder `worker/`
Deployed name: `music-discovery` at `https://music-discovery.haidew.workers.dev`
Database: D1 `music-discovery-db`, id `ec5a29ee-7ae1-49a8-b700-05349f8efd11`, region ENAM
Companion documents: `docs/frontend-handoff.md` (Phase 3), `docs/setup.md` (Phase 5)

## 1. Purpose

The Worker is the only server-side component. It exists for two reasons:

1. To hold the Claude API key, which must never reach the browser
2. To own the D1 database that remembers verdicts and what has already been shown, so recommendations improve over time and never repeat

It holds no Spotify credentials and never sees the user's raw listening data, only the aggregated taste profile the frontend sends.

## 2. Files

```
worker/
  wrangler.toml      name, D1 binding, non-secret vars
  schema.sql         D1 schema; already applied to the live database
  src/index.js       the Worker, no dependencies, no build step
```

## 3. Configuration

`wrangler.toml` carries everything that is safe to commit:

| Key | Value | Notes |
|---|---|---|
| `name` | `music-discovery` | becomes the workers.dev hostname |
| `[[d1_databases]].binding` | `DB` | the name used in code as `env.DB` |
| `[[d1_databases]].database_id` | `ec5a29ee-...` | the live database |
| `ALLOWED_ORIGIN` | `https://radardogfly.github.io` | comma-separated list accepted; localhost always allowed |
| `CLAUDE_MODEL` | `claude-sonnet-5-5` | change here to trade cost against quality |

One secret, set outside the file and never committed:

```
npx wrangler secret put ANTHROPIC_API_KEY
```

Model note: Sonnet 5.5 is the default because the task is taste reasoning over a few hundred tokens of profile, which does not need the top tier. `claude-haiku-5-5` is roughly five times cheaper and acceptable for this; `claude-opus-5-5` is noticeably better at avoiding the obvious picks if cost is no concern.

## 4. Endpoints

All responses are JSON. CORS is enforced: requests from an origin not in `ALLOWED_ORIGIN` (or localhost) receive 403.

### POST /recommend

Request:
```json
{ "profile": { ...taste profile from the frontend... }, "count": 16 }
```
`count` is clamped to 8 to 24.

Response:
```json
{ "candidates": [ { "name": "...", "reason": "...", "mood": "hazy", "confidence": 0.7 } ], "model": "claude-sonnet-5-5" }
```

Pipeline:
1. Read feedback memory from D1: the last 120 verdicts with their tags, rejection-tag frequency counts, and the last 300 distinct artists ever shown.
2. Build an exclusion set: library artist names from the profile, every rated artist, every shown artist.
3. Build the prompt (section 5) and call the Claude Messages API with a forced tool call so the output is guaranteed structured.
4. Drop any candidate in the exclusion set or duplicated within the batch. Normalise mood to the six allowed values.

The frontend applies its own second filter (Spotify id match against the library) after resolving names via Search.

### POST /feedback

Request:
```json
{ "artist_name": "...", "spotify_id": "...", "verdict": "up" | "down", "mood": "...", "genres": ["..."], "tags": ["..."] }
```
Writes one `feedback` row and one `feedback_tags` row per distinct tag (max 8). Returns `{ ok: true, id }`. 400 if `artist_name` or a valid `verdict` is missing.

### POST /shown

Request: `{ "items": [ { "artist_name", "spotify_id", "reason", "mood" } ] }` (max 24)
Writes one `recommendation_log` row per item. Returns `{ ok: true, logged: n }`.

### GET /history

Returns `{ items: [...] }`, newest first: every rated artist (with verdict and tags) plus every shown-but-unrated artist (verdict `null`), each capped at 500 rows. The frontend's "Unrated" filter is the null-verdict subset.

### GET /health

Returns `{ ok: true }`. Useful to confirm deployment and CORS before touching the frontend.

## 5. Prompt Design

The prompt is built in `buildPrompt()` and has three sections.

**Listener profile.** Genre weights, era distribution, anchor artists, and the rising/fading signal, all straight from the frontend payload.

**Feedback memory.** Kept artists with their tags, passed artists with their tags, and a tag-frequency summary of all rejections. This is what makes the system learn: a bare thumbs-down teaches nothing, but "passed: X [too mainstream, wrong energy]" repeated across a dozen entries is a precise correction.

**Rules.** Nine numbered constraints. The ones that matter most for the discovery goal:

- Rule 2 forbids the obvious adjacent names and defines what "one or two steps removed" means in practice (scene of origin, producer's other project, regional parallel, earlier generation, current carrier of the sensibility).
- Rule 3 turns the rejection-tag frequencies into hard constraints, mapping each tag to a concrete adjustment.
- Rule 5 forces spread across genres and moods so a batch never collapses into one corner.
- Rule 6 demands the canonical Spotify-searchable name, which is what makes the frontend's Search resolution reliable.

The tool schema (`recommend_artists`) fixes the output shape, enumerates the six moods, and requires exactly `count` items. The call uses `tool_choice: { type: "tool", name: "recommend_artists" }` so the model cannot answer in prose.

To tune behaviour, edit the rules text. To change batch size or over-fetch, change `count` in the frontend's `Api.recommend`. To change how much history feeds the prompt, edit the `LIMIT` values in `recommend()`.

## 6. Database

Schema is in `schema.sql` and is already applied. Three tables:

| Table | Row per | Written by |
|---|---|---|
| `feedback` | verdict | `/feedback` |
| `feedback_tags` | tag on a verdict | `/feedback` |
| `recommendation_log` | artist shown in a batch | `/shown` |

Useful queries for your own analysis (run in the Cloudflare dashboard, D1, Console):

```sql
-- Keep rate overall
SELECT verdict, COUNT(*) FROM feedback GROUP BY verdict;

-- Why you pass
SELECT t.tag, COUNT(*) n FROM feedback_tags t JOIN feedback f ON f.id = t.feedback_id
WHERE f.verdict = 'down' GROUP BY t.tag ORDER BY n DESC;

-- Keep rate by mood
SELECT mood, SUM(verdict = 'up') kept, COUNT(*) total FROM feedback GROUP BY mood;

-- Everything you kept, most recent first
SELECT artist_name, created_at FROM feedback WHERE verdict = 'up' ORDER BY created_at DESC;
```

To wipe and start over: `DELETE FROM feedback_tags; DELETE FROM feedback; DELETE FROM recommendation_log;`

## 7. Error Handling

- Bad input: 400 with `{ error }`.
- Claude API failure: 502 with the status and the first 300 characters of the upstream message.
- Missing secret: 500 `ANTHROPIC_API_KEY not configured`.
- D1 failure: 500 with the SQLite message.
- Disallowed origin: 403.

The frontend treats any non-2xx from `/recommend` as "service unreachable" and shows the empty state; Profile and Trends keep working without the Worker.

## 8. Local Testing

```
cd worker
npx wrangler dev --remote      # uses the live D1 and your secret
curl http://localhost:8787/health
```

`--remote` is needed because the schema lives in the production database. Without it, wrangler uses an empty local SQLite and you would need to apply `schema.sql` to it with `npx wrangler d1 execute music-discovery-db --local --file=schema.sql`.

A mocked smoke test of every route (fake D1, fake Claude) was run during the build and passes: health, feedback with duplicate-tag collapse, shown, history, recommend with library exclusion, and 400 on an invalid verdict.

## 9. Costs

Per refresh: one Claude call of roughly 1,500 input tokens and 1,200 output tokens. On Sonnet 5.5 that is well under one cent. D1 and Workers usage for a single user sit inside the free tier indefinitely.

## 10. Known Limits and Future Work

- No authentication on the Worker. CORS limits browser callers to the Pages origin, but anyone who knows the URL can hit it with curl. For a single private user this is acceptable; if it ever matters, add a shared bearer token as a second secret and check it in `fetch()`.
- `/history` caps at 500 rated and 500 shown rows. A pagination parameter would be a small addition.
- The exclusion of shown artists is by exact lowercase name. A different spelling from Claude would slip through; the frontend's Spotify-id filter catches the library case but not the shown-before case.
