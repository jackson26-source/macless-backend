// asc-auto-provision.js
//
// Customer-facing orchestration: given a buyer's own App Store Connect API
// key (Key ID + Issuer ID + .p8 PEM, never persisted anywhere — held only
// for the duration of this one request), mints a fresh iOS Distribution
// certificate, a matching App Store provisioning profile, and packages
// both into a ready-to-use .p12 the wizard can push straight into the
// buyer's GitHub Actions secrets — replacing the manual "go generate a
// cert/profile/p12 yourself in Apple's portal" step entirely.
//
// Zero external dependencies (Web Crypto + fetch only), matching this
// project's existing zero-dependency posture (see pkcs12.js/der.js, the
// *reader* half of this same format).
//
// Built and verified 2026-08-28:
//  - JWT signing (buildAscToken) and CSR building (buildCsr) were each
//    tested locally against OpenSSL (17/17 structural checks) AND against
//    Jackson's real Apple Developer account across all three phases
//    (read-only diagnosis, bundle ID + profile creation, certificate
//    creation) before this file existed.
//  - The PKCS#12 writer (buildP12) below was independently verified with
//    9 OpenSSL checks (including a wrong-password rejection test proving
//    the encryption/MAC are real, not just structurally present) and
//    round-tripped through this project's own pkcs12.js reader.
//  - NOT yet verified: this exact end-to-end orchestration function
//    (createCertificate -> findOrCreateBundleId -> createProfile ->
//    buildP12, all in one request) has not itself been run against
//    Apple's live API — only its individual pieces have been. The first
//    real run through the actual wizard is the real-fixture test for
//    this file specifically.

const ASC_BASE = "https://api.appstoreconnect.apple.com/v1";
const ASC_AUDIENCE = "appstoreconnect-v1";
const MAX_TOKEN_LIFETIME_SECONDS = 1199; // Apple's hard cap is 1200s

// ---------------- shared byte/base64 helpers ----------------

function base64UrlEncode(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function utf8ToBytes(str) {
  return new TextEncoder().encode(str);
}

function pemToDer(pem) {
  const base64 = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  return base64ToBytes(base64);
}

// ---------------- JWT (ES256) ----------------

async function importAscPrivateKey(p8Pem) {
  const der = pemToDer(p8Pem);
  return crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

async function buildAscToken(p8Pem, keyId, issuerId) {
  const key = await importAscPrivateKey(p8Pem);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "ES256", kid: keyId, typ: "JWT" };
  const payload = { iss: issuerId, iat: now, exp: now + MAX_TOKEN_LIFETIME_SECONDS, aud: ASC_AUDIENCE };
  const encodedHeader = base64UrlEncode(utf8ToBytes(JSON.stringify(header)));
  const encodedPayload = base64UrlEncode(utf8ToBytes(JSON.stringify(payload)));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8ToBytes(signingInput));
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

// ---------------- DER encoding (shared by CSR + PKCS#12) ----------------

function concatBytes(chunks) {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

function derLength(len) {
  if (len < 0x80) return Uint8Array.of(len);
  const bytes = [];
  let n = len;
  while (n > 0) { bytes.unshift(n & 0xff); n = Math.floor(n / 256); }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function tlv(tag, content) {
  return concatBytes([Uint8Array.of(tag), derLength(content.length), content]);
}

const derSequence = (...parts) => tlv(0x30, concatBytes(parts));
const derSet = (...parts) => tlv(0x31, concatBytes(parts));
const derOctetString = (bytes) => tlv(0x04, bytes);
const derNull = () => Uint8Array.of(0x05, 0x00);
const derUtf8String = (str) => tlv(0x0c, utf8ToBytes(str));
const derBitString = (bytes, unusedBits = 0) => tlv(0x03, concatBytes([Uint8Array.of(unusedBits), bytes]));
const derExplicit = (tagNum, content) => tlv(0xa0 | tagNum, content);
const derContextPrimitive = (tagNum, bytes) => tlv(0x80 | tagNum, bytes);

function derInteger(value) {
  let bytes;
  if (value instanceof Uint8Array) {
    bytes = value;
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0 && (bytes[i + 1] & 0x80) === 0) i++;
    bytes = bytes.slice(i);
    if (bytes.length === 0) bytes = Uint8Array.of(0);
  } else {
    if (value === 0) bytes = Uint8Array.of(0);
    else {
      const arr = [];
      let n = value;
      while (n > 0) { arr.unshift(n & 0xff); n = Math.floor(n / 256); }
      bytes = Uint8Array.from(arr);
    }
  }
  if (bytes[0] & 0x80) {
    const padded = new Uint8Array(bytes.length + 1);
    padded.set(bytes, 1);
    bytes = padded;
  }
  return tlv(0x02, bytes);
}

function derOid(dotted) {
  const parts = dotted.split(".").map(Number);
  const bytes = [parts[0] * 40 + parts[1]];
  for (let i = 2; i < parts.length; i++) {
    let v = parts[i];
    const chunk = [v & 0x7f];
    v = Math.floor(v / 128);
    while (v > 0) { chunk.unshift((v & 0x7f) | 0x80); v = Math.floor(v / 128); }
    bytes.push(...chunk);
  }
  return tlv(0x06, Uint8Array.from(bytes));
}

// ---------------- PKCS#10 CSR ----------------

const OID_COMMON_NAME = "2.5.4.3";
const OID_SHA256_WITH_RSA = "1.2.840.113549.1.1.11";

function buildSubjectName(commonName) {
  const atv = derSequence(derOid(OID_COMMON_NAME), derUtf8String(commonName));
  return derSequence(derSet(atv));
}

function derToPem(der, label) {
  const b64 = bytesToBase64(der);
  const lines = b64.match(/.{1,64}/g) || [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

async function buildCsr(commonName) {
  const { publicKey, privateKey } = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  );
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", publicKey));
  const subject = buildSubjectName(commonName);
  const attributes = derExplicit(0, new Uint8Array(0)); // empty [0] Attributes

  const certificationRequestInfo = derSequence(derInteger(0), subject, spki, attributes);
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, privateKey, certificationRequestInfo)
  );
  const signatureAlgorithm = derSequence(derOid(OID_SHA256_WITH_RSA), derNull());
  const csrDer = derSequence(certificationRequestInfo, signatureAlgorithm, derBitString(signature));
  const privateKeyPkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", privateKey));

  return { csrBase64: bytesToBase64(csrDer), privateKeyPkcs8 };
}

// ---------------- PKCS#12 writer ----------------
// Verified 2026-08-28 against OpenSSL (9 checks incl. wrong-password
// rejection) and against this project's own pkcs12.js reader.

const P12_OID = {
  data: "1.2.840.113549.1.7.1",
  encryptedData: "1.2.840.113549.1.7.6",
  pbes2: "1.2.840.113549.1.5.13",
  pbkdf2: "1.2.840.113549.1.5.12",
  hmacWithSHA256: "1.2.840.113549.2.9",
  aes256CbcPad: "2.16.840.1.101.3.4.1.42",
  certBag: "1.2.840.113549.1.12.10.1.3",
  x509Certificate: "1.2.840.113549.1.9.22.1",
  pkcs8ShroudedKeyBag: "1.2.840.113549.1.12.10.1.2",
  localKeyId: "1.2.840.113549.1.9.21",
  sha1: "1.3.14.3.2.26",
};

async function sha1(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
}

function algPBKDF2(salt, iterations) {
  return derSequence(
    derOid(P12_OID.pbkdf2),
    derSequence(derOctetString(salt), derInteger(iterations), derSequence(derOid(P12_OID.hmacWithSHA256), derNull()))
  );
}

function algAES256CBC(iv) {
  return derSequence(derOid(P12_OID.aes256CbcPad), derOctetString(iv));
}

function algPBES2(salt, iterations, iv) {
  return derSequence(derOid(P12_OID.pbes2), derSequence(algPBKDF2(salt, iterations), algAES256CBC(iv)));
}

async function pbes2Encrypt(password, plaintext, iterations) {
  const salt = crypto.getRandomValues(new Uint8Array(8));
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const passwordBytes = utf8ToBytes(password);
  const keyMaterial = await crypto.subtle.importKey("raw", passwordBytes, "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-CBC", length: 256 },
    true,
    ["encrypt"]
  );
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv }, key, plaintext));
  return { ciphertext, algId: algPBES2(salt, iterations, iv) };
}

function attrSet(localKeyId) {
  return derSet(derSequence(derOid(P12_OID.localKeyId), derSet(derOctetString(localKeyId))));
}

function buildCertSafeBag(certificateDer, localKeyId) {
  const certBag = derSequence(derOid(P12_OID.x509Certificate), derExplicit(0, derOctetString(certificateDer)));
  return derSequence(derOid(P12_OID.certBag), derExplicit(0, certBag), attrSet(localKeyId));
}

async function buildKeySafeBag(privateKeyPkcs8, password, localKeyId, iterations) {
  const { ciphertext, algId } = await pbes2Encrypt(password, privateKeyPkcs8, iterations);
  const encryptedPrivateKeyInfo = derSequence(algId, derOctetString(ciphertext));
  return derSequence(derOid(P12_OID.pkcs8ShroudedKeyBag), derExplicit(0, encryptedPrivateKeyInfo), attrSet(localKeyId));
}

function contentInfoData(innerDer) {
  return derSequence(derOid(P12_OID.data), derExplicit(0, derOctetString(innerDer)));
}

async function contentInfoEncryptedData(plaintextSafeContentsDer, password, iterations) {
  const { ciphertext, algId } = await pbes2Encrypt(password, plaintextSafeContentsDer, iterations);
  const encryptedContentInfo = derSequence(derOid(P12_OID.data), algId, derContextPrimitive(0, ciphertext));
  const encryptedData = derSequence(derInteger(0), encryptedContentInfo);
  return derSequence(derOid(P12_OID.encryptedData), derExplicit(0, encryptedData));
}

function bmpStringWithNull(str) {
  const out = new Uint8Array(str.length * 2 + 2);
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    out[i * 2] = (code >> 8) & 0xff;
    out[i * 2 + 1] = code & 0xff;
  }
  return out;
}

function fillToMultiple(bytes, v) {
  if (bytes.length === 0) return new Uint8Array(0);
  const len = Math.ceil(bytes.length / v) * v;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = bytes[i % bytes.length];
  return out;
}

// RFC 7292 Appendix B.2, ID=3 ("MAC key"), hash=SHA-1. Desired key length
// (20 bytes) equals SHA-1's own output size, so exactly one hash block is
// needed (c=1) and the "combine A_j into I" extension (only used when
// c>1) is never reached.
async function deriveMacKey(password, salt, iterations) {
  const v = 64, u = 20;
  const D = new Uint8Array(v).fill(3);
  const S = fillToMultiple(salt, v);
  const P = fillToMultiple(bmpStringWithNull(password), v);
  const I = concatBytes([S, P]);
  let A = await sha1(concatBytes([D, I]));
  for (let i = 1; i < iterations; i++) A = await sha1(A);
  return A.slice(0, u);
}

async function computeMacData(authenticatedSafeDer, password, iterations) {
  const salt = crypto.getRandomValues(new Uint8Array(20));
  const macKey = await deriveMacKey(password, salt, iterations);
  const hmacKey = await crypto.subtle.importKey("raw", macKey, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, authenticatedSafeDer));
  return derSequence(
    derSequence(derSequence(derOid(P12_OID.sha1), derNull()), derOctetString(digest)),
    derOctetString(salt),
    derInteger(iterations)
  );
}

async function buildP12({ certificateDer, privateKeyPkcs8, password }) {
  if (!password) throw new Error("buildP12: a non-empty password is required");
  if (!certificateDer) throw new Error("buildP12: certificateDer is required");
  if (!privateKeyPkcs8) throw new Error("buildP12: privateKeyPkcs8 is required");

  const certBytes = certificateDer instanceof Uint8Array ? certificateDer : new Uint8Array(certificateDer);
  const keyBytes = privateKeyPkcs8 instanceof Uint8Array ? privateKeyPkcs8 : new Uint8Array(privateKeyPkcs8);
  const ITERATIONS = 2048;

  const localKeyId = await sha1(certBytes);
  const certSafeBag = buildCertSafeBag(certBytes, localKeyId);
  const certContentInfo = await contentInfoEncryptedData(derSequence(certSafeBag), password, ITERATIONS);

  const keySafeBag = await buildKeySafeBag(keyBytes, password, localKeyId, ITERATIONS);
  const keyContentInfo = contentInfoData(derSequence(keySafeBag));

  const authenticatedSafe = derSequence(certContentInfo, keyContentInfo);
  const authSafeContentInfo = contentInfoData(authenticatedSafe);
  const macData = await computeMacData(authenticatedSafe, password, ITERATIONS);

  const pfx = derSequence(derInteger(3), authSafeContentInfo, macData);
  return { p12Bytes: pfx };
}

// ---------------- ASC API client + plain-English error translation ----------------

class AscApiError extends Error {
  constructor(message, { status, retryable = false } = {}) {
    super(message);
    this.name = "AscApiError";
    this.status = status;
    this.retryable = retryable;
  }
}

function translateAscError(status, body, endpointKind) {
  const errors = body?.errors || [];
  const detail = errors.map((e) => `${e.title || ""}: ${e.detail || ""}`).join(" | ");
  const detailLower = detail.toLowerCase();

  if (status === 403 && endpointKind === "provisioning") {
    return {
      message:
        "Apple rejected this API key (403). The most common cause: this is an Individual API key, and Apple requires a Team key for creating certificates, devices, or profiles. Generate a Team key instead from App Store Connect > Users and Access > Integrations.",
      retryable: false,
    };
  }
  if (status === 409 && detailLower.includes("maximum number")) {
    return {
      message:
        "Your Apple Developer account already has the maximum number of active Distribution certificates (usually 2-3). Revoke an old/unused one in Certificates, Identifiers & Profiles, then try again.",
      retryable: false,
    };
  }
  if ((status === 500 || detail.includes("UNEXPECTED_ERROR")) && endpointKind === "profiles") {
    return { message: "Apple's servers had a brief hiccup creating the profile. This usually clears up on a retry.", retryable: true };
  }
  if (status === 401) {
    return {
      message: "Apple rejected the API key credentials. Double-check the Key ID and Issuer ID, and that the .p8 file matches — a lost key can't be re-downloaded, only replaced with a new one.",
      retryable: false,
    };
  }
  return { message: detail || `Apple returned an unexpected ${status} response.`, retryable: status >= 500 };
}

async function ascRequest(creds, path, { method = "GET", body, endpointKind } = {}) {
  const token = await buildAscToken(creds.p8Pem, creds.keyId, creds.issuerId);
  const res = await fetch(`${ASC_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = null;
  if (text) { try { parsed = JSON.parse(text); } catch { /* non-JSON error body */ } }
  if (!res.ok) {
    const { message, retryable } = translateAscError(res.status, parsed, endpointKind);
    throw new AscApiError(message, { status: res.status, retryable });
  }
  return parsed;
}

async function ascRequestWithRetry(creds, path, opts = {}) {
  try {
    return await ascRequest(creds, path, opts);
  } catch (err) {
    if (err instanceof AscApiError && err.retryable) {
      await new Promise((r) => setTimeout(r, 2000));
      return await ascRequest(creds, path, opts);
    }
    throw err;
  }
}

async function findOrCreateBundleId(creds, { identifier, name }) {
  const existing = await ascRequestWithRetry(creds, `/bundleIds?filter[identifier]=${encodeURIComponent(identifier)}`, {
    endpointKind: "provisioning",
  });
  if (existing.data?.length > 0) return existing.data[0];
  const created = await ascRequestWithRetry(creds, "/bundleIds", {
    method: "POST",
    endpointKind: "provisioning",
    body: { data: { type: "bundleIds", attributes: { identifier, name, platform: "IOS" } } },
  });
  return created.data;
}

async function createCertificate(creds, commonName) {
  const { csrBase64, privateKeyPkcs8 } = await buildCsr(commonName);
  const created = await ascRequestWithRetry(creds, "/certificates", {
    method: "POST",
    endpointKind: "provisioning",
    body: { data: { type: "certificates", attributes: { certificateType: "IOS_DISTRIBUTION", csrContent: csrBase64 } } },
  });
  return { certificate: created.data, privateKeyPkcs8 };
}

async function createProfile(creds, { name, bundleIdResourceId, certificateId }) {
  const created = await ascRequestWithRetry(creds, "/profiles", {
    method: "POST",
    endpointKind: "profiles",
    body: {
      data: {
        type: "profiles",
        attributes: { name, profileType: "IOS_APP_STORE" },
        relationships: {
          bundleId: { data: { type: "bundleIds", id: bundleIdResourceId } },
          certificates: { data: [{ type: "certificates", id: certificateId }] },
        },
      },
    },
  });
  return created.data;
}

function randomPassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return bytesToBase64(bytes).replace(/[+/=]/g, "");
}

/**
 * The customer-facing entry point. Given a buyer's own ASC API credentials
 * (never persisted — held only in memory for this one call) and their
 * app's bundle identifier, mints a brand-new Distribution certificate +
 * App Store provisioning profile and packages them into a working .p12.
 *
 * Always mints a FRESH certificate rather than reusing an existing one —
 * Apple never returns an existing certificate's private key (it never had
 * it; whoever originally created that cert generated the key on their own
 * machine), so an existing cert can never be packaged into a usable .p12
 * here. If the buyer is at Apple's certificate cap, this surfaces as the
 * plain-English "maximum number" error above rather than a raw 409.
 */
async function autoProvisionSigning(creds, { bundleIdentifier, appName }) {
  const { certificate, privateKeyPkcs8 } = await createCertificate(creds, `Macless: ${appName || bundleIdentifier}`);
  const bundleId = await findOrCreateBundleId(creds, { identifier: bundleIdentifier, name: appName || bundleIdentifier });
  const profile = await createProfile(creds, {
    name: `Macless ${appName || bundleIdentifier} App Store`,
    bundleIdResourceId: bundleId.id,
    certificateId: certificate.id,
  });

  const certificateDer = base64ToBytes(certificate.attributes.certificateContent);
  const password = randomPassword();
  const { p12Bytes } = await buildP12({ certificateDer, privateKeyPkcs8, password });

  return {
    p12Base64: bytesToBase64(p12Bytes),
    p12Password: password,
    profileBase64: profile.attributes.profileContent, // Apple already returns this as base64
    teamId: bundleId.attributes.seedId,
    certificateId: certificate.id,
    profileId: profile.id,
  };
}

export { autoProvisionSigning, AscApiError };
