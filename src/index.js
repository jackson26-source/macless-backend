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

function productMap(env) {
  return {
    [env.STRIPE_PRICE_ID_IOS]: { key: "ios", label: "Macless — iOS" },
    [env.STRIPE_PRICE_ID_ANDROID]: { key: "android", label: "Macless — Android" },
  };
}

async function verifyStripeSession(sessionId, env) {
  const resp = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=line_items`, {
    headers: { Authorization: `Bearer ${env.STRIPE_RESTRICTED_KEY}` },
  });
  if (!resp.ok) return { ok: false };
  const session = await resp.json();
  if (session.payment_status !== "paid") return { ok: false, reason: "unpaid" };
  const priceId = session.line_items?.data?.[0]?.price?.id;
  const product = productMap(env)[priceId];
  if (!product) return { ok: false, reason: "unknown-product" };
  return { ok: true, product, email: session.customer_details?.email || session.customer_email || null };
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
};
