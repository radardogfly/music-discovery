/**
 * Resonance API: Cloudflare Worker for music-discovery
 *
 * Routes
 *   POST /recommend   taste profile in, Claude-ranked artist candidates out
 *   POST /feedback    store a Keep/Pass verdict with tags
 *   POST /shown       log a batch that was rendered, to avoid repeats
 *   GET  /history     everything rated and shown, newest first
 *   GET  /health      liveness
 *
 * Bindings
 *   env.DB                 D1 database (music-discovery-db)
 *   env.ANTHROPIC_API_KEY  secret
 *   env.ALLOWED_ORIGIN     the GitHub Pages origin, for CORS
 *   env.CLAUDE_MODEL       model id, defaults to claude-sonnet-5-5
 */

const MOODS = ["melancholic", "euphoric", "restless", "serene", "driving", "hazy"];
const MAX_CANDIDATES = 24;

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (origin && !isAllowed(origin, env)) return json({ error: "origin not allowed" }, 403, cors);

    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/health") return json({ ok: true }, 200, cors);
      if (request.method === "GET" && url.pathname === "/diag") return json(await diag(env), 200, cors);
      if (request.method === "GET" && url.pathname === "/diag/recommend") {
        const sample = { topGenres: [{ genre: "indie folk", weight: 1 }, { genre: "ambient", weight: 0.6 }, { genre: "jazz", weight: 0.4 }],
          anchorArtists: ["Bon Iver", "Nils Frahm", "Alice Coltrane"], eraDistribution: { "2010s": 0.6, "1970s": 0.4 },
          libraryArtistIds: [], libraryArtistNames: ["Bon Iver", "Nils Frahm", "Alice Coltrane"], trendSignal: {} };
        try { const r = await recommend({ profile: sample, count: 8 }, env); return json({ ok: true, returned: r.candidates.length, sample: r.candidates.slice(0, 3) }, 200, cors); }
        catch (e) { return json({ ok: false, status: e.status || 500, error: e.message }, 200, cors); }
      }
      if (request.method === "GET" && url.pathname === "/history") return json(await getHistory(env), 200, cors);
      if (request.method === "GET" && url.pathname === "/shelf") return json(await getShelf(env), 200, cors);
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
   /diag: configuration and upstream check, no user data involved
   ------------------------------------------------------------------ */
async function diag(env) {
  const out = { hasKey: !!env.ANTHROPIC_API_KEY, hasDb: !!env.DB, model: env.CLAUDE_MODEL || "claude-sonnet-5-5", allowedOrigin: env.ALLOWED_ORIGIN || null };
  try { const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM feedback").first(); out.db = "ok, feedback rows: " + r.n; } catch (e) { out.db = "error: " + e.message; }
  if (env.ANTHROPIC_API_KEY) {
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: out.model, max_tokens: 5, messages: [{ role: "user", content: "Say ok." }] }),
      });
      out.claude = r.ok ? "ok" : `error ${r.status}: ${(await r.text()).slice(0, 300)}`;
    } catch (e) { out.claude = "fetch failed: " + e.message; }
  }
  return out;
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
