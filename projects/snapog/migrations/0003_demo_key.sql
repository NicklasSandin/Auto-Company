-- SnapOG D1 Schema
-- Migration 0003: dedicated public demo key for the homepage hero preview
--
-- The landing page's own "live preview" <img> hits /og directly, and /og
-- unconditionally requires a `key` param (see docs/qa/cycle5-hardening.md
-- Bug 3). Rather than special-casing auth for one hardcoded marketing URL,
-- mint a real, ordinary api_keys row for it — same code path as every
-- other key, just with a generous monthly_limit since its quota is shared
-- across every anonymous visitor to the homepage (deliberately public; the
-- raw key below is embedded directly in landingPage()'s HTML).
--
-- Raw key: sk_demo_public_landing_preview_2026_do_not_use_for_real_traffic
-- (sha256 hex of the raw key, computed offline — this is the only place it
-- needs to be verifiable against)

INSERT OR IGNORE INTO users (id, email)
VALUES ('e4044038-ac19-4cd2-9519-a06c2818bb5f', 'demo-landing-page@snapog.dev');

INSERT OR IGNORE INTO api_keys
  (id, user_id, name, key_prefix, key_hash, tier, monthly_limit, usage_reset_at)
VALUES (
  'f1380b7c-f0aa-4fd4-bc35-f7192c3d3db8',
  'e4044038-ac19-4cd2-9519-a06c2818bb5f',
  'landing-page-demo',
  'sk_demo_publ',
  '0048e3f649ce15570418652dd0778c28905423c647e55fc9abb8cc33c6a13a12',
  'free',
  50000,
  '2026-01-01T00:00:00.000Z'
);
