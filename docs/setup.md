# Resonance: Setup and Maintenance Guide

Everything described here is already done for the live deployment. This guide exists so the project can be rebuilt from scratch on a new account, and as the reference for routine maintenance.

Live app: `https://radardogfly.github.io/music-discovery/`
Worker: `https://music-discovery.haidew.workers.dev`

## 1. Accounts and keys

| Service | What you need | Where |
|---|---|---|
| GitHub | a public repository, GitHub Pages on `main` / root | github.com/new, then Settings, Pages |
| Spotify | a developer app (owner on Premium), Web API, redirect URI exactly `https://<user>.github.io/<repo>/` | developer.spotify.com/dashboard |
| Cloudflare | an account; an API token from the "Edit Cloudflare Workers" template with **Account / D1 / Edit** added and Zone Resources set to All zones; the Account ID | dash.cloudflare.com/profile/api-tokens; Workers & Pages overview |
| Claude | an API key (Default workspace, no expiry) and credit on the account; set a monthly spend limit | console.anthropic.com, API Keys; Plans & Billing; Settings, Limits |
| Unsplash | an application; copy the Access Key only | unsplash.com/oauth/applications |

Generate the token-encryption key on any machine: `openssl rand -base64 32`.

## 2. Repository secrets

GitHub, repository Settings, Secrets and variables, Actions. Names must match exactly:

`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `ANTHROPIC_API_KEY`, `UNSPLASH_ACCESS_KEY`, `TOKEN_KEY`

## 3. Database

Create a D1 database named `music-discovery-db` (dashboard or `npx wrangler d1 create music-discovery-db`), put its id into `worker/wrangler.toml`, and apply the schema:

```
npx wrangler d1 execute music-discovery-db --remote --file=worker/schema.sql
```

## 4. Deploy

Push to `main`. The workflow `Deploy Worker` runs on any change under `worker/`, deploys with wrangler, pushes every secret listed above to the Worker, and health-checks the live URL. It can also be run by hand from the Actions tab. The frontend needs no build: Pages serves `index.html` from the repository root within a minute of each push.

Frontend values to check in `index.html` `CONFIG`: `SPOTIFY_CLIENT_ID`, `REDIRECT_URI` (trailing slash required), `API_BASE` (no trailing slash). Worker value to check in `wrangler.toml`: `SPOTIFY_CLIENT_ID` must match the frontend.

## 5. First run

Open the app, Connect Spotify, approve the four read permissions. The first load labels your top artists with Claude (a few seconds), saves your recent plays, hands the Spotify token to the Worker and builds the shelf (about twenty seconds). From then on, opening the app is instant.

iPhone or iPad: open the URL in Safari, Share, Add to Home Screen. The name is pre-filled as Music Discovery.

## 6. Routine maintenance

| Task | How |
|---|---|
| Change a photo mood's search terms | `PHOTO_QUERIES` in `worker/src/index.js`, push |
| Tune recommendation rules | `buildPrompt()` in `worker/src/index.js`, push |
| Change models or the hourly ceiling | `wrangler.toml` vars; `CLAUDE_CALLS_PER_HOUR` in the Worker |
| Change batch size, tags, source weights | `CONFIG`, `TAGS`, `WEIGHTS` in `index.html`, push |
| Rotate a key | update the GitHub secret, run the workflow |
| Check the hourly sync ran | Diary tab status line, or `SELECT value FROM settings WHERE key='last_sync'` in the D1 console |
| Revoke the app's Spotify access entirely | Spotify account, Apps, remove Music Discovery; or Sign out in the app |
| See spend | console.anthropic.com, Usage |

## 7. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Spotify "Invalid redirect URI" | mismatch, usually the trailing slash | match the Spotify app setting and `CONFIG.REDIRECT_URI` exactly |
| "Recommendation error: API 401" | browser has no valid device key | Sign out and connect again |
| "Recommendation error: API 503 TOKEN_KEY not configured" | secret missing on the Worker | add `TOKEN_KEY` on GitHub, run the workflow |
| "Claude API 400 credit balance too low" | no credit | Plans & Billing |
| "hourly Claude call limit reached" | the 40-per-hour ceiling | wait, or raise `CLAUDE_CALLS_PER_HOUR` |
| Diary status says last check failed | Spotify refresh failed | open the app once; it re-links |
| Photographs not appearing | Unsplash key missing or rate-limited | check `UNSPLASH_ACCESS_KEY`; the gradient fallback is intentional |
| Genres look thin | labelling not run yet | open the app; labels are written on first load |

Worker logs in real time: `cd worker && npx wrangler tail`.
