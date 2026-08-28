# Deploying macless-backend

This is the hosted version of Macless: a buyer pays on Stripe, connects
their GitHub account in the browser (GitHub's own login page — nothing
typed into anything Macless-owned), picks or creates a repo, and runs the
whole pipeline wizard from a web page. No zip, no terminal, no desktop
app required. It runs as a Cloudflare Worker + D1 (SQLite) database on
your existing Cloudflare/macless.dev setup.

**Every credential below is something you generate and paste in
yourself** — `wrangler secret put`, never a value typed into this repo or
into any Claude session. That's a hard rule I'm following, not a
suggestion.

## 0. Decide what this replaces

**Important — read this before deploying.** The `macless-download-worker`
you already have deployed is *also* routed on `macless.dev/get-started`.
Two Workers can't both own the identical route on one zone. This new
backend's `/get-started` is a strict upgrade over the old one (same
Stripe verification, but the next step is "connect & build in your
browser" instead of "here's a zip") — so the intended move is:

1. Deploy this backend (steps below).
2. In the Cloudflare dashboard, remove the `macless.dev/get-started`
   route from `macless-download-worker` (Workers & Pages → macless-download
   → Settings → Triggers → Routes). Leave `macless.dev/download` alone if
   you still want it reachable directly, or remove it too — nothing
   links to it once `/get-started` no longer points there.
3. Update your Stripe Payment Links' after-payment redirect to
   `https://macless.dev/get-started?session_id={CHECKOUT_SESSION_ID}` if
   it isn't already (it should already be this exact URL from the
   download-worker setup — same URL, new destination).

You now have three ways a buyer can end up building their app: the old
zip download (if you keep it reachable some other way), the desktop app
(`macless-app`), and this hosted flow. This backend is the one that
actually matches what you asked for — zero download, zero terminal — so
I'd make it the default Stripe redirect and keep the desktop app as a
fallback for anyone who'd rather have a native app. Your call.

## 1. Cloudflare D1 database — already done

The `macless-backend` D1 database already exists in your Cloudflare
account (created 2026-08-25 via the dashboard, in the same account as
macless.dev's DNS), and the full schema from `migrations/0001_init.sql`
is already applied and verified live — `purchases`, `buyers`, and
`projects` all exist, confirmed by querying `sqlite_master` in the D1
console. `wrangler.toml`'s `database_id` in this zip already points at
the real database, not a placeholder. Nothing to do here — skip
straight to step 2. (If you ever need to re-verify or inspect it by
hand: Cloudflare dashboard → Workers & Pages → D1 SQLite Database →
macless-backend → Console.)

## 2. GitHub OAuth App (web flow, needs a client secret)

If you already made an OAuth App for the desktop app
(`macless-app`'s device flow), **you can reuse the same one** — a single
GitHub OAuth App supports both device flow and the standard web flow at
once; they don't conflict. Just grab that same app's Client ID, and this
time also copy its **Client Secret** (desktop app didn't need it; this
does — it's the whole reason the backend has to be a server instead of a
distributed binary).

If you haven't made one yet: GitHub → Settings → Developer settings →
OAuth Apps → New OAuth App.
- **Homepage URL**: `https://macless.dev`
- **Authorization callback URL**: `https://macless.dev/oauth/callback`
- Generate a client secret on the same page.

## 3. Generate the two backend-only secrets

```
# 32 random bytes, base64 — the AES-256 key that encrypts buyers' GitHub tokens at rest
openssl rand -base64 32

# any long random string — signs session cookies and the OAuth state param
openssl rand -base64 32
```

## 4. Stripe restricted key + price IDs

Same restricted key and price IDs you already created for
`macless-download-worker` — reuse them, no need to make new ones. If you
need to check them again: Stripe dashboard → Developers → API keys (for
the restricted key) and Products (for the two Price IDs).

## 5. Set all seven secrets

```
wrangler secret put STRIPE_RESTRICTED_KEY
wrangler secret put STRIPE_PRICE_ID_IOS
wrangler secret put STRIPE_PRICE_ID_ANDROID
wrangler secret put GITHUB_CLIENT_ID
wrangler secret put GITHUB_CLIENT_SECRET
wrangler secret put TOKEN_ENCRYPTION_KEY
wrangler secret put SESSION_SECRET
```

(`PUBLIC_BASE_URL` is already set as a plain var in `wrangler.toml` —
not secret, no need to set it again.)

## 6. Deploy

```
npm install
npm run deploy
```

`npm run deploy` runs two build steps first
(`scripts/build-template.js` and `scripts/build-public.js`) that embed
the product template and the wizard's HTML/CSS/JS into the Worker bundle
— Workers have no filesystem at runtime, so these can't be read off disk
the way the desktop app reads its `template/` folder. **Re-run `npm run
build` (or just `npm run deploy`, which includes it) any time you change
anything under `template/` or `public/`** — those generated files are
gitignored on purpose, so a stale build never gets committed by
accident.

## 7. Test it

Use Stripe's test mode, walk through a real Payment Link, and confirm:
`/get-started` shows the Connect GitHub page → GitHub's real OAuth
consent screen appears → you land back on `/app` signed in → the repo
picker lists your real repos → connecting either an existing repo or a
new one actually commits the template files (check the repo on GitHub)
→ the scan step finds the real secrets → pushing a secret actually shows
up in that repo's Settings → Secrets and variables → Actions → triggering
a build actually starts a run.

## Security hardening pass — 2026-08-25

A full read-through of `index.js`, `crypto.js`, `db.js`, and
`github-api.js` before going live turned up one real gap, now fixed:

**Session cookies and the OAuth `state` param had no server-side
expiry.** The signature proved the value hadn't been tampered with,
but nothing checked *when* it was issued — so a leaked session cookie
(which carries a live GitHub token with `repo` scope) would have been
a valid credential forever, not just until the cookie's client-side
`Max-Age` ran out (which an attacker replaying the raw value ignores
entirely). Fixed: every signed value now embeds its own issued-at
timestamp, checked server-side on every verify. Session cookies keep
their 30-day window (matching the existing cookie `Max-Age`); the
OAuth `state` param — a CSRF nonce that should only live as long as
the GitHub sign-in round-trip — now expires after 10 minutes instead
of being valid indefinitely.

Also added: a sanity size cap on `/api/diagnose-signing` (rejects
base64 input over ~375KB — real profiles/certs/keystores are a few KB
to tens of KB, so anything bigger is either a mistake or someone
trying to burn CPU time) and on `/api/diagnose-rejection`'s pasted
text (20,000 chars), since that endpoint deliberately has no auth
requirement.

Everything else held up: all SQL goes through parameterized `.bind()`
calls (no injection surface), GitHub tokens are AES-GCM encrypted at
rest with a random IV per encryption, the OAuth `state` is HMAC-signed
and checked, cookies are `HttpOnly` + `Secure` + `SameSite=Lax` (which
blocks cross-site POST from carrying the cookie at all — no separate
CSRF token needed on top of that), Stripe's payment status and price
ID are re-verified server-side on every purchase-linked request rather
than trusted from the client, and there's no reflected/stored XSS
surface (every server-rendered HTML string uses fixed template text,
never user-supplied values). One real residual worth knowing about
rather than a bug to fix: the GitHub OAuth scope is `repo` (full
read/write on all of a buyer's repos, public and private), not scoped
to just the one repo they connect — that's a GitHub OAuth App
limitation (fine-grained per-repo scoping needs a different, more
friction-heavy flow), so buyers are trusting Macless with broader
access than the app strictly uses. Worth saying plainly in the
"Connect GitHub" copy if it isn't already.

## Closing the loop — diagnose, fix, resubmit as one motion

Per the standing competitor research (`claude/macless-competitor-feature-research-2026-08-23.md` in the project, item #1 in its prioritized list): no competitor combines an owned build pipeline with real diagnosis in one place, because none of them own both. This wizard now does, in three places:

- **Signing setup step:** after running Signing Doctor on the cert/profile/keystore fields you just filled in, a **Rebuild now** button appears — jumps straight to the build step and triggers it, no need to walk back through the wizard once you've fixed something.
- **Build step, on failure:** instead of a static "double-check your signing file" hint, it now automatically re-runs Signing Doctor against whatever's currently in the Signing setup fields and shows the real result right next to the failed build's logs — the actual diagnosis, not a guess. A **Rebuild now** button sits right below it either way (success or failure), so retrying is always one click, not a trip to GitHub's Actions tab.
- **Rejection Doctor step:** once a rejection message matches a known category, a **Rebuild now** button appears there too, for when the fix was code/config already pushed to the repo — confirm it without leaving the page.

All three reuse the same `/api/diagnose-signing` and `/api/trigger-build`/`/api/build-status`/`/api/build-logs` endpoints already shipped — no new backend routes, no new security surface, purely wiring the wizard's existing tools together instead of leaving them as three disconnected steps.

**Verified in a real browser**, not just read through: a Playwright-driven headless Chromium session loaded the actual `public/index.html` + `public/wizard.js`, uploaded real file inputs through real `FileReader`, and walked the entire buyer journey end to end — connect → scan → fill in a profile/cert and get a real Signing Doctor check with the Rebuild button appearing → push secrets → trigger a build → watch it "fail" (mocked) → confirm Signing Doctor auto-ran and showed the failure → click Rebuild now → confirm a second build actually got triggered and showed "success" → Rejection Doctor match → confirm its Rebuild button appeared too. All 7 checkpoints passed.

## Rejection Doctor expanded to 57 categories, plus an appeal-letter draft — 2026-08-25

Per item #2 of the same competitor research: `rejection-doctor.js`'s `CATEGORIES` list grew from 19 to 57, adding real coverage across all five App Review Guideline sections (Safety, Performance, Business, Design, Legal) — pulled from Apple's own published guideline index, not copied from any competitor's tool. Still short of the ~130-subsection full count a couple of free OSS competitors claim, but now covers the realistic set an indie iOS/Android shipper actually hits rather than every Mac-sandboxing/ARKit/cryptocurrency-exchange edge case — see the "Expanded 2026-08-25" comment block in `src/lib/rejection-doctor.js` for the reasoning on what was deliberately left out.

Also new: `generateAppealLetter()`, a deterministic (not LLM-generated) Resolution Center reply template keyed to whatever category matched — every sentence in it traces back to the guideline and fix already shown to the buyer, so there's nothing it could get factually wrong that Rejection Doctor's own matching didn't already show. Exposed as `POST /api/appeal-letter` (unauthenticated, same zero-hosting-cost shape as `/api/diagnose-rejection`, small size caps on the buyer-typed `appName`/`buildNumber` fields), and wired into the wizard's Rejection Doctor step as a "Draft Resolution Center reply" button under each match.

**One thing that needs manual attention:** `rejection-doctor.js`'s own header comment notes it's a server-side port of macless.dev's client-side Rejection Doctor (the free web tool at macless.dev/rejection-doctor.html), kept in sync by hand rather than by shared code, since the wizard has to work without depending on any Macless-hosted endpoint. This sandbox doesn't have the `macless-site` repo checked out, so the 38 new categories exist here but **not yet on the live rejection-doctor.html page** — copy the updated `CATEGORIES` array (and the new `generateAppealLetter` function, if the free web tool should get the appeal-letter button too) over to that repo separately.

## macless-doctor — the diagnosis tools as a free, zero-cost installable Skill — 2026-08-25

Per item #3 of the competitor research (and sharpened by a same-day refresh — `claude/macless-competitor-research-refresh-2026-08-25.md` — that found the free agent-native rejection-help space getting more crowded, not less, since Aug 23): Signing Doctor, the now-57-category Rejection Doctor, and a rebuild-loop are packaged as `macless-doctor`, an installable Skill for Claude Code/Cursor/any agent tool that supports the format. Delivered separately as `macless-doctor-skill.skill`, not inside this zip — it's a standalone product surface, not part of the hosted backend.

Deliberately architected with **zero ongoing cost to Macless, no matter how many buyers install it or how often they use it**: the signing-diagnosis code is the exact same zero-dependency `der.js`/`x509.js`/`pkcs12.js`/`cms.js`/`plist.js`/`signing-doctor.js` files from this repo, copied as-is (they were already pure JS + native Web Crypto, no Workers-specific API used), running as plain Node CLI scripts on the buyer's own machine. The rebuild-loop step doesn't call Macless at all — it shells out to the buyer's own already-authenticated `gh` CLI (`gh workflow run`, `gh run watch`, `gh run view --log-failed`). Nothing here touches a Macless-hosted endpoint, so there's no metering, no hosting bill, and no account/session needed to use it.

Tested against the same real Apple-issued fixture used to close Signing Doctor's own real-fixture gap (`throwaway-fixture/real.mobileprovision` + `real-cert.p12`), run from a **freshly unzipped copy** of the packaged `.skill` file (not just in place in the build directory) to confirm the packaging itself works, not just the source. Rejection Doctor's CLI was spot-checked against 7 realistic rejection message samples across the newly-added categories, including the `--appeal` flag's letter draft. Requires Node.js 19+ (for `crypto.subtle` as a global) — noted explicitly in the Skill's own `SKILL.md` since that's the one environment assumption that could silently fail on an older Node.

## What's tested vs. not

Every library function (`db.js`, `crypto.js`, `github-api.js`,
`workflow-scan.js`) and the full request router (`index.js`) has
real unit/integration tests run against mocked D1, Stripe, and GitHub
responses — 40+ assertions covering the whole buyer journey: unpaid/
unknown-product rejections, purchase idempotency, OAuth state
tampering, session cookie auth (including logout and 401s on every
protected route), connecting to both an existing repo (confirmed it
only adds *missing* files, never overwrites what's already there) and a
brand-new one, scanning real-shaped workflow YAML, pushing secrets and
variables, triggering a build, and reading back failed-run logs — plus
a follow-up regression pass (9 more assertions) confirming the session-
expiry hardening above didn't break the normal, non-expired path
through the same journey, and that both new size caps actually reject
oversized input while leaving everything else untouched, and a further
router-level pass (5 more assertions) for the Rejection Doctor
expansion and the new `/api/appeal-letter` endpoint specifically —
confirming a new-category match resolves correctly through the actual
router (not just the library function directly), the appeal-letter
happy path, its 400 on a missing/malformed match, that it's reachable
without a session cookie by design, and that oversized `appName`/
`buildNumber` get clamped rather than rejected or crashing. The full
regression suite (crypto expiry, router smoke, rejection expansion,
real-fixture signing, and the Playwright wizard-UI run) was re-run
together after today's changes and every check still passes.

**Not tested, because this sandbox has no live network out to GitHub,
Stripe, or npm's registry**: an actual OAuth round-trip against real
GitHub, an actual Stripe Checkout session, an actual `wrangler deploy`,
and `libsodium-wrappers` actually loading (it isn't installed here —
`npm install` couldn't reach the registry — but the code path that
handles it being *missing* is tested and fails cleanly rather than
throwing; once you `npm install` for real it'll just work, same as it
does in `macless-app`).

## Signing Doctor now runs inline, in the Worker — no VM

Earlier drafts of this doc said inline signing validation would need a
small always-on VM alongside the Workers, since `security`/PlistBuddy/
keytool/openssl can't run in a Workers sandbox. That turned out to be
solvable without one: `src/lib/{der,x509,pkcs12,cms,plist,signing-doctor}.js`
is a from-scratch, zero-dependency reimplementation of everything
`signing-doctor.sh` checks — provisioning profile decode, cert/profile
fingerprint pairing (the check the shell script's own comments call the
single hardest-to-diagnose signing failure), Team ID/bundle ID/expiry
checks, and the Android keystore equivalent — built entirely on Web
Crypto (PBKDF2, AES-CBC, SHA-1/SHA-256), which Workers has natively. No
library, no VM, no added hosting cost.

Every layer of it was verified against **real cryptographic fixtures**
generated with the actual tools this replaces (a real `keytool
-genkeypair` keystore, a real `openssl pkcs12 -export` certificate) —
subject, expiry, and SHA-1 fingerprint all matched `openssl`'s own
output exactly. One real bug was caught this way before it ever shipped:
modern PKCS#12 containers (the default from both current `keytool` and
`openssl` — confirmed against both) turned out to use plain UTF-8
passwords, not the legacy BMPString+NUL encoding some older references
describe; decrypting with the wrong encoding failed cleanly in testing,
which is how it was caught. Both a correctly-paired cert/profile and a
deliberately mismatched one were verified to produce the right OK/FAIL
result.

**Update, same day:** that gap is now closed. Ran a real, disposable
Apple App ID (`com.macless.testfixture`), a real Apple-issued
distribution certificate, and a real Apple-issued, Apple-signed
`.mobileprovision` (downloaded straight from developer.apple.com, not
hand-built with `openssl cms -sign` like the earlier stand-in) through
the actual `diagnoseIosProfile()` code path — five scenarios: matching
pair, wrong Team ID, wrong bundle ID, wrong cert password, and
profile-only. All five produced exactly the expected OK/FAIL result.
This also exercised the CMS parser against Apple's real signing chain
(WWDR → Apple System Integration CA 4 → the profile-signing cert) for
the first time, not the single self-signed layer the synthetic fixture
used — it parsed cleanly with no changes needed. The throwaway App
ID/cert/profile should still be revoked/deleted from the Apple
Developer account as cleanup once you're done poking at it (Certificates,
Identifiers & Profiles → delete the "Macless Test Fixture" App ID,
revoke the matching certificate, delete the profile) — none of it is
needed for anything real.
