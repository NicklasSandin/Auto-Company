-- SnapOG D1 Schema
-- Migration 0006: revoke the public demo API key
--
-- Migration 0003 minted a real api_keys row so the landing page's live
-- preview image could call the general /og route. Its raw key was embedded
-- directly in landingPage()'s HTML (and in this repo's git history, in
-- migration 0003's own comment) — a long-lived, plaintext, view-source-
-- discoverable credential that also worked as an unauthenticated, arbitrary-
-- parameter render+store endpoint against production /og.
--
-- The homepage preview is now served by a dedicated /demo-preview.png route
-- (see src/index.ts) that takes no parameters, needs no API key, and never
-- touches api_keys/quota at all. This key is no longer referenced anywhere
-- in the code — delete the row so the historical raw key (public in git
-- history regardless of this migration) can no longer authenticate against
-- /og. See docs/qa/cycle11-full-codebase-review.md Finding 1.

DELETE FROM api_keys WHERE id = 'f1380b7c-f0aa-4fd4-bc35-f7192c3d3db8';
DELETE FROM users WHERE id = 'e4044038-ac19-4cd2-9519-a06c2818bb5f';
