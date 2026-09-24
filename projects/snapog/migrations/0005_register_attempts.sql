-- SnapOG D1 Schema
-- Migration 0005: per-IP throttle bucket for POST /register
--
-- Separate from api_keys' own usage_count/monthly_limit (which throttles
-- calls to /og per API key) — this throttles calls to /register itself, per
-- source IP, before any user/key row is ever touched. Closes the "50
-- sequential registrations against distinct emails in ~1 second" vector
-- from docs/qa/cycle6-register-adversarial.md. Reuses the same
-- ensure-row-then-atomic-conditional-UPDATE shape as tryConsumeQuota in
-- src/index.ts, bucketed into fixed one-hour windows (window_start) rather
-- than a sliding window, to keep the check a single indexed row lookup.

CREATE TABLE IF NOT EXISTS register_attempts (
  ip            TEXT NOT NULL,
  window_start  TEXT NOT NULL,   -- ISO timestamp of the top of the hour
  count         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip, window_start)
);
