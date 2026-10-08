# Resonance: Setup and Deployment Guide

This is the one-time path from the code in this repository to a working app at
`https://radardogfly.github.io/music-discovery/`. Six steps, roughly thirty minutes.
Every step is independent of the others except where noted, so they can be done in any order.

| Step | Where | Result |
|---|---|---|
| 1 | GitHub | Repository live, Pages enabled |
| 2 | Spotify Developer Dashboard | Client ID, redirect URI registered |
| 3 | Repository | Client ID written into `index.html` |
| 4 | Terminal | Worker deployed, Claude API key stored as a secret |
| 5 | Unsplash | Ten photographs in `assets/photos/` |
| 6 | Browser | First login, first batch, first verdict |

---

## 1. GitHub Pages

The repository `radardogfly/music-discovery` must be public (GitHub Pages on private repositories requires a paid plan).

1. Push the code to the `main` branch if it is not already there.
2. Open the repository on github.com, then Settings, then Pages (left sidebar).
3. Under Build and deployment, set Source to "Deploy from a branch".
4. Branch: `main`, folder: `/ (root)`. Save.
5. Wait about a minute, then open `https://radardogfly.github.io/music-discovery/`. You should see the login screen with a dark gradient background and "Connect Spotify." Clicking it will fail until step 3 is done.

The app is served straight from the repository root with no build step, so every later push to `main` goes live within a minute.

---

## 2. Spotify Developer App

Requirements: a Spotify account with Premium (now mandatory for app owners in Development Mode).

1. Go to https://developer.spotify.com/dashboard and log in with your Spotify account.
2. Accept the Developer Terms if prompted.
3. Click "Create app".
4. Fill in:
   - App name: `Music Discovery`
   - App description: `Personal music discovery from my own listening history`
   - Website: `https://radardogfly.github.io/music-discovery/`
   - Redirect URIs: `https://radardogfly.github.io/music-discovery/`
     The trailing slash is required and must match `CONFIG.REDIRECT_URI` in `index.html` exactly.
   - Which API/SDKs are you planning to use: tick "Web API"
5. Agree to the terms and click Save.
6. On the app page, click Settings. Copy the **Client ID**. You do not need the Client Secret; PKCE does not use it. Never put the secret anywhere in this project.

Development Mode notes:

- Your own account is automatically authorised. No further user management is needed for personal use.
- The cap is 5 authorised users and one Client ID per developer. If you ever want a friend to use it, add their Spotify email under User Management on the app page.
- Search results are capped at 10 per request for new apps; the frontend requests 3, so this has no effect.

Optional, for local testing only: add a second redirect URI `http://127.0.0.1:8080/`. Spotify does not accept `localhost` but does accept the loopback IP.

---

## 3. Write the Client ID into the frontend

Open `index.html`, find the `CONFIG` block near the top of the script (around line 456), and replace the placeholder:

```js
SPOTIFY_CLIENT_ID: "YOUR_SPOTIFY_CLIENT_ID",
```

with the Client ID from step 2, in quotes. Commit and push. The Client ID is designed to be public; committing it is correct.

---

## 4. Deploy the Worker

Requirements: Node.js 18 or newer on your computer, and a Claude API key from https://console.anthropic.com (Settings, API Keys, Create Key).

The database `music-discovery-db` already exists on your Cloudflare account with the schema applied, and `wrangler.toml` already references it by id. Nothing to create there.

From the repository root:

```bash
cd worker

# First time only: log in to Cloudflare (opens a browser)
npx wrangler login

# Deploy the Worker. Creates it on first run, updates on later runs.
npx wrangler deploy

# Store the Claude API key as a secret. Paste the key when prompted; it is never echoed or written to disk.
npx wrangler secret put ANTHROPIC_API_KEY
```

Verify:

```bash
curl https://music-discovery.haidew.workers.dev/health
# expected: {"ok":true}
```

If the hostname differs from what `wrangler deploy` prints, update `CONFIG.API_BASE` in `index.html` to match, commit, and push.

Alternative without a terminal: in the Cloudflare dashboard, Workers & Pages, Create, "Create Worker", name it `music-discovery`, paste the contents of `worker/src/index.js` into the editor, deploy. Then under the Worker's Settings: Bindings, add a D1 binding named `DB` pointing to `music-discovery-db`; Variables and Secrets, add `ALLOWED_ORIGIN` = `https://radardogfly.github.io` and `CLAUDE_MODEL` = `claude-sonnet-5-5` as plain text, and `ANTHROPIC_API_KEY` as a secret. The result is identical.

Later updates to the Worker: edit `worker/src/index.js`, then `npx wrangler deploy` again. The secret persists across deploys.

---

## 5. Unsplash Photographs

The app works without these (every slot falls back to a dark gradient), so this step can come last or be skipped for the first test. But it is the step that makes the app look the way it was designed to.

Ten JPEGs go in `assets/photos/`, named exactly as below. The mood grading is applied in CSS on top of the photograph, so pick images with the right subject and light; the colour treatment comes from the app.

| File | Search on unsplash.com | What to look for |
|---|---|---|
| `melancholic.jpg` | overcast coast, rain window, grey sea | low contrast, cool light, no people in focus |
| `euphoric.jpg` | golden hour backlit, lens flare, summer light | blown highlights, warmth, movement |
| `restless.jpg` | night street motion blur, neon reflection, city rain | high contrast, blurred lights |
| `serene.jpg` | soft daylight interior, linen curtain, morning window | stillness, pale wood or fabric |
| `driving.jpg` | highway night long exposure, taillights, tunnel | deep blacks, red light trails |
| `hazy.jpg` | fog field, misty forest, faded landscape | lifted blacks, almost no contrast |
| `login.jpg` | empty concert hall, vinyl record close-up, dim stage | low light, atmosphere, no faces |
| `loading.jpg` | light leak abstract, bokeh out of focus, film grain | abstract, nothing to read |
| `empty.jpg` | single chair empty room, bare interior | isolation, one object |
| `profile.jpg` | mixing console, reel to reel tape, analog studio | texture, dials, warmth |

Preparation for each image:

1. Download at the "Large" size (2400px) from Unsplash.
2. Resize so the long edge is 2000px. Any image tool works; on a Mac, Preview, Tools, Adjust Size.
3. Export as JPEG at quality 80. Each file should land under 400KB. This keeps the first paint fast on mobile.
4. Save into `assets/photos/` with the exact filename from the table.
5. Commit and push.

Licence: the Unsplash licence permits this use without attribution; the footer credits Unsplash anyway as a courtesy. Keep a note of the photographer names if you want to extend that credit.

Avoid: images with recognisable faces (the grading makes them look odd), images with text, and anything already heavily colour-graded since the CSS adds its own.

---

## 6. First Run

1. Open `https://radardogfly.github.io/music-discovery/`.
2. Click "Connect Spotify." Spotify asks you to approve four permissions (top items, followed artists, library, recently played). Approve.
3. You return to the app. "Listening." appears while it pulls your data, then the Discover view loads with a hero and twelve cards. The first batch takes 10 to 20 seconds because of the Claude call and twelve Spotify searches.
4. Click a card to expand it. Keep or Pass, choose tags, Done.
5. "Another twelve" fetches a fresh batch that takes your verdicts into account.
6. Profile and Trends work immediately and do not depend on the Worker.

Signing out clears tokens from the browser. Your verdicts remain in D1.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Spotify shows "INVALID_CLIENT: Invalid redirect URI" | Redirect URI mismatch | Make the Spotify app's redirect URI and `CONFIG.REDIRECT_URI` identical, including the trailing slash |
| Spotify shows "INVALID_CLIENT: Invalid client" | Placeholder Client ID still in `index.html` | Step 3 |
| Login works, then "Something went wrong talking to Spotify" | Scope not granted, or Premium missing on the owner account | Sign out, reconnect, approve all permissions; confirm Premium |
| Cards never appear, notice says "Could not reach the recommendation service" | Worker not deployed, wrong `API_BASE`, or CORS | `curl .../health`; check `ALLOWED_ORIGIN` matches `https://radardogfly.github.io` exactly (no path, no trailing slash) |
| Worker returns 500 "ANTHROPIC_API_KEY not configured" | Secret not set | `npx wrangler secret put ANTHROPIC_API_KEY` |
| Worker returns 502 "Claude API 401" | Bad API key | Create a new key in the Claude console and set the secret again |
| Worker returns 502 "Claude API 400 ... model" | Model id not available on your account | Change `CLAUDE_MODEL` in `wrangler.toml`, redeploy |
| Same artists keep appearing | `recommendation_log` empty because `/shown` failed | Check the Worker logs: `npx wrangler tail` |
| Photos not showing | Filename mismatch | Names are case-sensitive and must end in `.jpg` |

Worker logs in real time: `cd worker && npx wrangler tail`.

---

## Maintenance Reference

| Change | Where | Then |
|---|---|---|
| Batch size | `CONFIG.BATCH` in `index.html` | push |
| Feedback tags | `TAGS` in `index.html` | push |
| Source weights | `WEIGHTS` in `index.html` | push |
| Mood colours and grain | stylesheet section 3 in `index.html` | push |
| Prompt wording | `buildPrompt()` in `worker/src/index.js` | `npx wrangler deploy` |
| Claude model | `CLAUDE_MODEL` in `wrangler.toml` | `npx wrangler deploy` |
| Rotate Claude key | `npx wrangler secret put ANTHROPIC_API_KEY` | none |
| Reset all feedback | D1 console: `DELETE FROM feedback_tags; DELETE FROM feedback; DELETE FROM recommendation_log;` | none |
| Add a second user | Spotify dashboard, User Management | they visit the URL |
