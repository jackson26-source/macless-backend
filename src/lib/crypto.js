// crypto.js — two separate jobs, both using Workers' native Web Crypto
// (SubtleCrypto), no external dependencies:
//
// 1. Encrypting each buyer's GitHub token at rest in D1 (AES-GCM). The
//    desktop app could lean on the OS keychain for this; a server has to
//    do it itself. The key is a Worker secret (env.TOKEN_ENCRYPTION_KEY)
//    Jackson generates and pastes in — never hardcoded, never logged.
// 2. Signing the session cookie (HMAC-SHA256) so a buyer can't forge
//    "I'm buyer #4" by hand-editing their own cookie. This is a stateless
//    signed cookie, not a server-side session table — simpler, and
//    perfectly fine for what this app needs (no server-side revocation
//    list beyond "buyer re-authenticates").

async function importAesKey(base64Key) {
  const raw = Uint8Array.from(atob(base64Key), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encryptToken(plaintext, base64Key) {
  const key = await importAesKey(base64Key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder().encode(plaintext);
  const cipherBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc);
  const combined = new Uint8Array(iv.length + cipherBuf.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(cipherBuf), iv.length);
  return btoa(String.fromCharCode(...combined));
}

async function decryptToken(encoded, base64Key) {
  const key = await importAesKey(base64Key);
  const combined = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const cipherBytes = combined.slice(12);
  const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipherBytes);
  return new TextDecoder().decode(plainBuf);
}

async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

// Signed values carry their own issued-at timestamp and are rejected past
// maxAgeSeconds, checked server-side on every verify — not just relying on
// the cookie's client-side Max-Age. Without this, a leaked cookie value
// (or a leaked OAuth `state`) would be a bearer credential valid forever,
// since only the browser — not the server — was ever enforcing an
// expiry. Default (30 days) matches the session cookie's own Max-Age;
// callers signing/verifying the short-lived OAuth `state` param pass a
// much smaller maxAgeSeconds instead (see index.js).
const DEFAULT_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

async function signSession(buyerId, secret) {
  const key = await hmacKey(secret);
  const payload = String(buyerId);
  const issuedAt = String(Math.floor(Date.now() / 1000));
  const body = `${payload}.${issuedAt}`;
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const sig = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));
  return `${body}.${sig}`;
}

/** Returns the signed payload (a string) if the value's signature is valid AND it's younger than maxAgeSeconds, otherwise null. */
async function verifySession(cookieValue, secret, maxAgeSeconds = DEFAULT_MAX_AGE_SECONDS) {
  if (!cookieValue) return null;
  const parts = cookieValue.split(".");
  if (parts.length !== 3) return null;
  const [payload, issuedAtStr, sig] = parts;
  const issuedAt = Number(issuedAtStr);
  if (!Number.isFinite(issuedAt)) return null;
  const body = `${payload}.${issuedAtStr}`;
  const key = await hmacKey(secret);
  const expectedBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const expected = btoa(String.fromCharCode(...new Uint8Array(expectedBuf)));
  // Constant-time-ish comparison — short strings, but avoid the obvious
  // early-exit `===` timing tell anyway since this guards real auth.
  if (expected.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff !== 0) return null;
  const now = Math.floor(Date.now() / 1000);
  if (now - issuedAt > maxAgeSeconds || now - issuedAt < -60) return null; // small negative-skew allowance for clock drift
  return payload;
}

export { encryptToken, decryptToken, signSession, verifySession };
