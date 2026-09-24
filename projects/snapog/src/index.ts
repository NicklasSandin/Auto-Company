// SnapOG — Main Cloudflare Worker
// Routes: GET /og (image gen), GET / (landing), GET/POST /register, GET /dashboard

import { Hono } from 'hono';
import { generateOGImage, buildCacheKey } from './og/render';
import {
  landingPage,
  registerPage,
  keyCreatedPage,
  interestCapturedPage,
  alreadyRegisteredPage,
  dashboardPage,
  tierRequestsAdminPage,
  errorPage,
} from './dashboard/pages';
import type { ApiKey, Env, OGParams, TierRequestRow } from './types';
import { TIER_LIMITS } from './types';

const app = new Hono<{ Bindings: Env }>();

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text)
  );
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function generateRawKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return 'sk_' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

// Constant-time string comparison for the admin token check below — a plain
// `===` short-circuits on the first mismatched byte, which leaks how many
// leading characters of the secret a guess got right via response timing.
// Length is checked first (this itself isn't secret — it doesn't reveal
// character content), then every byte pair is XORed and OR-accumulated so
// the loop always runs the full length regardless of where the mismatch is.
function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) {
    diff |= aBytes[i] ^ bBytes[i];
  }
  return diff === 0;
}

// Validate an API key from request and return the DB row, or null
async function resolveApiKey(
  db: D1Database,
  rawKey: string | null
): Promise<ApiKey | null> {
  if (!rawKey) return null;
  const hash = await sha256(rawKey);
  const row = await db
    .prepare('SELECT * FROM api_keys WHERE key_hash = ?')
    .bind(hash)
    .first<ApiKey>();
  return row ?? null;
}

// Reset monthly usage if billing month rolled over
async function maybeResetUsage(db: D1Database, key: ApiKey): Promise<ApiKey> {
  const resetAt = new Date(key.usage_reset_at);
  const now = new Date();
  const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  if (resetAt < thisMonth) {
    const newResetAt = thisMonth.toISOString();
    await db
      .prepare(
        'UPDATE api_keys SET usage_count = 0, usage_reset_at = ? WHERE id = ?'
      )
      .bind(newResetAt, key.id)
      .run();
    return { ...key, usage_count: 0, usage_reset_at: newResetAt };
  }
  return key;
}

// Atomically check-and-consume one unit of quota. The check
// (usage_count < monthly_limit) and the increment happen as a single
// conditional UPDATE, so two concurrent requests on the same key can't both
// read a stale pre-increment usage_count and both pass — only one of them
// can flip a key from e.g. usage_count=99 to 100 when monthly_limit=100;
// the other affects 0 rows and is rejected. This must run in the main
// request path, before the cache lookup and before the expensive Satori
// render, so a request that's going to be rejected never pays render cost.
// See docs/qa/cycle5-hardening.md Bug 1.
async function tryConsumeQuota(db: D1Database, key: ApiKey): Promise<boolean> {
  const result = await db
    .prepare(
      'UPDATE api_keys SET usage_count = usage_count + 1 WHERE id = ? AND usage_count < monthly_limit'
    )
    .bind(key.id)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

// If the R2 cache lookup, the Satori render, or anything else downstream of
// tryConsumeQuota throws, the caller has already paid one unit of quota for
// nothing — refund it so a transient R2/D1 hiccup or a render edge case
// doesn't permanently cost a (possibly paid) customer an image credit.
async function refundQuota(db: D1Database, key: ApiKey): Promise<void> {
  await db
    .prepare('UPDATE api_keys SET usage_count = usage_count - 1 WHERE id = ? AND usage_count > 0')
    .bind(key.id)
    .run();
}

// Per-IP throttle on POST /register itself — separate from the per-key /og
// quota above. Fixed one-hour buckets keyed by (ip, window_start); ensure
// the bucket row exists, then atomically check-and-increment it with the
// same conditional-UPDATE shape as tryConsumeQuota, so two concurrent
// registrations from the same IP can't both read a stale pre-increment
// count and both pass. See docs/qa/cycle6-register-adversarial.md.
const REGISTER_ATTEMPTS_PER_HOUR = 10;

function currentHourWindow(): string {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours())
  ).toISOString();
}

async function tryConsumeRegisterAttempt(db: D1Database, ip: string): Promise<boolean> {
  const windowStart = currentHourWindow();

  await db
    .prepare(
      'INSERT INTO register_attempts (ip, window_start, count) VALUES (?, ?, 0) ON CONFLICT(ip, window_start) DO NOTHING'
    )
    .bind(ip, windowStart)
    .run();

  const result = await db
    .prepare(
      'UPDATE register_attempts SET count = count + 1 WHERE ip = ? AND window_start = ? AND count < ?'
    )
    .bind(ip, windowStart, REGISTER_ATTEMPTS_PER_HOUR)
    .run();

  return (result.meta.changes ?? 0) > 0;
}

// Best-effort event log for the dashboard's "recent generations" list only —
// not billing-critical, safe to fire-and-forget via waitUntil. Quota
// accounting itself lives entirely in tryConsumeQuota above.
async function recordUsageEvent(
  db: D1Database,
  key: ApiKey,
  template: string,
  cacheHit: boolean
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO usage_events (id, api_key_id, template, cache_hit) VALUES (?, ?, ?, ?)'
    )
    .bind(crypto.randomUUID(), key.id, template, cacheHit ? 1 : 0)
    .run();
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Landing page
app.get('/', c => {
  const host = new URL(c.req.url).host;
  return htmlResponse(landingPage(host));
});

// Fixed marketing copy for the homepage's "live preview" image — kept out of
// OGParams-from-query-string entirely (see /demo-preview.png below).
const DEMO_PREVIEW_PARAMS: OGParams = {
  title: 'How to Build a Billion-Dollar API',
  description:
    'A deep dive into developer tools that compound — and the pricing that makes them survive',
  domain: 'myblog.dev',
  theme: 'dark',
  template: 'default',
};
const DEMO_PREVIEW_R2_KEY = 'og/landing-demo-preview.png';

// Static homepage preview image. Deliberately NOT the general /og route: it
// used to be a live /og?...&key=<public demo key> call, which meant (a) a
// long-lived credential sat in plaintext in page source, discoverable via
// view-source and usable directly against /og with arbitrary parameters —
// a fully public, unauthenticated render+store endpoint — and (b) every
// homepage view consumed one unit of that shared key's quota even on a
// cache hit, so organic traffic alone could exhaust it and break the
// homepage's own conversion-critical image. This route accepts no
// parameters, needs no API key, and never touches api_keys/quota — it only
// ever renders the one fixed marketing image, cached in R2 indefinitely.
// See docs/qa/cycle11-full-codebase-review.md Finding 1.
app.get('/demo-preview.png', async c => {
  const cached = await c.env.OG_CACHE.get(DEMO_PREVIEW_R2_KEY);
  if (cached) {
    const imageData = await cached.arrayBuffer();
    return new Response(imageData, {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=86400, s-maxage=604800',
        'X-Cache': 'HIT',
      },
    });
  }

  const imageResponse = await generateOGImage(DEMO_PREVIEW_PARAMS, false);
  const imageBuffer = await imageResponse.arrayBuffer();

  c.executionCtx.waitUntil(
    c.env.OG_CACHE.put(DEMO_PREVIEW_R2_KEY, imageBuffer.slice(0), {
      httpMetadata: { contentType: 'image/png' },
    }).catch(err => console.error('R2 demo-preview put failed:', err))
  );

  return new Response(imageBuffer, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=86400, s-maxage=604800',
      'X-Cache': 'MISS',
    },
  });
});

// ── OG image generation ────────────────────────────────────────────────────────
app.get('/og', async c => {
  const q = c.req.query();
  const rawKey = q['key'] ?? null;

  // Validate required param
  const title = (q['title'] ?? '').trim().slice(0, 120);
  if (!title) {
    return c.json({ error: 'title parameter is required' }, 400);
  }

  // Resolve API key (required)
  if (!rawKey) {
    return c.json({ error: 'key parameter is required. Get a free key at /register' }, 401);
  }
  let apiKey = await resolveApiKey(c.env.DB, rawKey);
  if (!apiKey) {
    return c.json({ error: 'Invalid API key' }, 401);
  }

  // Reset usage if month rolled
  apiKey = await maybeResetUsage(c.env.DB, apiKey);

  // Check-and-consume rate limit atomically, before any cache lookup or the
  // expensive render — see tryConsumeQuota for why this must be a single
  // conditional UPDATE rather than a read-then-later-write.
  const withinQuota = await tryConsumeQuota(c.env.DB, apiKey);
  if (!withinQuota) {
    return c.json(
      {
        error: 'Monthly image limit reached',
        tier: apiKey.tier,
        limit: apiKey.monthly_limit,
        upgrade_url: '/register?tier=pro',
      },
      429
    );
  }

  const params: OGParams = {
    title,
    description: (q['description'] ?? '').trim().slice(0, 200) || undefined,
    domain: (q['domain'] ?? '').trim().slice(0, 100) || undefined,
    author: (q['author'] ?? '').trim().slice(0, 80) || undefined,
    tag: (q['tag'] ?? '').trim().slice(0, 40) || undefined,
    theme: (q['theme'] === 'light' ? 'light' : 'dark') as 'dark' | 'light',
    template: (['blog', 'article'].includes(q['template'] ?? '')
      ? q['template']
      : 'default') as OGParams['template'],
  };

  const watermark = apiKey.tier === 'free';
  const cacheKey = await buildCacheKey(params, watermark);
  const r2Key = `og/${cacheKey}.png`;

  // Everything below spends the quota unit consumed above. If any of it
  // throws (R2 down, Satori render error on adversarial input, etc.), refund
  // the unit before propagating to app.onError — otherwise a transient
  // backend failure permanently costs the customer an image credit with
  // nothing delivered in return.
  try {
    // ── R2 cache lookup ──
    const cached = await c.env.OG_CACHE.get(r2Key);
    if (cached) {
      // Cache hit — quota was already consumed atomically above; just log
      // the event for the dashboard (best-effort, doesn't block the
      // response).
      c.executionCtx.waitUntil(
        recordUsageEvent(c.env.DB, apiKey, params.template ?? 'default', true).catch(err =>
          console.error('recordUsageEvent failed:', err)
        )
      );
      const imageData = await cached.arrayBuffer();
      return new Response(imageData, {
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=86400, s-maxage=604800',
          'X-Cache': 'HIT',
          'X-SnapOG-Tier': apiKey.tier,
        },
      });
    }

    // ── Generate image ──
    const imageResponse = await generateOGImage(params, watermark);
    const imageBuffer = await imageResponse.arrayBuffer();

    // Store in R2 (fire-and-forget, don't block response)
    c.executionCtx.waitUntil(
      c.env.OG_CACHE.put(r2Key, imageBuffer.slice(0), {
        httpMetadata: { contentType: 'image/png' },
        customMetadata: { tier: apiKey.tier, template: params.template ?? 'default' },
      }).catch(err => console.error('R2 cache put failed:', err))
    );

    // Log the event for the dashboard (best-effort; quota was already
    // consumed atomically above, before the render even started)
    c.executionCtx.waitUntil(
      recordUsageEvent(c.env.DB, apiKey, params.template ?? 'default', false).catch(err =>
        console.error('recordUsageEvent failed:', err)
      )
    );

    return new Response(imageBuffer, {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=86400, s-maxage=604800',
        'X-Cache': 'MISS',
        'X-SnapOG-Tier': apiKey.tier,
      },
    });
  } catch (err) {
    await refundQuota(c.env.DB, apiKey);
    throw err;
  }
});

// ── Registration ──────────────────────────────────────────────────────────────
app.get('/register', c => {
  const tier = c.req.query('tier');
  return htmlResponse(registerPage(undefined, tier));
});

app.post('/register', async c => {
  // Throttle registration attempts per source IP before touching the DB for
  // anything else — closes the "50 sequential registrations in ~1 second"
  // bulk-farming vector. Cloudflare's edge overwrites CF-Connecting-IP with
  // the real client IP (it can't be spoofed by the client in production);
  // X-Forwarded-For is only a local-dev fallback.
  const ip = c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For') ?? 'unknown';
  const withinRegisterLimit = await tryConsumeRegisterAttempt(c.env.DB, ip);
  if (!withinRegisterLimit) {
    return htmlResponse(
      registerPage('Too many registration attempts from your network. Please try again in an hour.'),
      429
    );
  }

  let email: string, keyname: string, requestedTier: string;
  try {
    const form = await c.req.formData();
    email = (form.get('email') as string ?? '').trim().toLowerCase();
    keyname = (form.get('keyname') as string ?? '').trim() || 'default';
    requestedTier = (form.get('tier') as string ?? 'free').trim();
  } catch {
    return htmlResponse(registerPage('Invalid form data'), 400);
  }

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return htmlResponse(registerPage('Please enter a valid email address', requestedTier), 400);
  }

  // Upsert user (needed for both free-key issuance and interest capture below)
  const userId = crypto.randomUUID();
  await c.env.DB
    .prepare(
      'INSERT INTO users (id, email) VALUES (?, ?) ON CONFLICT(email) DO NOTHING'
    )
    .bind(userId, email)
    .run();

  const user = await c.env.DB
    .prepare('SELECT id FROM users WHERE email = ?')
    .bind(email)
    .first<{ id: string }>();
  if (!user) {
    return htmlResponse(registerPage('Database error — please try again'), 500);
  }

  // SECURITY: public self-service registration must NEVER trust a
  // client-supplied tier to grant paid capacity — there is no payment check
  // here. Pro/Business aren't self-serve yet (no live payment processor),
  // so a request for either is recorded as interest, not fulfilled as a key.
  if (requestedTier === 'pro' || requestedTier === 'business') {
    await c.env.DB
      .prepare('INSERT INTO tier_requests (id, user_id, tier) VALUES (?, ?, ?)')
      .bind(crypto.randomUUID(), user.id, requestedTier)
      .run();
    return htmlResponse(interestCapturedPage(email, requestedTier));
  }

  // Every self-service key minted here is 'free' — full stop, regardless of
  // what the client sent.
  const rawKey = generateRawKey();
  const keyHash = await sha256(rawKey);
  const keyPrefix = rawKey.slice(0, 12);
  const keyId = crypto.randomUUID();
  const resetAt = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();

  // Idempotent per email: api_keys.user_id has a UNIQUE index (migration
  // 0004), so this INSERT is a no-op if this user already has a key —
  // whether from an earlier registration or a concurrent request that won
  // the race — instead of always minting a second, independent key. This
  // mirrors the atomic `ON CONFLICT DO NOTHING` shape already used for the
  // users upsert above. See docs/qa/cycle6-register-adversarial.md.
  const insertResult = await c.env.DB
    .prepare(
      `INSERT INTO api_keys
         (id, user_id, name, key_prefix, key_hash, tier, monthly_limit, usage_reset_at)
       VALUES (?, ?, ?, ?, ?, 'free', ?, ?)
       ON CONFLICT(user_id) DO NOTHING`
    )
    .bind(keyId, user.id, keyname, keyPrefix, keyHash, TIER_LIMITS.free, resetAt)
    .run();

  if ((insertResult.meta.changes ?? 0) === 0) {
    // This email already has a key. We only ever store its hash, never the
    // raw value, so it can't be redisplayed here — tell the user plainly
    // instead of minting an independent second key.
    const existing = await c.env.DB
      .prepare('SELECT tier FROM api_keys WHERE user_id = ?')
      .bind(user.id)
      .first<{ tier: string }>();
    return htmlResponse(alreadyRegisteredPage(email, existing?.tier ?? 'free'));
  }

  return htmlResponse(keyCreatedPage(rawKey, email, 'free'));
});

// ── Dashboard ─────────────────────────────────────────────────────────────────
app.get('/dashboard', async c => {
  const rawKey = c.req.query('key');
  if (!rawKey) {
    return htmlResponse(registerPage('Enter your API key or create a new one below'), 400);
  }

  const apiKey = await resolveApiKey(c.env.DB, rawKey);
  if (!apiKey) {
    return htmlResponse(errorPage(404, 'API key not found'), 404);
  }

  const refreshed = await maybeResetUsage(c.env.DB, apiKey);

  // Count recent events (last 24h)
  const yesterday = new Date(Date.now() - 86_400_000).toISOString();
  const recent = await c.env.DB
    .prepare(
      'SELECT COUNT(*) as cnt FROM usage_events WHERE api_key_id = ? AND generated_at > ?'
    )
    .bind(refreshed.id, yesterday)
    .first<{ cnt: number }>();

  return htmlResponse(dashboardPage(refreshed, recent?.cnt ?? 0));
});

// ── Health / ops ──────────────────────────────────────────────────────────────
app.get('/health', c => c.json({ ok: true, ts: new Date().toISOString() }));

// Internal admin view — the warmest leads SnapOG has (people who explicitly
// asked for Pro/Business) land in tier_requests via POST /register but
// nothing ever read them back out. This is that read path.
//
// Auth: repurposes the previously-unused AUTH_SECRET binding (see
// src/types.ts, wrangler.toml) as a shared admin token instead of building a
// login system for a solo-operator app. Checked via ?token= against
// c.env.AUTH_SECRET with a constant-time comparison (see timingSafeEqual
// above). Missing/empty AUTH_SECRET fails CLOSED (this route 404s rather
// than ever falling open), and a wrong/missing token gets the same 404 as a
// misconfigured secret or a nonexistent route — this endpoint doesn't
// distinguish "not authorized" from "doesn't exist" in its response.
// See docs/fullstack/cycle8-tier-requests-admin-view.md.
app.get('/admin/tier-requests', async c => {
  const secret = c.env.AUTH_SECRET;
  if (!secret) {
    return htmlResponse(errorPage(404, 'Page not found'), 404);
  }

  const token = c.req.query('token') ?? '';
  if (!token || !timingSafeEqual(token, secret)) {
    return htmlResponse(errorPage(404, 'Page not found'), 404);
  }

  const rows = await c.env.DB
    .prepare(
      `SELECT tier_requests.id AS id,
              tier_requests.tier AS tier,
              tier_requests.created_at AS created_at,
              users.email AS email
         FROM tier_requests
         JOIN users ON users.id = tier_requests.user_id
        ORDER BY tier_requests.created_at DESC`
    )
    .all<TierRequestRow>();

  return htmlResponse(tierRequestsAdminPage(rows.results ?? []));
});

// 404 fallback
app.notFound(_c => htmlResponse(errorPage(404, 'Page not found'), 404));
app.onError((err, _c) => {
  console.error('Unhandled error:', err);
  return htmlResponse(errorPage(500, 'Internal server error'), 500);
});

export default app;
