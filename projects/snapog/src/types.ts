// SnapOG — shared types

export type Tier = 'free' | 'pro' | 'business';

export const TIER_LIMITS: Record<Tier, number> = {
  free: 100,
  pro: 10_000,
  business: 100_000,
};

export interface ApiKey {
  id: string;
  user_id: string;
  name: string;
  key_prefix: string;
  key_hash: string;
  tier: Tier;
  monthly_limit: number;
  usage_count: number;
  usage_reset_at: string;
  created_at: string;
}

// One row of the /admin/tier-requests view: tier_requests joined to users
// on user_id = users.id, for display only (see docs/fullstack/cycle8-tier-requests-admin-view.md).
export interface TierRequestRow {
  id: string;
  tier: string;
  email: string;
  created_at: string;
}

export interface OGParams {
  title: string;
  description?: string;
  theme?: 'dark' | 'light';
  template?: 'default' | 'blog' | 'article';
  author?: string;
  domain?: string;
  tag?: string;
}

export interface Env {
  DB: D1Database;
  OG_CACHE: R2Bucket;
  ENVIRONMENT: string;
  AUTH_SECRET?: string;
}
