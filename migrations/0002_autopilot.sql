-- Macless Autopilot — recurring-subscription add-on, layered on top of the
-- one-time $99/$39 pipeline. Two tables, same "deliberately small" spirit
-- as 0001_init.sql:
--
--   subscriptions — one row per project opted into Autopilot. Status is a
--                   local CACHE of Stripe's own subscription status (we
--                   have no webhook receiver yet — see index.js — so this
--                   is refreshed by polling Stripe directly whenever it's
--                   read, same pull-based pattern verifyStripeSession()
--                   already uses for the one-time purchase flow). Never
--                   trust this column alone for anything billing-critical
--                   without re-checking Stripe first.
--   bot_events    — an append-only activity log, one row per thing
--                   Autopilot did or noticed for a project. This is the
--                   buyer-facing transparency mechanism (see the
--                   /app/autopilot page in index.js) — every automated
--                   action needs a row here so a buyer can see exactly
--                   what a bot did to their app and when, never a silent
--                   background action.

CREATE TABLE IF NOT EXISTS subscriptions (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id             INTEGER NOT NULL UNIQUE REFERENCES projects(id),
  buyer_id               INTEGER NOT NULL REFERENCES buyers(id),
  stripe_customer_id     TEXT NOT NULL,
  stripe_subscription_id TEXT NOT NULL UNIQUE,
  status                 TEXT NOT NULL,              -- mirrors Stripe's own status strings: 'active' | 'trialing' | 'past_due' | 'canceled' | 'incomplete' | 'incomplete_expired' | 'unpaid'
  current_period_end     TEXT,                        -- ISO timestamp, refreshed on each poll
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_buyer ON subscriptions(buyer_id);

CREATE TABLE IF NOT EXISTS bot_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL REFERENCES projects(id),
  event_type  TEXT NOT NULL,   -- 'heartbeat' | 'cert_expiry_warning' | 'cert_renewed' | 'rejection_diagnosed' | 'auto_patch_applied' | 'resubmitted' | 'error'
  detail      TEXT,             -- free-text/JSON, human-readable in the activity log
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bot_events_project ON bot_events(project_id, created_at DESC);
