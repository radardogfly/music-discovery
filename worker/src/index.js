/**
 * Resonance API: Cloudflare Worker for music-discovery
 *
 * Every route except /health and /link requires a device key (Authorization: Bearer <key>),
 * issued once per browser at /link. The Worker holds the Spotify refresh token (encrypted)
 * and is the only party that refreshes it, so browsers fetch access tokens from /token.
 *
 * Routes
 *   POST /link            exchange a fresh Spotify refresh token for a device key
 *   GET  /token           a current Spotify access token for a linked device
 *   POST /unlink          forget the Spotify token and all device keys
 *   POST /recommend       taste profile in, Claude-ranked artist candidates out
 *   POST /feedback        store a Keep/Pass verdict with tags
 *   POST /shown           add rendered artists to the shelf
 *   GET  /shelf           the persistent unrated set
 *   POST /shelf/clear     dismiss the whole shelf
 *   GET  /history         everything rated and shown, newest first
 *   POST /plays           copy recent plays into the diary
 *   GET  /plays           the diary
 *   POST /genres          Claude genre labels, cached per artist
 *   GET  /photo           one Unsplash photograph for a slot
 *   GET  /health          liveness
 *
 * Scheduled (hourly): refresh the Spotify token, pull recently played, append to the diary.
 *
 * Bindings
 *   env.DB                  D1 database (music-discovery-db)
 *   env.ANTHROPIC_API_KEY   secret
 *   env.UNSPLASH_ACCESS_KEY secret
 *   env.TOKEN_KEY           secret, base64 32 bytes, encrypts the Spotify refresh token at rest
 *   env.SPOTIFY_CLIENT_ID   public client id, used to refresh tokens
 *   env.ALLOWED_ORIGIN      the GitHub Pages origin, for CORS
 *   env.CLAUDE_MODEL        recommendation model;  env.GENRE_MODEL  labelling model
 */

const MOODS = ["melancholic", "euphoric", "restless", "serene", "driving", "hazy"];
const MAX_CANDIDATES = 24;
const CLAUDE_CALLS_PER_HOUR = 40;

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (origin && !isAllowed(origin, env)) return json({ error: "origin not allowed" }, 403, cors);

    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/health") return json({ ok: true }, 200, cors);
      if (request.method === "POST" && url.pathname === "/link") return json(await link(await request.json(), env), 200, cors);

      const device = await requireDevice(request, env);
      if (!device) return json({ error: "unauthorized" }, 401, cors);

      if (request.method === "GET" && url.pathname === "/token") return json(await currentToken(env), 200, cors);
      if (request.method === "POST" && url.pathname === "/unlink") return json(await unlink(env), 200, cors);
      if (request.method === "GET" && url.pathname === "/history") return json(await getHistory(env), 200, cors);
      if (request.method === "GET" && url.pathname === "/shelf") return json(await getShelf(env), 200, cors);
      if (request.method === "POST" && url.pathname === "/plays") return json(await savePlays(await request.json(), env), 200, cors);
      if (request.method === "GET" && url.pathname === "/plays") return json(await getPlays(url, env), 200, cors);
      if (request.method === "POST" && url.pathname === "/genres") return json(await getGenres(await request.json(), env), 200, cors);
      if (request.method === "GET" && url.pathname === "/photo") return json(await getPhoto(url.searchParams.get("slot") || "serene", env), 200, cors);
      if (request.method === "POST" && url.pathname === "/shelf/clear") return json(await clearShelf(env), 200, cors);
      if (request.method === "POST" && url.pathname === "/recommend") return json(await recommend(await request.json(), env), 200, cors);
      if (request.method === "POST" && url.pathname === "/feedback") return json(await saveFeedback(await request.json(), env), 200, cors);
      if (request.method === "POST" && url.pathname === "/shown") return json(await logShown(await request.json(), env), 200, cors);
      return json({ error: "not found" }, 404, cors);
    } catch (e) {
      console.error(e);
      return json({ error: e.message || "internal error" }, e.status || 500, cors);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(syncPlays(env));
  },
};

/* ------------------------------------------------------------------
   CORS and helpers
   ------------------------------------------------------------------ */
function isAllowed(origin, env) {
  const allowed = (env.ALLOWED_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean);
  return allowed.includes(origin) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}
function corsHeaders(origin, env) {
  return {
    "Access-Control-Allow-Origin": isAllowed(origin, env) ? origin : "null",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}
function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}
function bad(msg) { const e = new Error(msg); e.status = 400; return e; }
const str = (v, max = 200) => (typeof v === "string" ? v.slice(0, max) : "");

/* ------------------------------------------------------------------
   Device keys
   ------------------------------------------------------------------ */
const b64 = u8 => btoa(String.fromCharCode(...u8));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function sha256(s) { return b64(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))); }

async function requireDevice(request, env) {
  const h = request.headers.get("Authorization") || "";
  const key = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  if (!key) return null;
  const hash = await sha256(key);
  const row = await env.DB.prepare("SELECT key_hash FROM devices WHERE key_hash = ?").bind(hash).first();
  if (!row) return null;
  env.DB.prepare("UPDATE devices SET last_seen = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE key_hash = ?").bind(hash).run().catch(() => {});
  return hash;
}

/* ------------------------------------------------------------------
   Spotify token store: refresh token encrypted at rest (AES-GCM, key = TOKEN_KEY)
   ------------------------------------------------------------------ */
async function aesKey(env) {
  if (!env.TOKEN_KEY) { const e = new Error("TOKEN_KEY not configured"); e.status = 503; throw e; }
  return crypto.subtle.importKey("raw", unb64(env.TOKEN_KEY), "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function seal(env, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(env), new TextEncoder().encode(text)));
  return b64(iv) + "." + b64(ct);
}
async function open(env, sealed) {
  const [iv, ct] = sealed.split(".").map(unb64);
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, await aesKey(env), ct));
}
const getSetting = async (env, k) => (await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(k).first())?.value ?? null;
const setSetting = (env, k, v) => env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(k, v).run();

async function spotifyRefresh(env, refreshToken) {
  if (!env.SPOTIFY_CLIENT_ID) throw new Error("SPOTIFY_CLIENT_ID not configured");
  const r = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: env.SPOTIFY_CLIENT_ID }),
  });
  if (!r.ok) { const e = new Error(`Spotify refresh ${r.status}: ${(await r.text()).slice(0, 200)}`); e.status = 502; throw e; }
  const t = await r.json();
  // Spotify rotates refresh tokens for PKCE apps; keep whichever one is now valid
  await setSetting(env, "spotify_refresh", await seal(env, t.refresh_token || refreshToken));
  await setSetting(env, "spotify_access", JSON.stringify({ token: t.access_token, expires: Date.now() + (t.expires_in - 60) * 1000 }));
  return { access_token: t.access_token, expires_in: t.expires_in };
}

async function currentToken(env) {
  const cached = JSON.parse(await getSetting(env, "spotify_access") || "null");
  if (cached && cached.expires - Date.now() > 120000) return { access_token: cached.token, expires_in: Math.floor((cached.expires - Date.now()) / 1000) };
  const sealed = await getSetting(env, "spotify_refresh");
  if (!sealed) { const e = new Error("not linked"); e.status = 409; throw e; }
  return spotifyRefresh(env, await open(env, sealed));
}

async function link(body, env) {
  const refresh = str(body.refresh_token, 600);
  if (!refresh) throw bad("refresh_token required");
  const tok = await spotifyRefresh(env, refresh);           // proves the token is real before issuing a key
  const key = b64(crypto.getRandomValues(new Uint8Array(32))).replace(/[^A-Za-z0-9]/g, "").slice(0, 40);
  await env.DB.prepare("INSERT INTO devices (key_hash, label) VALUES (?, ?)").bind(await sha256(key), str(body.label, 80) || null).run();
  return { ok: true, device_key: key, access_token: tok.access_token, expires_in: tok.expires_in };
}
async function unlink(env) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM settings WHERE key IN ('spotify_refresh','spotify_access')"),
    env.DB.prepare("DELETE FROM devices"),
  ]);
  return { ok: true };
}

/* ------------------------------------------------------------------
   Hourly sync: pull the last 50 plays into the diary without a browser
   ------------------------------------------------------------------ */
async function syncPlays(env) {
  const sealed = await getSetting(env, "spotify_refresh");
  if (!sealed) return;
  try {
    const { access_token } = await currentToken(env);
    const r = await fetch("https://api.spotify.com/v1/me/player/recently-played?limit=50", { headers: { Authorization: "Bearer " + access_token } });
    if (!r.ok) throw new Error("recently-played " + r.status);
    const d = await r.json();
    const items = (d.items || []).filter(i => i.track && i.played_at).map(i => ({
      played_at: i.played_at, track_id: i.track.id, track_name: i.track.name,
      artist_id: i.track.artists?.[0]?.id, artist_name: i.track.artists?.[0]?.name,
      album_name: i.track.album?.name, release_date: i.track.album?.release_date,
      duration_ms: i.track.duration_ms, image_url: i.track.album?.images?.[2]?.url || i.track.album?.images?.[0]?.url || "",
    }));
    const res = await savePlays({ items }, env);
    await setSetting(env, "last_sync", JSON.stringify({ at: new Date().toISOString(), added: res.added, ok: true }));
  } catch (e) {
    console.error("sync", e);
    await setSetting(env, "last_sync", JSON.stringify({ at: new Date().toISOString(), ok: false, error: String(e.message || e).slice(0, 200) }));
  }
}

/* ------------------------------------------------------------------
   Claude call ceiling: a backstop against runaway spend
   ------------------------------------------------------------------ */
async function claudeBudget(env, kind) {
  const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM api_calls WHERE at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour')").first();
  if (n >= CLAUDE_CALLS_PER_HOUR) { const e = new Error("hourly Claude call limit reached; try again later"); e.status = 429; throw e; }
  await env.DB.prepare("INSERT INTO api_calls (kind) VALUES (?)").bind(kind).run();
}

/* ------------------------------------------------------------------
   /feedback
   ------------------------------------------------------------------ */
async function saveFeedback(body, env) {
  const artist_name = str(body.artist_name);
  const verdict = body.verdict === "up" || body.verdict === "down" ? body.verdict : null;
  if (!artist_name || !verdict) throw bad("artist_name and verdict required");
  const mood = MOODS.includes(body.mood) ? body.mood : null;
  const genres = JSON.stringify(Array.isArray(body.genres) ? body.genres.slice(0, 5).map(g => str(g, 60)) : []);
  const tags = Array.isArray(body.tags) ? [...new Set(body.tags.map(t => str(t, 60)).filter(Boolean))].slice(0, 8) : [];

  const ins = await env.DB.prepare(
    "INSERT INTO feedback (artist_name, spotify_id, verdict, mood, genres) VALUES (?, ?, ?, ?, ?)"
  ).bind(artist_name, str(body.spotify_id, 64) || null, verdict, mood, genres).run();
  const id = ins.meta.last_row_id;

  if (tags.length) {
    const stmt = env.DB.prepare("INSERT OR IGNORE INTO feedback_tags (feedback_id, tag) VALUES (?, ?)");
    await env.DB.batch(tags.map(t => stmt.bind(id, t)));
  }
  await env.DB.prepare("UPDATE recommendation_log SET status = 'rated' WHERE status = 'active' AND lower(artist_name) = lower(?)").bind(artist_name).run();
  return { ok: true, id };
}

/* ------------------------------------------------------------------
   /shown
   ------------------------------------------------------------------ */
async function logShown(body, env) {
  const items = Array.isArray(body.items) ? body.items.slice(0, 24) : [];
  if (!items.length) return { ok: true, logged: 0 };
  const stmt = env.DB.prepare("INSERT INTO recommendation_log (artist_name, spotify_id, reason, mood, status, image_url, spotify_url, genres) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)");
  await env.DB.batch(items.filter(i => str(i.artist_name)).map(i =>
    stmt.bind(str(i.artist_name), str(i.spotify_id, 64) || null, str(i.reason, 400) || null, MOODS.includes(i.mood) ? i.mood : null,
      str(i.image_url, 500) || null, str(i.spotify_url, 200) || null, JSON.stringify(Array.isArray(i.genres) ? i.genres.slice(0, 3).map(g => str(g, 60)) : []))
  ));
  return { ok: true, logged: items.length };
}

/* ------------------------------------------------------------------
   /photo: one Unsplash photograph for a slot, random each call
   ------------------------------------------------------------------ */
const PHOTO_QUERIES = {
  melancholic: ["overcast coastline", "rain on window", "grey sea fog", "empty beach winter"],
  euphoric:    ["golden hour backlight", "summer light flare", "sun through trees", "warm sunset field"],
  restless:    ["night city motion blur", "neon rain street", "long exposure traffic night", "city lights bokeh"],
  serene:      ["soft daylight interior", "linen curtain window light", "still lake morning", "minimal calm room"],
  driving:     ["highway night long exposure", "tunnel light trails", "desert road dusk", "car taillights night"],
  hazy:        ["foggy field", "misty forest", "faded landscape haze", "morning mist meadow"],
  login:       ["empty concert hall", "vinyl record close up", "dim stage lights", "record player dark"],
  profile:     ["analog mixing console", "reel to reel tape", "recording studio dark", "synthesizer close up"],
  loading:     ["light leak abstract", "bokeh out of focus", "abstract blur warm"],
  diary:       ["morning light window", "headphones on desk", "city at dawn", "late night window light"],
  history:     ["record shelf", "archive boxes dim light", "old photographs table", "vinyl crates record store"],
};
async function getPhoto(slot, env) {
  if (!env.UNSPLASH_ACCESS_KEY) return { ok: false, reason: "no key" };
  const list = PHOTO_QUERIES[slot] || PHOTO_QUERIES.serene;
  const query = list[Math.floor(Math.random() * list.length)];
  const u = new URL("https://api.unsplash.com/photos/random");
  u.searchParams.set("query", query);
  u.searchParams.set("orientation", "landscape");
  u.searchParams.set("content_filter", "high");
  const r = await fetch(u, { headers: { Authorization: "Client-ID " + env.UNSPLASH_ACCESS_KEY, "Accept-Version": "v1" } });
  if (!r.ok) return { ok: false, reason: "unsplash " + r.status };
  const d = await r.json();
  // Unsplash guidelines: trigger the download endpoint when a photo is used, and credit the photographer
  if (d.links?.download_location) fetch(d.links.download_location, { headers: { Authorization: "Client-ID " + env.UNSPLASH_ACCESS_KEY } }).catch(() => {});
  const utm = "?utm_source=music_discovery&utm_medium=referral";
  return {
    ok: true, slot, query,
    url: d.urls.raw + "&w=2000&q=80&fm=jpg&fit=max",
    color: d.color || null,
    photographer: d.user?.name || "Unknown",
    photographerUrl: (d.user?.links?.html || "https://unsplash.com") + utm,
    photoUrl: (d.links?.html || "https://unsplash.com") + utm,
  };
}

/* ------------------------------------------------------------------
   /plays: the listening diary. Spotify only exposes the last 50 plays,
   so every open copies them here; played_at is the key, duplicates ignored.
   ------------------------------------------------------------------ */
async function savePlays(body, env) {
  const items = Array.isArray(body.items) ? body.items.slice(0, 50) : [];
  const valid = items.filter(i => str(i.played_at, 40) && str(i.track_name));
  if (!valid.length) return { ok: true, added: 0 };
  const stmt = env.DB.prepare(`INSERT OR IGNORE INTO plays
    (played_at, track_id, track_name, artist_id, artist_name, album_name, release_date, duration_ms, image_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const res = await env.DB.batch(valid.map(i => stmt.bind(
    str(i.played_at, 40), str(i.track_id, 64) || null, str(i.track_name), str(i.artist_id, 64) || null, str(i.artist_name) || "Unknown",
    str(i.album_name) || null, str(i.release_date, 20) || null, Number.isFinite(i.duration_ms) ? Math.round(i.duration_ms) : null, str(i.image_url, 500) || null)));
  const added = res.reduce((n, r) => n + (r.meta?.changes || 0), 0);
  const first = await env.DB.prepare("SELECT MIN(played_at) AS first, COUNT(*) AS total FROM plays").first();
  return { ok: true, added, total: first.total, since: first.first };
}
async function getPlays(url, env) {
  const since = str(url.searchParams.get("since"), 40) || "1970-01-01";
  const { results } = await env.DB.prepare(`SELECT played_at, track_id, track_name, artist_id, artist_name, album_name, release_date, duration_ms, image_url
    FROM plays WHERE played_at >= ? ORDER BY played_at DESC LIMIT 20000`).bind(since).all();
  const meta = await env.DB.prepare("SELECT MIN(played_at) AS first, COUNT(*) AS total FROM plays").first();
  const linked = !!(await getSetting(env, "spotify_refresh"));
  const lastSync = JSON.parse(await getSetting(env, "last_sync") || "null");
  return { items: results, total: meta.total, since: meta.first, linked, lastSync };
}

/* ------------------------------------------------------------------
   /genres: Spotify's artist genres are being emptied out, so each artist
   is labelled once by a small Claude model and the labels are stored.
   ------------------------------------------------------------------ */
async function getGenres(body, env) {
  const artists = (Array.isArray(body.artists) ? body.artists : [])
    .map(a => ({ id: str(a.id, 64), name: str(a.name, 120) })).filter(a => a.id && a.name).slice(0, 200);
  if (!artists.length) return { genres: {} };
  const out = {};
  // read cache in chunks (SQLite parameter limit)
  for (let i = 0; i < artists.length; i += 90) {
    const chunk = artists.slice(i, i + 90);
    const { results } = await env.DB.prepare(`SELECT artist_id, genres FROM artist_genres WHERE artist_id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk.map(a => a.id)).all();
    results.forEach(r => out[r.artist_id] = safeJson(r.genres, []));
  }
  const missing = artists.filter(a => !out[a.id]);
  let labelled = 0;
  if (missing.length && env.ANTHROPIC_API_KEY) {
    const { results: vocab } = await env.DB.prepare(`SELECT value AS g, COUNT(*) AS n FROM artist_genres, json_each(artist_genres.genres) GROUP BY value ORDER BY n DESC LIMIT 80`).all();
    for (let i = 0; i < missing.length; i += 60) {
      const batch = missing.slice(i, i + 60);
      let labels = {};
      try { labels = await labelGenres(batch, vocab.map(v => v.g), env); } catch (e) { console.error("genre labelling", e); break; }
      const stmt = env.DB.prepare("INSERT OR REPLACE INTO artist_genres (artist_id, artist_name, genres) VALUES (?, ?, ?)");
      const writes = [];
      batch.forEach((a, idx) => {
        const g = labels[String(idx + 1)] || labels[a.name];
        if (Array.isArray(g) && g.length) {
          const clean = [...new Set(g.map(x => String(x).toLowerCase().trim()).filter(Boolean))].slice(0, 3);
          out[a.id] = clean; writes.push(stmt.bind(a.id, a.name, JSON.stringify(clean))); labelled++;
        }
      });
      if (writes.length) await env.DB.batch(writes);
    }
  }
  return { genres: out, labelled };
}

async function labelGenres(batch, vocab, env) {
  await claudeBudget(env, "genres");
  const list = batch.map((a, i) => `${i + 1}. ${a.name}`).join("\n");
  const prompt = `Assign music genres to each artist below.

Rules:
- Give 1 to 3 genres per artist, most defining first.
- Lowercase, the way a well-read record store would shelve them: specific enough to mean something ("indie folk", "city pop", "mandopop", "spiritual jazz", "math rock"), never vague ("music", "pop music", "various").
- Reuse names from this existing vocabulary whenever one fits, so the same sound always gets the same name: ${vocab.length ? vocab.join(", ") : "(empty so far)"}.
- If two artists share a name, choose the most widely known one.
- If you genuinely do not know an artist, give your best guess from the name and context of the list rather than leaving it empty.

Artists:
${list}

Respond with only a JSON object mapping each number to its array of genres, for example {"1": ["indie folk", "chamber pop"], "2": ["ambient"]}. No other text.`;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: env.GENRE_MODEL || "claude-haiku-5-5", max_tokens: 3000, messages: [{ role: "user", content: prompt }] }),
  });
  if (!r.ok) throw new Error(`Claude API ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data = await r.json();
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  const m = text.match(/\{[\s\S]*\}/);
  return m ? JSON.parse(m[0]) : {};
}

/* ------------------------------------------------------------------
   /shelf: the persistent set of unrated recommendations
   ------------------------------------------------------------------ */
async function getShelf(env) {
  const { results } = await env.DB.prepare(`
    SELECT id, artist_name, spotify_id, reason, mood, image_url, spotify_url, genres, shown_at
    FROM recommendation_log WHERE status = 'active' ORDER BY id ASC LIMIT 24`).all();
  return { items: results.map(r => ({
    name: r.artist_name, spotify_id: r.spotify_id, reason: r.reason, mood: r.mood,
    image: r.image_url || "", url: r.spotify_url || "", genres: safeJson(r.genres, []), shown_at: r.shown_at,
  })) };
}
async function clearShelf(env) {
  const r = await env.DB.prepare("UPDATE recommendation_log SET status = 'dismissed' WHERE status = 'active'").run();
  return { ok: true, dismissed: r.meta.changes };
}
function safeJson(v, d) { try { const x = JSON.parse(v); return x ?? d; } catch { return d; } }

/* ------------------------------------------------------------------
   /history
   ------------------------------------------------------------------ */
async function getHistory(env) {
  const { results: rated } = await env.DB.prepare(`
    SELECT f.id, f.artist_name, f.verdict, f.mood, f.created_at,
           (SELECT group_concat(tag, '|') FROM feedback_tags t WHERE t.feedback_id = f.id) AS tags
    FROM feedback f ORDER BY f.created_at DESC LIMIT 500`).all();
  const ratedNames = new Set(rated.map(r => r.artist_name.toLowerCase()));

  const { results: shown } = await env.DB.prepare(`
    SELECT artist_name, mood, MAX(shown_at) AS shown_at
    FROM recommendation_log GROUP BY artist_name ORDER BY shown_at DESC LIMIT 500`).all();

  const items = [
    ...rated.map(r => ({ artist_name: r.artist_name, verdict: r.verdict, mood: r.mood, created_at: r.created_at, tags: r.tags ? r.tags.split("|") : [] })),
    ...shown.filter(s => !ratedNames.has(s.artist_name.toLowerCase()))
            .map(s => ({ artist_name: s.artist_name, verdict: null, mood: s.mood, created_at: s.shown_at, tags: [] })),
  ].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return { items };
}

/* ------------------------------------------------------------------
   /recommend
   ------------------------------------------------------------------ */
async function recommend(body, env) {
  const p = body.profile;
  if (!p || !Array.isArray(p.topGenres)) throw bad("profile required");
  const count = Math.min(MAX_CANDIDATES, Math.max(8, Number(body.count) || 16));

  // Feedback memory: what was kept, what was passed and why, what was already shown
  const { results: fb } = await env.DB.prepare(`
    SELECT f.artist_name, f.verdict,
           (SELECT group_concat(tag, ', ') FROM feedback_tags t WHERE t.feedback_id = f.id) AS tags
    FROM feedback f ORDER BY f.created_at DESC LIMIT 120`).all();
  const kept = fb.filter(r => r.verdict === "up");
  const passed = fb.filter(r => r.verdict === "down");

  const { results: tagCounts } = await env.DB.prepare(`
    SELECT t.tag, COUNT(*) AS n FROM feedback_tags t
    JOIN feedback f ON f.id = t.feedback_id WHERE f.verdict = 'down'
    GROUP BY t.tag ORDER BY n DESC`).all();

  const { results: shownRows } = await env.DB.prepare(
    "SELECT DISTINCT artist_name FROM recommendation_log ORDER BY shown_at DESC LIMIT 300").all();

  const exclude = new Set([
    ...(p.libraryArtistNames || []).map(n => String(n).toLowerCase()),
    ...fb.map(r => r.artist_name.toLowerCase()),
    ...shownRows.map(r => r.artist_name.toLowerCase()),
  ]);

  const prompt = buildPrompt(p, { kept, passed, tagCounts, shownRows, count });
  const candidates = await askClaude(prompt, count, env);

  // Final server-side guard against repeats, then trim
  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    const key = c.name.toLowerCase();
    if (!key || seen.has(key) || exclude.has(key)) continue;
    seen.add(key);
    out.push({ name: c.name, reason: c.reason, mood: MOODS.includes(c.mood) ? c.mood : "serene", confidence: c.confidence ?? 0.5 });
  }
  return { candidates: out, model: env.CLAUDE_MODEL || "claude-sonnet-5-5" };
}

function buildPrompt(p, ctx) {
  const list = (arr, f) => arr.length ? arr.map(f).join("\n") : "(none yet)";
  const genres = p.topGenres.slice(0, 15).map(g => `${g.genre} (${g.weight})`).join(", ");
  const eras = Object.entries(p.eraDistribution || {}).map(([d, w]) => `${d} ${Math.round(w * 100)}%`).join(", ");
  const anchors = (p.anchorArtists || []).slice(0, 12).join(", ");
  const emerging = (p.trendSignal?.emerging || []).slice(0, 8).join(", ") || "(none)";
  const fading = (p.trendSignal?.fading || []).slice(0, 8).join(", ") || "(none)";
  const rejectionPattern = ctx.tagCounts.length
    ? ctx.tagCounts.map(t => `${t.tag}: ${t.n}`).join(", ")
    : "(no rejections yet)";

  return `You are a music curator with deep, catholic knowledge of recorded music across eras and scenes, writing for one listener who wants to discover artists they do not yet know. They are new to exploring new music, so each pick must be a real door into somewhere, not a trivia answer.

LISTENER PROFILE
Genre weights (1.0 = strongest): ${genres}
Era distribution of what they play: ${eras || "unknown"}
Anchor artists (what everything orbits): ${anchors || "unknown"}
Rising lately: ${emerging}
Fading lately: ${fading}

FEEDBACK MEMORY
Kept (they liked these recommendations):
${list(ctx.kept.slice(0, 40), r => `- ${r.artist_name}${r.tags ? ` [${r.tags}]` : ""}`)}

Passed (rejected, with reasons):
${list(ctx.passed.slice(0, 40), r => `- ${r.artist_name}${r.tags ? ` [${r.tags}]` : ""}`)}

Rejection pattern (tag counts): ${rejectionPattern}

RULES
1. Return exactly ${ctx.count} artists the listener almost certainly does not know. Never return anchor artists, kept artists, passed artists, or anything in the listener's library.
2. Avoid the obvious adjacent names everyone lists next to the anchors. Favor artists one or two steps removed: a scene the anchors came from, a producer's other project, a regional parallel, an earlier generation that the anchors drew from, or a current artist carrying the same sensibility into a different form.
3. Treat the rejection pattern as hard constraints. If "too mainstream" dominates, go deeper and more obscure. If "wrong energy" dominates, match the anchors' intensity more carefully. If "not my era" dominates, stay inside the era distribution.
4. Treat kept artists as the strongest positive signal; find more in their direction, but do not cluster all picks around one of them.
5. Spread picks across at least three of the listener's top genres, and spread moods so no single mood exceeds half the batch.
6. Each artist must be findable on Spotify by the exact name you give. Use the canonical artist name, with no album names or descriptors.
7. The reason is one sentence, specific, second person, naming the concrete link to something the listener already loves. No marketing language.
8. Mood is one of: ${MOODS.join(", ")}. Choose the mood a first-time listener would feel from this artist's most representative work.
9. Confidence from 0 to 1 is your estimate that this listener keeps the recommendation.`;
}

async function askClaude(prompt, count, env) {
  if (!env.ANTHROPIC_API_KEY) { const e = new Error("ANTHROPIC_API_KEY not configured"); e.status = 500; throw e; }
  await claudeBudget(env, "recommend");
  const tool = {
    name: "recommend_artists",
    description: "Return the recommended artists for this listener.",
    input_schema: {
      type: "object",
      properties: {
        artists: {
          type: "array", minItems: count, maxItems: count,
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              reason: { type: "string" },
              mood: { type: "string", enum: MOODS },
              confidence: { type: "number", minimum: 0, maximum: 1 },
            },
            required: ["name", "reason", "mood", "confidence"],
          },
        },
      },
      required: ["artists"],
    },
  };

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: env.CLAUDE_MODEL || "claude-sonnet-5-5",
      max_tokens: 4000,
      tools: [tool],
      tool_choice: { type: "auto" },
      system: "You must respond by calling the recommend_artists tool exactly once with the full list. Do not answer in prose.",
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!r.ok) {
    const text = await r.text();
    const e = new Error(`Claude API ${r.status}: ${text.slice(0, 300)}`); e.status = 502; throw e;
  }
  const data = await r.json();
  const block = (data.content || []).find(b => b.type === "tool_use" && b.name === "recommend_artists");
  let artists = block?.input?.artists;
  if (!Array.isArray(artists)) {
    // Fallback: the model answered in text; pull the first JSON object or array out of it
    const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
    const m = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    try { const parsed = m ? JSON.parse(m[0]) : null; artists = Array.isArray(parsed) ? parsed : parsed?.artists; } catch { artists = null; }
  }
  if (!Array.isArray(artists)) { const e = new Error("Claude returned no structured output"); e.status = 502; throw e; }
  return artists.map(a => ({ name: str(a.name, 120).trim(), reason: str(a.reason, 400).trim(), mood: a.mood, confidence: Number(a.confidence) }))
                .filter(a => a.name);
}
