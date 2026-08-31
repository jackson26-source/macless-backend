-- Plan entitlements — the $19.99/month plan introduced 2026-08-31.
--
-- Why this is separate from `subscriptions` (0002_autopilot.sql): that table
-- is Autopilot's, and it's keyed per PROJECT (project_id NOT NULL UNIQUE).
-- The plan is per BUYER — one person, one plan, however many repos they
-- connect. Overloading one table across two different grains would mean
-- relaxing that unique constraint and adding a discriminator column, which
-- silently makes every existing Autopilot query wrong until it's audited.
-- Two tables, no ambiguity.
--
-- checkout_subscriptions exists because of an ordering problem, not because
-- the data deserves its own table: /get-started knows the Stripe subscription
-- id but has no buyer yet — the buyer row isn't created until the GitHub OAuth
-- callback, which happens afterwards and may never happen at all if someone
-- pays and closes the tab. So the subscription id is parked here against the
-- checkout session, and the callback moves it onto the buyer. Keyed on the
-- session id, which Stripe guarantees is unique and never reused.
--
-- Both tables are a CACHE of Stripe, same rule as 0002: never trust the
-- status column alone for anything billing-critical. entitlementFor() in
-- src/index.js re-checks Stripe on every call and refreshes this cache from
-- the answer.

CREATE TABLE IF NOT EXISTS checkout_subscriptions (
  stripe_session_id      TEXT PRIMARY KEY,
  stripe_subscription_id TEXT NOT NULL,
  stripe_customer_id     TEXT NOT NULL,
  created_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS plan_subscriptions (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  buyer_id               INTEGER NOT NULL UNIQUE REFERENCES buyers(id),
  stripe_customer_id     TEXT NOT NULL,
  stripe_subscription_id TEXT NOT NULL,   -- deliberately NOT UNIQUE: see note below
  status                 TEXT NOT NULL,   -- mirrors Stripe: 'active' | 'trialing' | 'past_due' | 'canceled' | 'incomplete' | 'incomplete_expired' | 'unpaid'
  current_period_end     TEXT,            -- ISO timestamp, refreshed on each poll
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_plan_subscriptions_stripe ON plan_subscriptions(stripe_subscription_id);

-- On stripe_subscription_id not being UNIQUE: it looks like it should be, and an
-- earlier draft made it so. But upsertPlanSubscription() upserts with
-- ON CONFLICT(buyer_id), and SQLite only applies the conflict clause for the index
-- actually named. A collision on a SECOND unique index raises SQLITE_CONSTRAINT
-- instead, which here would mean an unhandled 500 in the middle of /oauth/callback --
-- after the buyer row and purchase link are already written, and before the session
-- cookie is set. That's a worse failure than the duplicate it was guarding against.
-- buyer_id UNIQUE is the constraint the code actually relies on.
