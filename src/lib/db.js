// db.js — D1 (SQLite) helpers. Thin wrappers around prepared statements,
// one function per query, so index.js never writes raw SQL inline. Takes
// the D1 binding (env.DB) as the first argument to every function rather
// than reaching into a module-level global — keeps this testable with a
// plain mock object ({ prepare() { ... } }) and avoids any hidden state.

async function getPurchaseBySession(db, sessionId) {
  return db.prepare("SELECT * FROM purchases WHERE stripe_session_id = ?").bind(sessionId).first();
}

async function createPurchase(db, { sessionId, product, email }) {
  // INSERT ... ON CONFLICT DO NOTHING — /get-started can be hit more than
  // once for the same session (buyer refreshes, or double-clicks back),
  // and stripe_session_id is UNIQUE, so this is the idempotent path.
  const result = await db
    .prepare("INSERT INTO purchases (stripe_session_id, product, email) VALUES (?, ?, ?) ON CONFLICT(stripe_session_id) DO NOTHING")
    .bind(sessionId, product, email || null)
    .run();
  // meta.changes is 1 only on a real first-time insert (0 when the ON
  // CONFLICT clause skipped it) — used by index.js to fire the GA4
  // "purchase" event exactly once per real sale, never on a refresh.
  const isNewPurchase = !!(result && result.meta && result.meta.changes === 1);
  const purchase = await getPurchaseBySession(db, sessionId);
  return { ...purchase, _isNewPurchase: isNewPurchase };
}

async function linkPurchaseToBuyer(db, sessionId, buyerId) {
  await db.prepare("UPDATE purchases SET buyer_id = ? WHERE stripe_session_id = ?").bind(buyerId, sessionId).run();
}

async function getPurchasesForBuyer(db, buyerId) {
  const r = await db.prepare("SELECT * FROM purchases WHERE buyer_id = ? ORDER BY created_at DESC").bind(buyerId).all();
  return r.results || [];
}

async function getBuyerByGithubId(db, githubId) {
  return db.prepare("SELECT * FROM buyers WHERE github_id = ?").bind(githubId).first();
}

async function getBuyerById(db, id) {
  return db.prepare("SELECT * FROM buyers WHERE id = ?").bind(id).first();
}

/** Creates the buyer row if new, or refreshes login/token if they've reconnected. Returns the buyer id. */
async function upsertBuyer(db, { githubLogin, githubId, encryptedToken }) {
  const existing = await getBuyerByGithubId(db, githubId);
  if (existing) {
    await db
      .prepare("UPDATE buyers SET github_login = ?, github_token_encrypted = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(githubLogin, encryptedToken, existing.id)
      .run();
    return existing.id;
  }
  const inserted = await db
    .prepare("INSERT INTO buyers (github_login, github_id, github_token_encrypted) VALUES (?, ?, ?)")
    .bind(githubLogin, githubId, encryptedToken)
    .run();
  // D1's `run()` result carries the new rowid at meta.last_row_id.
  if (inserted.meta && inserted.meta.last_row_id) return inserted.meta.last_row_id;
  const created = await getBuyerByGithubId(db, githubId);
  return created ? created.id : null;
}

async function getProjectsForBuyer(db, buyerId) {
  const r = await db.prepare("SELECT * FROM projects WHERE buyer_id = ? ORDER BY updated_at DESC").bind(buyerId).all();
  return r.results || [];
}

async function upsertProject(db, { buyerId, owner, repo, defaultBranch, product }) {
  await db
    .prepare(
      `INSERT INTO projects (buyer_id, owner, repo, default_branch, product) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(buyer_id, owner, repo) DO UPDATE SET default_branch = excluded.default_branch, product = excluded.product, updated_at = datetime('now')`
    )
    .bind(buyerId, owner, repo, defaultBranch || "main", product)
    .run();
  return db.prepare("SELECT * FROM projects WHERE buyer_id = ? AND owner = ? AND repo = ?").bind(buyerId, owner, repo).first();
}

async function getProjectById(db, id) {
  return db.prepare("SELECT * FROM projects WHERE id = ?").bind(id).first();
}

// ------------------------------------------------------------- autopilot

async function getSubscriptionForProject(db, projectId) {
  return db.prepare("SELECT * FROM subscriptions WHERE project_id = ?").bind(projectId).first();
}

async function getSubscriptionByStripeId(db, stripeSubscriptionId) {
  return db.prepare("SELECT * FROM subscriptions WHERE stripe_subscription_id = ?").bind(stripeSubscriptionId).first();
}

/** Insert-or-refresh the local cache of one Stripe subscription's status. Never the source of truth — see 0002_autopilot.sql's header comment. */
async function upsertSubscription(db, { projectId, buyerId, stripeCustomerId, stripeSubscriptionId, status, currentPeriodEnd }) {
  await db
    .prepare(
      `INSERT INTO subscriptions (project_id, buyer_id, stripe_customer_id, stripe_subscription_id, status, current_period_end)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET
         stripe_customer_id = excluded.stripe_customer_id,
         stripe_subscription_id = excluded.stripe_subscription_id,
         status = excluded.status,
         current_period_end = excluded.current_period_end,
         updated_at = datetime('now')`
    )
    .bind(projectId, buyerId, stripeCustomerId, stripeSubscriptionId, status, currentPeriodEnd || null)
    .run();
  return getSubscriptionForProject(db, projectId);
}

/** Every project with a subscription status that should currently be treated as paid-and-active. Used by the cron sweep — see index.js's scheduled() handler. */
async function listActiveSubscriptions(db) {
  const r = await db.prepare("SELECT * FROM subscriptions WHERE status IN ('active', 'trialing')").all();
  return r.results || [];
}

async function logBotEvent(db, { projectId, eventType, detail }) {
  await db
    .prepare("INSERT INTO bot_events (project_id, event_type, detail) VALUES (?, ?, ?)")
    .bind(projectId, eventType, detail || null)
    .run();
}

async function getRecentBotEvents(db, projectId, limit = 50) {
  const r = await db
    .prepare("SELECT * FROM bot_events WHERE project_id = ? ORDER BY created_at DESC LIMIT ?")
    .bind(projectId, limit)
    .all();
  return r.results || [];
}

// ---------------------------------------------------------- plan entitlements
//
// The $19.99/month plan (2026-08-31). Kept apart from the Autopilot
// `subscriptions` helpers above on purpose — different table, different grain
// (per buyer, not per project). See migrations/0003_plan_entitlements.sql.

/** Park a Stripe subscription id against its checkout session, before we know who the buyer is. */
async function recordCheckoutSubscription(db, { sessionId, stripeSubscriptionId, stripeCustomerId }) {
  await db
    .prepare(
      `INSERT INTO checkout_subscriptions (stripe_session_id, stripe_subscription_id, stripe_customer_id)
       VALUES (?, ?, ?) ON CONFLICT(stripe_session_id) DO NOTHING`
    )
    .bind(sessionId, stripeSubscriptionId, stripeCustomerId)
    .run();
}

async function getCheckoutSubscription(db, sessionId) {
  return db.prepare("SELECT * FROM checkout_subscriptions WHERE stripe_session_id = ?").bind(sessionId).first();
}

async function getPlanSubscriptionForBuyer(db, buyerId) {
  return db.prepare("SELECT * FROM plan_subscriptions WHERE buyer_id = ?").bind(buyerId).first();
}

/** Insert-or-refresh the local cache of one buyer's plan subscription. Never the source of truth. */
async function upsertPlanSubscription(db, { buyerId, stripeCustomerId, stripeSubscriptionId, status, currentPeriodEnd }) {
  await db
    .prepare(
      `INSERT INTO plan_subscriptions (buyer_id, stripe_customer_id, stripe_subscription_id, status, current_period_end)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(buyer_id) DO UPDATE SET
         stripe_customer_id = excluded.stripe_customer_id,
         stripe_subscription_id = excluded.stripe_subscription_id,
         status = excluded.status,
         current_period_end = excluded.current_period_end,
         updated_at = datetime('now')`
    )
    .bind(buyerId, stripeCustomerId, stripeSubscriptionId, status, currentPeriodEnd || null)
    .run();
  return getPlanSubscriptionForBuyer(db, buyerId);
}

/** Everything the cron sweep should re-check: the same status set that grants access
 *  (see PLAN_ACTIVE_STATUSES in index.js — keep the two in step). Rows already cached as
 *  'canceled' or 'unpaid' are skipped because Stripe can only move them further away from
 *  active, and a buyer who resubscribes comes back through checkout, which rewrites the
 *  row anyway. 'past_due' IS swept, so a recovered card flips the cache back to active
 *  without waiting for that buyer to turn up. */
async function listSweepablePlanSubscriptions(db) {
  const r = await db.prepare("SELECT * FROM plan_subscriptions WHERE status IN ('active', 'trialing', 'past_due')").all();
  return r.results || [];
}

export {
  getPurchaseBySession,
  createPurchase,
  linkPurchaseToBuyer,
  getPurchasesForBuyer,
  getBuyerByGithubId,
  getBuyerById,
  upsertBuyer,
  getProjectsForBuyer,
  upsertProject,
  getProjectById,
  getSubscriptionForProject,
  getSubscriptionByStripeId,
  upsertSubscription,
  listActiveSubscriptions,
  logBotEvent,
  getRecentBotEvents,
  recordCheckoutSubscription,
  getCheckoutSubscription,
  getPlanSubscriptionForBuyer,
  upsertPlanSubscription,
  listSweepablePlanSubscriptions,
};
