// Macless backend — the hosted version of the desktop app's wizard.
// Buyer flow: Stripe checkout -> /get-started?session_id= (verifies the
// payment, offers "Connect GitHub") -> /login (kicks off GitHub's OAuth
// web flow) -> /oauth/callback (exchanges the code, creates/updates the
// buyer record, sets a signed session cookie, redirects to /app) -> /app
// (the wizard: pick/create a repo, push the pipeline template, fill in
// secrets, push them, trigger a build, watch it, and Rejection Doctor).
//
// No Signing Doctor pre-flight here on purpose — Workers have no
// filesystem or shell, so the real signing-doctor.sh script (needs
// macOS `security`/PlistBuddy or `keytool`/openssl) categorically can't
// run in this environment. Signing problems are instead caught by the
// CI-based Signing Doctor step already wired into every workflow
// template, which runs for real on GitHub's runners before the rest of
// the build starts.
//
// Every value below marked "set via wrangler / dashboard" is a Worker
// secret Jackson generates and pastes in himself — see DEPLOY.md. None
// of them are ever typed in by a Claude session.

import * as db from "./lib/db.js";
import * as githubApi from "./lib/github-api.js";
import { encryptToken, decryptToken, signSession, verifySession as verifyCookie } from "./lib/crypto.js";
import { scanRepoWorkflows } from "./lib/workflow-scan.js";
import { diagnoseRejection, generateAppealLetter } from "./lib/rejection-doctor.js";
import { diagnoseIosProfile, diagnoseAndroidKeystore, formatReport } from "./lib/signing-doctor.js";
import { autoProvisionSigning, AscApiError } from "./lib/asc-auto-provision.js";
import { TEMPLATE_FILES } from "./lib/template-files.generated.js";
import { WIZARD_HTML, WIZARD_JS, WIZARD_CSS } from "./lib/public-embed.generated.js";

const SESSION_COOKIE = "mx_session";
const SUPPORT_EMAIL = "support@macless.dev"; // update if this isn't the real inbox
const OAUTH_STATE_MAX_AGE_SECONDS = 60 * 10; // the GitHub OAuth round-trip should take seconds, not days

// Real provisioning profiles / certs / keystores are a few KB to tens of KB.
// Reject wildly oversized input before it hits the DER/PBKDF2 parsing code —
// cheap check that blocks an authenticated buyer from feeding this endpoint
// deliberately huge payloads just to burn CPU time.
const MAX_SIGNING_INPUT_BASE64_CHARS = 500_000; // ~375KB decoded
const MAX_REJECTION_TEXT_CHARS = 20_000;

// ---------------------------------------------------------------- pages

function pageShell(bodyHtml, title = "Macless") {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="robots" content="noindex">
<style>
  :root{
    --bg:#faf8f3; --bg-panel:#f2efe6; --border:#e2ddd0; --text:#24211c;
    --text-dim:#6b6558; --accent:#a8461e; --serif:Georgia,'Iowan Old Style','Times New Roman',serif;
    --sans:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
  }
  *{box-sizing:border-box;margin:0;padding:0;}
  body{background:var(--bg);color:var(--text);font-family:var(--sans);font-size:16px;line-height:1.6;}
  .wrap{max-width:560px;margin:0 auto;padding:64px 24px;}
  h1{font-family:var(--serif);font-size:28px;margin-bottom:14px;}
  p{color:var(--text-dim);font-size:15.5px;margin-bottom:16px;}
  .card{margin-top:24px;padding:24px;background:var(--bg-panel);border:1px solid var(--border);border-radius:10px;}
  .btn{display:inline-block;padding:14px 24px;border-radius:6px;font-weight:600;font-size:15px;
    text-decoration:none;background:var(--text);color:#fdfcf9;margin-top:8px;}
  .btn:hover{background:var(--accent);}
  code{font-family:'SF Mono',Menlo,Consolas,monospace;font-size:13.5px;background:var(--bg-panel);
    padding:2px 6px;border-radius:4px;}
  a{color:var(--accent);}
</style>
</head>
<body><div class="wrap">${bodyHtml}</div></body>
</html>`;
}

function html(bodyHtml, title, status = 200) {
  return new Response(pageShell(bodyHtml, title), { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function errorPage(message, status = 400) {
  return html(
    `<h1>Couldn't verify that purchase</h1>
     <p>${message}</p>
     <p>If you already paid and this keeps happening, email
     <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> with your Stripe receipt and we'll sort it out directly.</p>`,
    "Macless — couldn't verify purchase",
    status
  );
}

function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...extraHeaders } });
}

// ------------------------------------------------------------- helpers

// 2026-08-31 pricing migration. Was two platform SKUs (iOS $99 / Android $39),
// each its own Stripe Product. Now ONE product ("Macless", prod_VAgP3vMPtyGpxU)
// with two prices — $19.99/month recurring and $299 one-time — and iOS +
// Android are both included in either. The old two entries stay so that
// anyone who bought before today still resolves; their Products are archived
// in Stripe, so no NEW session can ever carry those price ids.
//
// Built defensively rather than as an object literal: with computed keys, an
// unset env var becomes the literal key "undefined", and a session whose
// line_items came back without a price would then match it and be treated as
// a valid purchase. Skipping falsy ids makes that impossible.
function productMap(env) {
  const map = {};
  const add = (priceId, key, label, recurring) => {
    if (priceId) map[priceId] = { key, label, recurring: !!recurring };
  };
  add(env.STRIPE_PRICE_ID_IOS, "ios", "Macless — iOS");
  add(env.STRIPE_PRICE_ID_ANDROID, "android", "Macless — Android");
  add(env.STRIPE_PRICE_ID_MONTHLY, "monthly", "Macless — monthly", true);
  add(env.STRIPE_PRICE_ID_ONETIME, "onetime", "Macless");
  return map;
}

async function verifyStripeSession(sessionId, env) {
  const resp = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=line_items`, {
    headers: { Authorization: `Bearer ${env.STRIPE_RESTRICTED_KEY}` },
  });
  if (!resp.ok) return { ok: false };
  const session = await resp.json();
  if (session.payment_status !== "paid") return { ok: false, reason: "unpaid" };
  const priceId = session.line_items?.data?.[0]?.price?.id;
  if (!priceId) return { ok: false, reason: "unknown-product" };
  const product = productMap(env)[priceId];
  if (!product) return { ok: false, reason: "unknown-product" };
  return { ok: true, product, email: session.customer_details?.email || session.customer_email || null };
}

// ---------------------------------------------------------- funnel analytics
//
// Server-side purchase tracking. The site's client-side GA4 tag (macless-site's
// gtag snippet) already fires: page_view (landing), view_pricing (added
// 2026-08-30, fires when #pricing scrolls into view), and stripe_checkout_click
// (checkout started). None of those can see whether the Stripe redirect that
// follows ever actually completed with a real payment -- Stripe's checkout
// page is Stripe's own domain, not ours to instrument. This is the one place
// a real, server-verified payment is confirmed (see verifyStripeSession above),
// so it's the only reliable place to fire "purchased". Sent via GA4's
// Measurement Protocol (server-to-server), not the browser tag. Best-effort:
// never blocks or fails the buyer's actual redirect if GA4 is slow/down.
const GA4_PRODUCT_PRICE_USD = { ios: 99, android: 39, monthly: 19.99, onetime: 299 };

async function sendGA4Purchase({ sessionId, productKey, env }) {
  if (!env.GA4_API_SECRET || !env.GA4_MEASUREMENT_ID) return; // not configured yet -- no-op, not an error
  const value = GA4_PRODUCT_PRICE_USD[productKey] ?? 0;
  const body = {
    // No real client_id exists server-side (this fires well after any
    // client GA4 session, and 97% of sessions carry no attribution anyway
    // per the project's own GA4 audit) -- a fresh id per event is fine
    // for a count-and-value conversion event like this.
    client_id: crypto.randomUUID(),
    events: [
      {
        name: "purchase",
        params: {
          transaction_id: sessionId, // Stripe's own checkout session id -- stable, unique, never reused
          currency: "USD",
          value,
          items: [{ item_id: productKey, item_name: `Macless - ${productKey}`, price: value, quantity: 1 }],
        },
      },
    ],
  };
  try {
    await fetch(
      `https://www.google-analytics.com/mp/collect?measurement_id=${encodeURIComponent(env.GA4_MEASUREMENT_ID)}&api_secret=${encodeURIComponent(env.GA4_API_SECRET)}`,
      { method: "POST", body: JSON.stringify(body) }
    );
  } catch (e) {
    // Analytics must never break a real purchase confirmation -- swallow and move on.
  }
}

// ------------------------------------------------------------- autopilot
//
// Macless Autopilot is a recurring-subscription add-on layered on top of
// the one-time $99/$39 pipeline purchase. It follows the project's own
// pricing rule (see claude/macless-competitor-feature-research doc): the
// one-time SKU only ever bundles things that run on the buyer's own
// GitHub Actions minutes / own credentials / pure client-side logic —
// anything Macless itself has to host or run continuously gets its own
// price. Autopilot is the "anything Macless hosts and runs continuously"
// case: a Cloudflare Cron sweep (see scheduled() below) that checks in on
// a buyer's project on a schedule, on Macless's own compute.
//
// Billing follows the exact same pull-based pattern verifyStripeSession()
// already uses above: there's no webhook receiver, so subscription status
// is always re-verified directly against Stripe's API, both right after
// checkout (verifyAndSyncAutopilotCheckout) and on the recurring cron
// sweep (scheduled()). The `subscriptions` table (migrations/0002_autopilot.sql)
// is explicitly a CACHE of that, never trusted alone for anything
// billing-critical.
//
// Phase 1 (this change): billing scaffolding + an activity log + a
// heartbeat cron that just proves the sweep runs and records that it
// checked in. It does NOT yet take any real automated action on a
// buyer's app.
//
// Phase 2 (not yet built, needs a decision first): real automated
// actions — cert/profile auto-renewal, rejection auto-diagnose-and-resubmit.
// The open question: true unattended cert renewal means calling the ASC
// API on a schedule with no buyer present, which means storing the
// buyer's ASC API key (encrypted) somewhere durable — a real reversal of
// /api/auto-sign's existing hard rule, above, that the buyer's .p8 key is
// NEVER persisted anywhere (D1, KV, logs). Don't build that silently; ask
// first. Until that's decided, Phase 2's cert-handling should probably
// stay "detect + notify" — which already exists for free, zero Macless
// cost, via template/.github/workflows/check-expiry.yml, running on the
// buyer's own GitHub Actions.

async function fetchStripeSubscription(subscriptionId, env) {
  const resp = await fetch(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    headers: { Authorization: `Bearer ${env.STRIPE_RESTRICTED_KEY}` },
  });
  if (!resp.ok) return { ok: false };
  return { ok: true, subscription: await resp.json() };
}

/** Called from /app/autopilot right after a Stripe Checkout redirect (?session_id=...) to sync the new subscription into our local cache. Re-checks Stripe directly rather than trusting the redirect alone. */
async function verifyAndSyncAutopilotCheckout(sessionId, env) {
  const resp = await fetch(
    `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=subscription`,
    { headers: { Authorization: `Bearer ${env.STRIPE_RESTRICTED_KEY}` } }
  );
  if (!resp.ok) return { ok: false };
  const session = await resp.json();
  if (session.mode !== "subscription" || !session.subscription) return { ok: false, reason: "not-a-subscription" };
  const sub = session.subscription;
  const projectId = Number(session.metadata?.project_id);
  const buyerId = Number(session.metadata?.buyer_id);
  if (!projectId || !buyerId) return { ok: false, reason: "missing-metadata" };
  await db.upsertSubscription(env.DB, {
    projectId,
    buyerId,
    stripeCustomerId: sub.customer,
    stripeSubscriptionId: sub.id,
    status: sub.status,
    currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
  });
  await db.logBotEvent(env.DB, { projectId, eventType: "heartbeat", detail: "Autopilot subscription activated." });
  return { ok: true, projectId };
}

function autopilotStatusCard(project, subscription) {
  const active = subscription && (subscription.status === "active" || subscription.status === "trialing");
  if (!active) {
    return `<div class="card">
      <h1 style="font-size:20px;">Macless Autopilot</h1>
      <p>A bot that checks in on <code>${project.owner}/${project.repo}</code> twice a day — expiring certs, failed builds, anything that needs your attention — and logs everything it does here.</p>
      <form method="POST" action="/api/autopilot/checkout" id="autopilot-checkout-form">
        <input type="hidden" name="project_id" value="${project.id}">
        <button class="btn" type="submit">Enable Autopilot</button>
      </form>
      <script>
        document.getElementById('autopilot-checkout-form').addEventListener('submit', async (e) => {
          e.preventDefault();
          const resp = await fetch('/api/autopilot/checkout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectId: ${project.id} }),
          });
          const data = await resp.json();
          if (data.ok && data.url) { window.location.href = data.url; }
          else { alert(data.detail || "Couldn't start checkout."); }
        });
      </script>
    </div>`;
  }
  const periodEnd = subscription.current_period_end ? new Date(subscription.current_period_end).toLocaleDateString() : "unknown";
  return `<div class="card">
    <h1 style="font-size:20px;">Macless Autopilot — active</h1>
    <p>Watching <code>${project.owner}/${project.repo}</code>. Status: <strong>${subscription.status}</strong>. Renews ${periodEnd}.</p>
  </div>`;
}

function botEventsTable(events) {
  if (!events || events.length === 0) {
    return `<p style="margin-top:16px;">No activity yet — Autopilot's heartbeat runs twice a day, so check back soon.</p>`;
  }
  const rows = events
    .map(
      (e) =>
        `<tr><td style="padding:6px 10px 6px 0;white-space:nowrap;color:var(--text-dim);">${e.created_at}</td><td style="padding:6px 0;">${e.event_type}</td><td style="padding:6px 0 6px 10px;color:var(--text-dim);">${e.detail || ""}</td></tr>`
    )
    .join("");
  return `<table style="margin-top:16px;width:100%;border-collapse:collapse;font-size:14px;"><tbody>${rows}</tbody></table>`;
}

function redirectUri(env) {
  return `${env.PUBLIC_BASE_URL}/oauth/callback`;
}

function parseCookies(request) {
  const header = request.headers.get("Cookie") || "";
  const out = {};
  header.split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx === -1) return;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}

function sessionCookieHeader(value, env) {
  const secure = env.PUBLIC_BASE_URL && env.PUBLIC_BASE_URL.startsWith("https://") ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly${secure}; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`;
}

function clearCookieHeader(env) {
  const secure = env.PUBLIC_BASE_URL && env.PUBLIC_BASE_URL.startsWith("https://") ? "; Secure" : "";
  return `${SESSION_COOKIE}=; Path=/; HttpOnly${secure}; SameSite=Lax; Max-Age=0`;
}

/** Resolves the request's session cookie to a buyer + a decrypted, ready-to-use GitHub token. Returns null if not authenticated. */
async function requireBuyer(request, env) {
  const cookies = parseCookies(request);
  const raw = cookies[SESSION_COOKIE];
  if (!raw) return null;
  const buyerIdStr = await verifyCookie(raw, env.SESSION_SECRET);
  if (!buyerIdStr) return null;
  const buyerId = Number(buyerIdStr);
  const buyer = await db.getBuyerById(env.DB, buyerId);
  if (!buyer) return null;
  let token;
  try {
    token = await decryptToken(buyer.github_token_encrypted, env.TOKEN_ENCRYPTION_KEY);
  } catch (e) {
    return null; // key rotated or corrupted row — treat as logged out rather than 500ing
  }
  return { buyerId, login: buyer.github_login, token };
}

function base64ToBytes(b64) {
  const binary = atob(b64.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch (e) {
    return {};
  }
}

// -------------------------------------------------------------- router

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    try {
      // ---- purchase verification + GitHub OAuth ---------------------------------------------------

      if (pathname === "/get-started" && request.method === "GET") {
        const sessionId = url.searchParams.get("session_id");
        if (!sessionId) return errorPage("No purchase session was included in this link. If you just paid, use the link Stripe sent you on the confirmation page.");
        const result = await verifyStripeSession(sessionId, env);
        if (!result.ok) return errorPage("We couldn't confirm this purchase yet. If you just paid seconds ago, wait a moment and refresh — otherwise email support with your receipt.");
        const purchase = await db.createPurchase(env.DB, { sessionId, product: result.product.key, email: result.email });
        if (purchase._isNewPurchase) {
          // Fire-and-forget: never let analytics delay or break the buyer's actual flow.
          sendGA4Purchase({ sessionId, productKey: result.product.key, env }).catch(() => {});
        }

        const cookies = parseCookies(request);
        const cookieBuyerId = cookies[SESSION_COOKIE] ? await verifyCookie(cookies[SESSION_COOKIE], env.SESSION_SECRET) : null;
        if (purchase.buyer_id && cookieBuyerId && Number(cookieBuyerId) === purchase.buyer_id) {
          return html(
            `<h1>Welcome back.</h1>
             <p>Your ${result.product.label} purchase is already connected. Head to your dashboard to keep going.</p>
             <a class="btn" href="/app">Open Macless</a>`,
            "Macless — welcome back"
          );
        }

        return html(
          `<h1>You're set — thanks for buying ${result.product.label}.</h1>
           <p>One step left: connect your GitHub account so Macless can push the pipeline into your repo. This is GitHub's own login page — your credentials are never seen by Macless.</p>
           <a class="btn" href="/login?session_id=${encodeURIComponent(sessionId)}">Connect GitHub</a>
           <div class="card">
             <p style="margin-bottom:0;">After this, you'll pick (or create) the GitHub repo for your app, and the rest happens in your browser — no terminal, no download.</p>
           </div>
           <p style="margin-top:24px;">Trouble? Email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> with your receipt.</p>`,
          "Macless — connect GitHub"
        );
      }

      if (pathname === "/login" && request.method === "GET") {
        const sessionId = url.searchParams.get("session_id");
        if (!sessionId) return errorPage("Missing purchase session — start from the link in your purchase confirmation.");
        const result = await verifyStripeSession(sessionId, env); // re-verify, never trust the bare id alone
        if (!result.ok) return errorPage("We couldn't confirm this purchase. Email support with your receipt.");
        const state = await signSession(sessionId, env.SESSION_SECRET);
        const authorizeUrl = githubApi.authUrl(env.GITHUB_CLIENT_ID, redirectUri(env), state);
        return Response.redirect(authorizeUrl, 302);
      }

      if (pathname === "/oauth/callback" && request.method === "GET") {
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (!code || !state) return errorPage("GitHub didn't send back what we expected. Try connecting again from your purchase confirmation email.");
        // signSession/verifySession are generic HMAC sign/verify, reused here for the
        // OAuth state param — but a CSRF nonce shouldn't be valid for 30 days like the
        // session cookie is, so this one gets its own short window (10 min).
        const sessionId = await verifyCookie(state, env.SESSION_SECRET, OAUTH_STATE_MAX_AGE_SECONDS);
        if (!sessionId) return errorPage("This connection link looks tampered with or expired. Try connecting again from your purchase confirmation email — the link expires after 10 minutes for security.");

        const exchanged = await githubApi.exchangeCode(code, env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET, redirectUri(env));
        if (!exchanged.ok) return errorPage(`GitHub sign-in didn't complete: ${exchanged.detail}`);

        const who = await githubApi.whoAmI(exchanged.token);
        if (!who.ok) return errorPage("Couldn't read your GitHub account details after signing in. Try again.");

        const encryptedToken = await encryptToken(exchanged.token, env.TOKEN_ENCRYPTION_KEY);
        const buyerId = await db.upsertBuyer(env.DB, { githubLogin: who.login, githubId: who.id, encryptedToken });
        await db.linkPurchaseToBuyer(env.DB, sessionId, buyerId);

        const cookieValue = await signSession(buyerId, env.SESSION_SECRET);
        return new Response(null, {
          status: 302,
          headers: { Location: "/app", "Set-Cookie": sessionCookieHeader(cookieValue, env) },
        });
      }

      // ---- the wizard app + its static files ---------------------------------------------------

      if (pathname === "/app" && request.method === "GET") {
        const buyer = await requireBuyer(request, env);
        if (!buyer) return errorPage("You're not signed in (or your session expired). Use the link from your purchase confirmation email to reconnect.", 401);
        return new Response(WIZARD_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      if (pathname === "/app/wizard.js" && request.method === "GET") {
        return new Response(WIZARD_JS, { headers: { "Content-Type": "application/javascript; charset=utf-8" } });
      }
      if (pathname === "/app/wizard.css" && request.method === "GET") {
        return new Response(WIZARD_CSS, { headers: { "Content-Type": "text/css; charset=utf-8" } });
      }

      if (pathname === "/app/autopilot" && request.method === "GET") {
        const buyer = await requireBuyer(request, env);
        if (!buyer) return errorPage("You're not signed in (or your session expired). Use the link from your purchase confirmation email to reconnect.", 401);
        const sessionIdParam = url.searchParams.get("session_id");
        if (sessionIdParam) {
          // Best-effort sync right after a Stripe Checkout redirect — the status
          // card below always re-reads from the DB either way, so this isn't
          // load-bearing if it fails (the cron sweep will catch up regardless).
          await verifyAndSyncAutopilotCheckout(sessionIdParam, env);
        }
        const projectId = Number(url.searchParams.get("project_id"));
        if (!projectId) return errorPage("Missing project_id — open Autopilot from a project in your dashboard.");
        const project = await db.getProjectById(env.DB, projectId);
        if (!project || project.buyer_id !== buyer.buyerId) return errorPage("That project isn't linked to your account.", 403);
        const subscription = await db.getSubscriptionForProject(env.DB, projectId);
        const events = await db.getRecentBotEvents(env.DB, projectId);
        return html(
          `<h1>Autopilot</h1>
           ${autopilotStatusCard(project, subscription)}
           <h2 style="font-size:16px;margin-top:32px;">Activity log</h2>
           ${botEventsTable(events)}
           <p style="margin-top:32px;"><a href="/app">&larr; Back to Macless</a></p>`,
          "Macless — Autopilot"
        );
      }

      // ---- API (all require the session cookie except auth/status + diagnose-rejection) -------

      if (pathname === "/api/auth/status" && request.method === "GET") {
        const buyer = await requireBuyer(request, env);
        return json(buyer ? { authenticated: true, login: buyer.login } : { authenticated: false });
      }

      if (pathname === "/api/logout" && request.method === "POST") {
        return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json", "Set-Cookie": clearCookieHeader(env) } });
      }

      if (pathname === "/api/diagnose-rejection" && request.method === "POST") {
        const body = await readJson(request);
        const text = body.text || "";
        if (text.length > MAX_REJECTION_TEXT_CHARS) return json({ ok: false, detail: "That's way longer than any real App Store rejection message — paste just the rejection text." }, 400);
        return json(diagnoseRejection(text));
      }

      // Deterministic appeal-letter draft from a diagnose-rejection match — no model call,
      // no hosting cost, same zero-ongoing-cost shape as diagnose-rejection above, so it stays
      // unauthenticated too. Small size caps on the free-text fields since these are buyer-typed.
      if (pathname === "/api/appeal-letter" && request.method === "POST") {
        const body = await readJson(request);
        const match = body.match;
        if (!match || typeof match !== "object" || typeof match.guideline !== "string" || typeof match.title !== "string") {
          return json({ ok: false, error: "Missing or malformed match — pass one of the objects returned by /api/diagnose-rejection's matches array." }, 400);
        }
        const clamp = (v, max) => (typeof v === "string" ? v.slice(0, max) : undefined);
        const letter = generateAppealLetter(match, {
          appName: clamp(body.appName, 200),
          buildNumber: clamp(body.buildNumber, 50),
          fixSummary: clamp(body.fixSummary, 2000),
        });
        return json(letter, letter.ok ? 200 : 400);
      }

      // Everything below needs an authenticated buyer.
      if (pathname.startsWith("/api/")) {
        const buyer = await requireBuyer(request, env);
        if (!buyer) return json({ ok: false, detail: "Not signed in." }, 401);

        if (pathname === "/api/repos" && request.method === "GET") {
          return json(await githubApi.listRepos(buyer.token));
        }

        if (pathname === "/api/projects" && request.method === "GET") {
          return json({ ok: true, projects: await db.getProjectsForBuyer(env.DB, buyer.buyerId) });
        }

        if (pathname === "/api/connect" && request.method === "POST") {
          const body = await readJson(request);
          let owner, repo, defaultBranch, isNew;

          if (body.newRepoName) {
            const created = await githubApi.createRepo(buyer.token, body.newRepoName, { private: body.private !== false });
            if (!created.ok) return json({ ok: false, detail: created.detail }, 400);
            owner = created.owner;
            repo = created.repo;
            defaultBranch = created.defaultBranch;
            isNew = true;
          } else {
            if (!body.owner || !body.repo) return json({ ok: false, detail: "owner and repo (or newRepoName) are required." }, 400);
            owner = body.owner;
            repo = body.repo;
            defaultBranch = body.defaultBranch || "main";
            isNew = false;
          }

          let filesToWrite = TEMPLATE_FILES;
          if (!isNew) {
            // Existing repo picked by the buyer — never overwrite their own files, only add what's missing.
            const existing = await githubApi.listRepoPaths(buyer.token, owner, repo, defaultBranch);
            if (existing.ok) {
              filesToWrite = {};
              for (const [path, content] of Object.entries(TEMPLATE_FILES)) {
                if (!existing.paths.includes(path)) filesToWrite[path] = content;
              }
            }
          }

          let filesWritten = 0;
          if (Object.keys(filesToWrite).length > 0) {
            const commit = await githubApi.commitFiles(buyer.token, owner, repo, defaultBranch, filesToWrite, "Add Macless pipeline");
            if (!commit.ok) return json({ ok: false, detail: commit.detail }, 400);
            filesWritten = commit.filesWritten;
          }

          await db.upsertProject(env.DB, { buyerId: buyer.buyerId, owner, repo, defaultBranch, product: "ios" });
          return json({ ok: true, owner, repo, defaultBranch, filesWritten });
        }

        if (pathname === "/api/scan" && request.method === "GET") {
          const owner = url.searchParams.get("owner");
          const repo = url.searchParams.get("repo");
          if (!owner || !repo) return json({ ok: false, detail: "owner and repo query params are required." }, 400);
          return json(await scanRepoWorkflows(buyer.token, owner, repo));
        }

        if (pathname === "/api/push-secret" && request.method === "POST") {
          const body = await readJson(request);
          if (!body.owner || !body.repo || !body.name || typeof body.value !== "string") return json({ ok: false, detail: "owner, repo, name and value are required." }, 400);
          const result =
            body.scope === "variable"
              ? await githubApi.pushVariable(buyer.token, body.owner, body.repo, body.name, body.value)
              : await githubApi.pushSecret(buyer.token, body.owner, body.repo, body.name, body.value);
          return json(result);
        }

        if (pathname === "/api/auto-sign" && request.method === "POST") {
          // Auto-generates a Distribution certificate + App Store profile
          // via the buyer's OWN Apple API key, packaged into a .p12 the
          // wizard can push as secrets — replacing the manual "go create
          // this yourself in Apple's portal" step. The buyer's .p8 key
          // content lives only in this one request's memory: it's read
          // from the JSON body below, handed straight to autoProvisionSigning,
          // and falls out of scope when this handler returns. Nothing here
          // writes it to D1, KV, a log, or anywhere else.
          const body = await readJson(request);
          if (!body.keyId || !body.issuerId || !body.p8Pem || !body.bundleIdentifier) {
            return json({ ok: false, detail: "Key ID, Issuer ID, the .p8 file, and a bundle identifier are all required." }, 400);
          }
          if (typeof body.p8Pem !== "string" || body.p8Pem.length > 4000 || !body.p8Pem.includes("PRIVATE KEY")) {
            return json({ ok: false, detail: "That doesn't look like a real .p8 API key file." }, 400);
          }
          try {
            const result = await autoProvisionSigning(
              { p8Pem: body.p8Pem, keyId: body.keyId, issuerId: body.issuerId },
              { bundleIdentifier: body.bundleIdentifier, appName: body.appName }
            );
            return json({ ok: true, ...result });
          } catch (e) {
            const detail = e instanceof AscApiError ? e.message : `Couldn't generate signing files: ${(e && e.message) || e}`;
            return json({ ok: false, detail }, e instanceof AscApiError ? 502 : 500);
          }
        }

        if (pathname === "/api/trigger-build" && request.method === "POST") {
          const body = await readJson(request);
          if (!body.owner || !body.repo || !body.workflowFile) return json({ ok: false, detail: "owner, repo and workflowFile are required." }, 400);
          return json(await githubApi.triggerWorkflow(buyer.token, body.owner, body.repo, body.workflowFile, body.ref || "main"));
        }

        if (pathname === "/api/build-status" && request.method === "GET") {
          const owner = url.searchParams.get("owner");
          const repo = url.searchParams.get("repo");
          const workflowFile = url.searchParams.get("workflowFile");
          if (!owner || !repo || !workflowFile) return json({ ok: false, detail: "owner, repo and workflowFile query params are required.", runs: [] }, 400);
          return json(await githubApi.listRuns(buyer.token, owner, repo, workflowFile, 5));
        }

        if (pathname === "/api/diagnose-signing" && request.method === "POST") {
          const body = await readJson(request);
          for (const field of ["profileBase64", "certBase64", "androidKeystoreBase64"]) {
            if (typeof body[field] === "string" && body[field].length > MAX_SIGNING_INPUT_BASE64_CHARS) {
              return json({ ok: false, output: "That file is much larger than any real provisioning profile, certificate, or keystore — double-check what you're uploading." }, 400);
            }
          }
          const results = [];
          try {
            if (body.profileBase64) {
              results.push(
                await diagnoseIosProfile({
                  profileBytes: base64ToBytes(body.profileBase64),
                  expectedTeamId: body.expectedTeamId || null,
                  expectedBundleId: body.expectedBundleId || null,
                  certBytes: body.certBase64 ? base64ToBytes(body.certBase64) : null,
                  certPassword: body.certPassword || "",
                })
              );
            }
            if (body.androidKeystoreBase64) {
              results.push(
                await diagnoseAndroidKeystore({
                  keystoreBytes: base64ToBytes(body.androidKeystoreBase64),
                  keystorePassword: body.androidKeystorePassword || "",
                  keyAlias: body.androidKeyAlias || "upload",
                  keyPassword: body.androidKeyPassword || "",
                })
              );
            }
          } catch (e) {
            return json({ ok: false, output: `Couldn't run Signing Doctor on this file: ${(e && e.message) || e}` });
          }
          if (results.length === 0) return json({ ok: false, output: "Pass at least one of a provisioning profile or an Android keystore to check." }, 400);
          const report = formatReport(results);
          return json({ ok: true, output: report.text, failed: report.failed, warned: report.warned });
        }

        if (pathname === "/api/autopilot/checkout" && request.method === "POST") {
          // Optional secret — deploys safely even before Jackson creates the
          // real recurring Price in Stripe. See wrangler.toml's comment.
          if (!env.STRIPE_PRICE_ID_AUTOPILOT) {
            return json({ ok: false, detail: "Autopilot isn't available yet — check back soon." }, 501);
          }
          const body = await readJson(request);
          const projectId = Number(body.projectId);
          if (!projectId) return json({ ok: false, detail: "projectId is required." }, 400);
          const project = await db.getProjectById(env.DB, projectId);
          if (!project || project.buyer_id !== buyer.buyerId) return json({ ok: false, detail: "That project isn't linked to your account." }, 403);
          const existing = await db.getSubscriptionForProject(env.DB, projectId);
          if (existing && (existing.status === "active" || existing.status === "trialing")) {
            return json({ ok: false, detail: "Autopilot is already active for this project." }, 400);
          }
          const params = new URLSearchParams();
          params.set("mode", "subscription");
          params.set("line_items[0][price]", env.STRIPE_PRICE_ID_AUTOPILOT);
          params.set("line_items[0][quantity]", "1");
          params.set("success_url", `${env.PUBLIC_BASE_URL}/app/autopilot?project_id=${projectId}&session_id={CHECKOUT_SESSION_ID}`);
          params.set("cancel_url", `${env.PUBLIC_BASE_URL}/app/autopilot?project_id=${projectId}`);
          params.set("metadata[project_id]", String(projectId));
          params.set("metadata[buyer_id]", String(buyer.buyerId));
          const stripeResp = await fetch("https://api.stripe.com/v1/checkout/sessions", {
            method: "POST",
            headers: { Authorization: `Bearer ${env.STRIPE_RESTRICTED_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
            body: params.toString(),
          });
          if (!stripeResp.ok) {
            const detail = await stripeResp.text();
            return json({ ok: false, detail: `Couldn't start checkout: ${detail}` }, 502);
          }
          const checkoutSession = await stripeResp.json();
          return json({ ok: true, url: checkoutSession.url });
        }

        if (pathname === "/api/build-logs" && request.method === "GET") {
          const owner = url.searchParams.get("owner");
          const repo = url.searchParams.get("repo");
          const runId = url.searchParams.get("runId");
          if (!owner || !repo || !runId) return json({ ok: false, log: "owner, repo and runId query params are required." }, 400);
          return json(await githubApi.failedLogs(buyer.token, owner, repo, runId));
        }

        return json({ ok: false, detail: "no such endpoint" }, 404);
      }

      return new Response("Not found", { status: 404 });
    } catch (e) {
      return json({ ok: false, detail: String((e && e.message) || e) }, 500);
    }
  },

  // Twice-daily heartbeat sweep (see wrangler.toml's [triggers]). Re-checks
  // every locally-active subscription directly against Stripe (same
  // pull-based pattern as everything else in this file) and logs one
  // bot_events row per project either way, so the activity log always
  // shows Autopilot is alive even before Phase 2 gives it real actions to
  // log. Each project's iteration is wrapped in its own try/catch so one
  // bad subscription can't stop the sweep from checking the rest.
  async scheduled(event, env, ctx) {
    const subs = await db.listActiveSubscriptions(env.DB);
    for (const sub of subs) {
      try {
        const result = await fetchStripeSubscription(sub.stripe_subscription_id, env);
        if (!result.ok) {
          await db.logBotEvent(env.DB, { projectId: sub.project_id, eventType: "error", detail: "Couldn't reach Stripe to verify this subscription's status." });
          continue;
        }
        const fresh = result.subscription;
        await db.upsertSubscription(env.DB, {
          projectId: sub.project_id,
          buyerId: sub.buyer_id,
          stripeCustomerId: fresh.customer,
          stripeSubscriptionId: fresh.id,
          status: fresh.status,
          currentPeriodEnd: fresh.current_period_end ? new Date(fresh.current_period_end * 1000).toISOString() : null,
        });
        await db.logBotEvent(env.DB, { projectId: sub.project_id, eventType: "heartbeat", detail: `Checked in — status: ${fresh.status}.` });
      } catch (e) {
        await db.logBotEvent(env.DB, { projectId: sub.project_id, eventType: "error", detail: `Heartbeat sweep failed: ${(e && e.message) || e}` });
      }
    }
  },
};
