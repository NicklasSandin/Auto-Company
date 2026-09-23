-- SnapOG D1 Schema
-- Migration 0002: interest capture for Pro/Business (no live payment processor yet)
--
-- Public self-service registration only ever grants the free tier (see
-- POST /register in src/index.ts). When someone asks for Pro/Business we
-- record interest here instead of minting a paid key.

CREATE TABLE IF NOT EXISTS tier_requests (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  tier        TEXT NOT NULL,   -- pro | business
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_tier_requests_user ON tier_requests(user_id);
