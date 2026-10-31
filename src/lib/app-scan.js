// Macless App Store risk scanner. GET /api/scan?url=https://their.app
// Reads only what the public website serves (HTML, manifest, first few JS bundles).
// It cannot see the built native app, logins, or App Store Connect, and says so.

const UA = "Mozilla/5.0 (compatible; MaclessScan/1.0; +https://macless.dev)";
const MAX_HTML = 400_000;
const MAX_JS = 450_000;
const MAX_SCRIPTS = 4;

const PLATFORMS = [
  { name: "Base44", test: (h, b) => /base44/i.test(h) || b.includes("base44.app") || b.includes("@base44/sdk") || b.includes("base44Client") },
  { name: "Lovable", test: (h, b) => /lovable\.(dev|app)|lovable-uploads|gptengineer/i.test(h + b.slice(0, 20000)) },
  { name: "Bolt", test: (h) => /bolt\.new|stackblitz/i.test(h) },
  { name: "Replit", test: (h) => /replit\.(app|dev)|\.repl\.co|replit-dev-banner/i.test(h) },
  { name: "Bubble", test: (h) => /bubble_page_load|bubbleapps\.io|bubble\.io/i.test(h) },
  { name: "v0 / Vercel", test: (h) => /v0\.(dev|app)|_vercel\/|vercel\.app/i.test(h) },
  { name: "FlutterFlow", test: (h) => /flutterflow/i.test(h) },
  { name: "Glide", test: (h) => /glideapps\.com|go\.glide\.page/i.test(h) },
  { name: "Softr", test: (h) => /softr\.io|softr\.app/i.test(h) },
  { name: "Adalo", test: (h) => /adalo\.com/i.test(h) },
  { name: "Framer", test: (h) => /framerusercontent|framer\.com\/m\//i.test(h) },
  { name: "Webflow", test: (h) => /webflow\.(com|io)|data-wf-page/i.test(h) },
  { name: "Wix", test: (h) => /wixstatic\.com|wix\.com/i.test(h) },
];

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function normalizeUrl(raw) {
  let s = String(raw || "").trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase();
  if (!host.includes(".") || host.endsWith(".local") || host.endsWith(".internal") || host === "localhost") return null;
  if (/^[\d.]+$/.test(host) || host.includes(":") || host.startsWith("[")) return null; // no IP literals
  if (u.port && u.port !== "80" && u.port !== "443") return null;
  u.hash = "";
  return u;
}

async function getText(url, max, accept) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await fetch(url, {
      headers: { "user-agent": UA, accept: accept || "*/*" },
      redirect: "follow",
      signal: ctl.signal,
    });
    const final = new URL(res.url);
    if (/^[\d.]+$/.test(final.hostname) || final.hostname === "localhost") throw new Error("redirected to a private address");
    const reader = res.body ? res.body.getReader() : null;
    let text = "";
    if (reader) {
      const dec = new TextDecoder();
      let size = 0;
      while (size < max) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        text += dec.decode(value, { stream: true });
      }
      try { await reader.cancel(); } catch {}
    } else {
      text = (await res.text()).slice(0, max);
    }
    return { ok: res.ok, status: res.status, url: res.url, type: res.headers.get("content-type") || "", text };
  } finally {
    clearTimeout(timer);
  }
}

function scriptSrcs(html, base) {
  const out = [];
  const re = /<script[^>]+src=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 12) {
    try {
      const u = new URL(m[1], base);
      if (!/\.(m?js)(\?|$)/i.test(u.pathname) && !/assets|static|chunk|bundle|index|main|app/i.test(u.pathname)) continue;
      out.push(u);
    } catch {}
  }
  // Prefer same-origin bundles, biggest-looking names first (index/main/app).
  const same = out.filter((u) => u.origin === new URL(base).origin);
  const rank = (u) => (/index|main|app/i.test(u.pathname) ? 0 : 1);
  return same.sort((a, b) => rank(a) - rank(b)).slice(0, MAX_SCRIPTS);
}

export async function scanApp(rawUrl) {
  const u = normalizeUrl(rawUrl);
  if (!u) return { error: "bad_url", message: "That doesn't look like a public web address. Try something like yourapp.base44.app." };

  let page;
  try {
    page = await getText(u.toString(), MAX_HTML, "text/html,*/*");
  } catch (e) {
    return { error: "unreachable", message: "We couldn't open that address. Check it loads in a normal browser tab, then try again." };
  }
  if (page.status === 401 || page.status === 403 || page.status === 429 || page.status === 503) {
    return { error: "blocked", message: "The site refused our scan (HTTP " + page.status + "). Some hosts block automated requests. Send us the link and we'll check it by hand.", status: page.status };
  }
  if (!page.ok) return { error: "unreachable", message: "That address returned HTTP " + page.status + ".", status: page.status };
  const html = page.text;
  if (!/<html|<!doctype|<body|<div/i.test(html)) return { error: "not_html", message: "That address didn't return a web page." };

  // Fetch manifest + a few bundles in parallel.
  const manifestHref = (html.match(/<link[^>]+rel=["']manifest["'][^>]*href=["']([^"']+)["']/i) || html.match(/<link[^>]+href=["']([^"']+)["'][^>]*rel=["']manifest["']/i) || [])[1];
  const manifestUrl = new URL(manifestHref || "/manifest.json", page.url);
  const srcs = scriptSrcs(html, page.url);
  const [manifestRes, ...bundleRes] = await Promise.all([
    getText(manifestUrl.toString(), 60_000, "application/json,*/*").catch(() => null),
    ...srcs.map((s) => getText(s.toString(), MAX_JS).catch(() => null)),
  ]);
  const bundles = bundleRes.filter((r) => r && r.ok).map((r) => r.text).join("\n");
  const all = html + "\n" + bundles;
  const bundlesRead = bundleRes.filter((r) => r && r.ok).length;

  let manifestOk = false;
  if (manifestRes && manifestRes.ok && /json|javascript|text\/plain/i.test(manifestRes.type)) {
    try { const mj = JSON.parse(manifestRes.text); manifestOk = !!(mj && (mj.name || mj.short_name)); } catch {}
  }
  const hasManifestLink = !!manifestHref;

  // ---- signals ----
  const platform = (PLATFORMS.find((p) => p.test(html, bundles)) || {}).name || null;
  const payments = [];
  if (/js\.stripe\.com|buy\.stripe\.com|checkout\.stripe\.com|loadStripe|@stripe\//.test(all)) payments.push("Stripe");
  if (/paypal\.com\/sdk|paypalobjects\.com/.test(all)) payments.push("PayPal");
  if (/paddle\.com|cdn\.paddle|lemonsqueezy\.com|lemon\.js/.test(all)) payments.push("Paddle / Lemon Squeezy");
  if (/gumroad\.com\/js|gumroad\.com\/l\//.test(all)) payments.push("Gumroad");

  const googleLogin = /accounts\.google\.com\/o\/oauth2|accounts\.google\.com\/gsi|signInWithGoogle|google[-_ ]?oauth|\/auth\/google|provider=google/i.test(all);
  const appleLogin = /appleid\.apple\.com|signInWithApple|sign in with apple|apple-signin/i.test(all);
  const otherSocial = /facebook\.com\/v\d+\.\d+\/dialog\/oauth|github\.com\/login\/oauth|signInWithPopup|loginWithPopup/.test(all);
  const redirectLogin = /redirectToLogin|loginWithRedirect|signInWithRedirect|\/oauth\/authorize|\/auth\/login\?.*redirect/i.test(all);
  const hasAuth = googleLogin || appleLogin || otherSocial || redirectLogin || /type=["']password["']|sign.?up|create (an )?account|register/i.test(html);
  const deleteAccount = /delete[\s_-]?account|deleteAccount|delete[\s_-]?my[\s_-]?(account|data)|remove[\s_-]?account/i.test(all);
  const geo = /navigator\.geolocation|getCurrentPosition|watchPosition/.test(all);
  const camera = /getUserMedia|capture=["']|type=["']file["'][^>]*accept=["'][^"']*image/i.test(all);
  const mic = /getUserMedia\(\{[^}]*audio|MediaRecorder/.test(all);
  const swRegister = /serviceWorker\.register|navigator\.serviceWorker/.test(all);
  const viewport = /<meta[^>]+name=["']viewport["'][^>]+content=["'][^"']*width=device-width/i.test(html);
  const safeArea = /viewport-fit=cover|safe-area-inset/i.test(all);
  const privacyLink = /href=["'][^"']*(privacy|terms)[^"']*["']/i.test(html) || /privacy[\s-]?policy/i.test(html);

  const F = [];
  const add = (status, id, title, detail, guideline) => F.push({ status, id, title, detail, guideline: guideline || null });

  if (payments.length) {
    add("fail", "payments", payments.join(" / ") + " checkout found",
      "If this sells subscriptions, credits, or anything digital that's used inside the app, Apple requires its own In-App Purchase instead. Linking out to a web checkout inside an iOS app is a common rejection. Physical goods and services delivered outside the app are exempt.",
      "3.1.1");
  } else {
    add("pass", "payments", "No web checkout found", "We didn't see Stripe, PayPal or similar payment code in what the site serves.");
  }

  if (googleLogin) {
    add("fail", "google-login", "Google sign-in found",
      "Google blocks its sign-in screen inside embedded app browsers, so a wrapped app can fail at login. It has to be routed through the native flow or replaced. Apple also expects Sign in with Apple to be offered alongside other social logins.",
      "4.8");
  }
  if ((googleLogin || otherSocial) && !appleLogin) {
    add("warn", "apple-signin", "No Sign in with Apple",
      "Apps that offer Google or other social sign-in generally need an equivalent privacy-preserving option, and Sign in with Apple is the usual one.", "4.8");
  }
  if (redirectLogin && !googleLogin) {
    add("warn", "redirect-login", "Sign-in leaves your app",
      "The login looks like it redirects to another address. Inside a wrapped app that redirect often doesn't come back, leaving people stuck on a login page.", "2.1");
  }
  if (hasAuth && !deleteAccount) {
    add("warn", "delete-account", "No way to delete an account found",
      "Apps that let people create accounts must let them delete the account from inside the app. We didn't find it in the code we can read, so check that your app has it.", "5.1.1(v)");
  } else if (hasAuth && deleteAccount) {
    add("pass", "delete-account", "Account deletion looks present", "We found account-deletion code.");
  }

  if (!hasManifestLink && !manifestOk) {
    add("warn", "manifest", "No web manifest",
      "There's no web app manifest, so the app has no declared name, icon or colors. It isn't a rejection by itself, but it's a sign the site hasn't been prepared as an app.");
  } else if (!manifestOk) {
    add("warn", "manifest", "Web manifest is linked but unreadable", "The manifest link doesn't return a valid manifest with a name.");
  } else {
    add("pass", "manifest", "Web manifest present", "The app declares its name and icons.");
  }

  if (!swRegister) {
    add("warn", "offline", "No offline handling found",
      "We didn't find a service worker. If the app shows a blank screen or a browser-style error with no connection, reviewers tend to read that as a plain website in a wrapper.", "4.2");
  } else {
    add("pass", "offline", "Offline code present", "A service worker is registered.");
  }

  if (!viewport) {
    add("fail", "viewport", "Not set up for phone screens", "There's no mobile viewport tag, so the app will render as a shrunken desktop page.", "4.2");
  } else if (!safeArea) {
    add("warn", "safe-area", "No notch / safe-area handling found",
      "We didn't see viewport-fit=cover or safe-area padding. Content can slide under the notch and home bar on newer iPhones.");
  } else {
    add("pass", "viewport", "Phone layout and safe areas handled", "Mobile viewport and safe-area rules are present.");
  }

  const perms = [];
  if (geo) perms.push("location");
  if (camera) perms.push("camera / photos");
  if (mic) perms.push("microphone");
  if (perms.length) {
    add("warn", "permissions", "Uses " + perms.join(", "),
      "The native app needs a plain-language reason for each of these in its settings file, or the upload is rejected before review even starts.", "5.1.1");
  }

  if (!privacyLink) {
    add("warn", "privacy", "No privacy policy link on the page", "Both stores require a privacy policy link. We didn't see one on this page.", "5.1.1");
  } else {
    add("pass", "privacy", "Privacy / terms link found", "A privacy or terms link is on the page.");
  }

  const fails = F.filter((f) => f.status === "fail").length;
  const warns = F.filter((f) => f.status === "warn").length;
  const risks = fails + warns;
  const level = fails >= 2 || (fails >= 1 && warns >= 2) ? "high" : fails >= 1 || warns >= 3 ? "medium" : "low";

  return {
    ok: true,
    url: page.url,
    host: new URL(page.url).hostname,
    platform,
    level,
    fails, warns, passes: F.length - risks,
    findings: F.sort((a, b) => ({ fail: 0, warn: 1, pass: 2 }[a.status] - { fail: 0, warn: 1, pass: 2 }[b.status])),
    cantSee: [
      "Whether your app has a demo login for the reviewer (Apple requires one if sign-in is needed)",
      "What the app does behind your login",
      "Tab bar, splash screen and native touches, which only exist in the built app",
      "How the app looks and behaves on a real phone",
    ],
    scanned: { bundlesRead, manifest: manifestOk },
  };
}

export async function handleScan(request, env) {
  const reqUrl = new URL(request.url);
  const target = reqUrl.searchParams.get("url");
  if (request.method !== "GET") return json({ error: "method", message: "Use GET." }, 405);
  if (!target) return json({ error: "bad_url", message: "Add a web address to scan." }, 400);

  const key = new Request("https://macless.dev/api/scan-cache?u=" + encodeURIComponent((normalizeUrl(target) || { href: target }).href));
  const cache = typeof caches !== "undefined" ? caches.default : null;
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return new Response(hit.body, hit);
  }
  let result;
  try {
    result = await scanApp(target);
  } catch (e) {
    return json({ error: "failed", message: "The scan hit an unexpected problem. Try again, or send us the link." }, 500);
  }
  const status = result.error ? (result.error === "bad_url" ? 400 : 200) : 200;
  const res = json(result, status);
  if (cache && result.ok) {
    const copy = new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=600" } });
    try { await cache.put(key, copy); } catch {}
  }
  return res;
}
