-- Macless backend — initial schema.
--
-- Three tables, deliberately small:
--   purchases  — one row per Stripe checkout session. Created the moment
--                a buyer lands on /get-started, BEFORE they've connected
--                GitHub — this is what lets us re-show "you already
--                bought this" if they close the tab and come back, and
--                it's the row that later gets linked to a buyer once
--                they authorize.
--   buyers     — one row per GitHub identity that has connected. The
--                GitHub token is stored encrypted (AES-GCM, via
--                src/lib/crypto.js) — never in plaintext.
--   projects   — one row per GitHub repo a buyer has connected to their
--                purchase. A buyer could in principle connect more than
--                one repo (e.g. redoing a project), so this is its own
--                table rather than columns on buyers.

CREATE TABLE IF NOT EXISTS purchases (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  stripe_session_id  TEXT NOT NULL UNIQUE,
  product            TEXT NOT NULL,              -- 'ios' | 'android'
  email              TEXT,                        -- from Stripe, for support lookups only
  buyer_id           INTEGER REFERENCES buyers(id),
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_purchases_buyer ON purchases(buyer_id);

CREATE TABLE IF NOT EXISTS buyers (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  github_login           TEXT NOT NULL,
  github_id              INTEGER NOT NULL UNIQUE,
  github_token_encrypted TEXT NOT NULL,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS projects (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  buyer_id        INTEGER NOT NULL REFERENCES buyers(id),
  owner           TEXT NOT NULL,
  repo            TEXT NOT NULL,
  default_branch  TEXT NOT NULL DEFAULT 'main',
  product         TEXT NOT NULL,              -- 'ios' | 'android' — which workflow file this project uses
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(buyer_id, owner, repo)
);

CREATE INDEX IF NOT EXISTS idx_projects_buyer ON projects(buyer_id);
