// SnapOG — Main Cloudflare Worker
// Routes: GET /og (image gen), GET / (landing), GET/POST /register, GET /dashboard

import { Hono } from 'hono';
import { generateOGImage, buildCacheKey } from './og/render';
import {
  landingPage,
  registerPage,
  keyCreatedPage,
  interestCapturedPage,
  dashboardPage,
  errorPage,
} from './dashboard/pages';
import type { ApiKey, Env, OGParams } from './types';
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

  // ── R2 cache lookup ──
  const cached = await c.env.OG_CACHE.get(r2Key);
  if (cached) {
    // Cache hit — quota was already consumed atomically above; just log the
    // event for the dashboard (best-effort, doesn't block the response).
    c.executionCtx.waitUntil(
      recordUsageEvent(c.env.DB, apiKey, params.template ?? 'default', true)
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
    })
  );

  // Log the event for the dashboard (best-effort; quota was already
  // consumed atomically above, before the render even started)
  c.executionCtx.waitUntil(
    recordUsageEvent(c.env.DB, apiKey, params.template ?? 'default', false)
  );

  return new Response(imageBuffer, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=86400, s-maxage=604800',
      'X-Cache': 'MISS',
      'X-SnapOG-Tier': apiKey.tier,
    },
  });
});

// ── Registration ──────────────────────────────────────────────────────────────
app.get('/register', c => {
  const tier = c.req.query('tier');
  return htmlResponse(registerPage(undefined, tier));
});

app.post('/register', async c => {
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

  await c.env.DB
    .prepare(
      `INSERT INTO api_keys
         (id, user_id, name, key_prefix, key_hash, tier, monthly_limit, usage_reset_at)
       VALUES (?, ?, ?, ?, ?, 'free', ?, ?)`
    )
    .bind(keyId, user.id, keyname, keyPrefix, keyHash, TIER_LIMITS.free, resetAt)
    .run();

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

// 404 fallback
app.notFound(_c => htmlResponse(errorPage(404, 'Page not found'), 404));
app.onError((err, _c) => {
  console.error('Unhandled error:', err);
  return htmlResponse(errorPage(500, 'Internal server error'), 500);
});

export default app;
