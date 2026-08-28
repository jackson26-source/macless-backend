// signing-doctor.js — the in-browser, instant version of
// template/scripts/signing-doctor.sh. Same checks, same messages where
// possible, so a buyer sees consistent guidance whether they hit this
// inline check in the wizard or the CI-based one that still runs for
// real as the first step of every build. Reimplemented in pure JS
// (der.js/x509.js/pkcs12.js/cms.js/plist.js, all zero-dependency, native
// Web Crypto only) because Cloudflare Workers can't shell out to the
// `security`/PlistBuddy/keytool/openssl binaries the shell script uses —
// see DEPLOY.md for the full reasoning.
//
// Every parsing primitive here was tested against REAL fixtures before
// this file was written: a real `keytool -genkeypair` keystore, a real
// `openssl pkcs12 -export` cert, and a real CMS-signed plist envelope —
// including a caught-and-fixed bug (PKCS#12 modern PBES2 containers use
// plain UTF-8 passwords, not the legacy BMPString+NUL convention some
// older references describe) and a verified positive AND negative case
// for the cert/profile fingerprint cross-check. See
// claude/macless-hosted-backend-2026-08-25.md for the full record.
//
// One real gap: none of this was tested against an actual Apple-issued
// profile — only a structurally-identical self-signed stand-in (Apple's
// signature is never checked anyway, same as the real `security cms -D`
// call, but a genuine Apple profile could in principle have some plist
// quirk this hasn't seen). Worth one real-world sanity check against an
// actual (even disposable/throwaway) Apple profile before fully trusting
// this over the CI-based check.

import { extractSignedContent, NotACmsEnvelopeError } from "./cms.js";
import { parsePlist } from "./plist.js";
import { parseCertificate, fingerprintSha1 } from "./x509.js";
import { extractCertificates, WrongPasswordError, UnsupportedFormatError } from "./pkcs12.js";

function daysUntil(date) {
  return Math.floor((date.getTime() - Date.now()) / 86400000);
}

function line(lines, level, text) {
  lines.push({ level, text }); // level: 'info' | 'ok' | 'warn' | 'fail'
}

/**
 * Checks an iOS provisioning profile (and optionally a paired .p12
 * distribution certificate). Mirrors signing-doctor.sh's --profile
 * [--cert] flags. All inputs are raw bytes (Uint8Array) — the caller is
 * responsible for base64-decoding an upload before calling this.
 */
async function diagnoseIosProfile({ profileBytes, expectedTeamId, expectedBundleId, certBytes, certPassword }) {
  const lines = [];
  let failed = false;
  let warned = false;

  line(lines, "info", "iOS provisioning profile");

  let plistText;
  try {
    const contentBytes = extractSignedContent(profileBytes);
    plistText = new TextDecoder().decode(contentBytes);
  } catch (e) {
    line(lines, "fail", "Couldn't decode this file as a provisioning profile at all. Most common cause: this isn't actually a .mobileprovision file — double check you didn't accidentally point this at a .cer, .p12, or a base64-encoded copy of one of those instead.");
    return { failed: true, warned, lines };
  }

  let profile;
  try {
    profile = parsePlist(plistText);
  } catch (e) {
    line(lines, "fail", `This file decoded but its contents aren't a readable property list (${e.message}).`);
    return { failed: true, warned, lines };
  }

  const teamId = Array.isArray(profile.TeamIdentifier) ? profile.TeamIdentifier[0] : profile.TeamIdentifier;
  const appId = profile.Entitlements && profile.Entitlements["application-identifier"];
  const bundleId = appId ? appId.slice(appId.indexOf(".") + 1) : null;
  const profileType = profile.Entitlements && profile.Entitlements["get-task-allow"] === false ? "Distribution (App Store / Ad Hoc / Enterprise)" : "Development";

  line(lines, "info", `Name: ${profile.Name || "(not present)"}`);
  line(lines, "info", `UUID: ${profile.UUID || "(not present)"}`);
  line(lines, "info", `Team ID: ${teamId || "(not present)"}`);
  line(lines, "info", `Bundle ID: ${bundleId || "(not present)"}`);
  line(lines, "info", `Type (inferred): ${profileType}`);

  // ---- expiry ----
  if (profile.ExpirationDate) {
    const expiry = new Date(profile.ExpirationDate);
    const daysLeft = daysUntil(expiry);
    if (daysLeft < 0) {
      line(lines, "fail", `This profile expired ${-daysLeft} day(s) ago. Generate a new one from developer.apple.com/account > Profiles, download it, and re-check.`);
      failed = true;
    } else if (daysLeft < 30) {
      line(lines, "warn", `This profile expires in ${daysLeft} day(s) — worth renewing soon so a build doesn't unexpectedly fail later.`);
      warned = true;
    } else {
      line(lines, "ok", `Profile is valid for another ${daysLeft} day(s).`);
    }
  }

  // ---- team ID ----
  if (expectedTeamId) {
    if (!teamId) {
      line(lines, "warn", `Couldn't read a Team ID from the profile to compare against the expected ${expectedTeamId}.`);
      warned = true;
    } else if (teamId !== expectedTeamId) {
      line(lines, "fail", `Profile's Team ID (${teamId}) doesn't match the Team ID you expected (${expectedTeamId}). This usually means the profile was generated under a different Apple Developer team — check developer.apple.com/account under Membership.`);
      failed = true;
    } else {
      line(lines, "ok", "Profile's Team ID matches the expected Team ID.");
    }
  }

  // ---- bundle ID ----
  if (expectedBundleId) {
    if (!bundleId) {
      line(lines, "warn", `Couldn't read a bundle ID from the profile to compare against the expected ${expectedBundleId}.`);
      warned = true;
    } else if (bundleId !== expectedBundleId && bundleId !== "*") {
      line(lines, "fail", `Profile's bundle ID (${bundleId}) doesn't match the expected ${expectedBundleId}. Double-check the App ID you registered uses the exact same bundle ID as your Xcode project.`);
      failed = true;
    } else {
      line(lines, "ok", "Profile's bundle ID matches (or the profile is a wildcard '*' App ID, which covers any bundle ID).");
    }
  }

  // ---- cert cross-check ----
  if (certBytes) {
    let certResult;
    try {
      certResult = await extractCertificates(certBytes, certPassword || "");
    } catch (e) {
      if (e instanceof WrongPasswordError) {
        line(lines, "fail", "Couldn't unlock the certificate with the password given. Either the password is wrong, or this isn't a valid .p12 file.");
      } else if (e instanceof UnsupportedFormatError) {
        line(lines, "fail", `Couldn't read this certificate (${e.message}). Try re-exporting a fresh .p12 with a current version of Keychain Access or openssl.`);
      } else {
        line(lines, "fail", `Couldn't read this certificate file (${e.message}).`);
      }
      failed = true;
      certResult = null;
    }

    if (certResult && certResult.certs.length === 0) {
      line(lines, "fail", "That file decoded but no certificate was found inside it.");
      failed = true;
    } else if (certResult) {
      const cert = parseCertificate(certResult.certs[0]);
      line(lines, "info", `Certificate subject: ${cert.subjectCN || "(not present)"}`);
      line(lines, "info", `Certificate expires: ${cert.notAfter.toISOString()}`);

      if (/Apple Distribution|iPhone Distribution/.test(cert.subjectCN || "")) {
        line(lines, "ok", "This looks like a distribution certificate (App Store / Ad Hoc).");
      } else if (/Apple Development|iPhone Developer/.test(cert.subjectCN || "")) {
        line(lines, "warn", "This looks like a DEVELOPMENT certificate, not a distribution one — fine for local device testing, but TestFlight/App Store uploads need an Apple Distribution certificate instead.");
        warned = true;
      } else {
        line(lines, "warn", "Couldn't tell from the subject whether this is a development or distribution certificate.");
        warned = true;
      }

      const certFingerprint = await fingerprintSha1(certResult.certs[0]);
      let foundMatch = false;
      if (Array.isArray(profile.DeveloperCertificates)) {
        for (const embeddedDer of profile.DeveloperCertificates) {
          const embeddedFingerprint = await fingerprintSha1(embeddedDer);
          if (embeddedFingerprint === certFingerprint) {
            foundMatch = true;
            break;
          }
        }
      }
      if (foundMatch) {
        line(lines, "ok", "Your certificate's fingerprint matches one of the certificates embedded in this provisioning profile — they're a real pair.");
      } else {
        line(lines, "fail", "Your certificate's fingerprint does NOT match any certificate embedded in this provisioning profile. A profile only trusts the specific certificate(s) it was generated against — this is almost always caused by regenerating one of the two without regenerating the other to match. Re-download BOTH fresh from developer.apple.com/account at the same time.");
        failed = true;
      }
    }
  }

  return { failed, warned, lines };
}

/**
 * Checks an Android release keystore. Mirrors signing-doctor.sh's
 * --android-keystore flag. Only supports the modern PKCS#12 keystore
 * format (the default since JDK 9's `keytool -genkeypair`, verified
 * against a real one while building this) — a legacy JKS-format
 * keystore is reported as unsupported rather than misparsed.
 */
async function diagnoseAndroidKeystore({ keystoreBytes, keystorePassword, keyAlias = "upload", keyPassword }) {
  const lines = [];
  let failed = false;
  let warned = false;

  line(lines, "info", `Android keystore (alias: ${keyAlias})`);

  let certResult;
  try {
    certResult = await extractCertificates(keystoreBytes, keystorePassword || "");
  } catch (e) {
    if (e instanceof WrongPasswordError) {
      line(lines, "fail", "Couldn't open this keystore with the given password. Either --android-keystore-password is wrong, or this keystore uses an older format this check doesn't support (try re-generating a fresh one with a current `keytool`).");
    } else if (e instanceof UnsupportedFormatError) {
      line(lines, "fail", `Couldn't read this keystore (${e.message}). This usually means it's an older legacy-format (JKS) keystore rather than the modern PKCS#12 format current \`keytool\` produces by default — a fresh \`keytool -genkeypair\` keystore will work here.`);
    } else {
      line(lines, "fail", `Couldn't read this keystore file (${e.message}).`);
    }
    return { failed: true, warned, lines };
  }

  if (certResult.certs.length === 0) {
    line(lines, "fail", "Opened the keystore, but couldn't find a certificate inside it.");
    return { failed: true, warned, lines };
  }

  const cert = parseCertificate(certResult.certs[0]);
  line(lines, "info", `Alias: ${keyAlias}`);
  line(lines, "info", `Signature algorithm: ${cert.signatureAlgorithm}`);
  line(lines, "info", `Key: ${cert.publicKeyAlgorithm}${cert.publicKeyBits ? ` ${cert.publicKeyBits}-bit` : ""}`);

  if (/SHA1/i.test(cert.signatureAlgorithm)) {
    line(lines, "warn", "This key uses a SHA1-based signature algorithm — Google Play has been moving away from SHA1 for new app signing keys. Not necessarily broken for an existing app, but worth knowing if you're about to generate a brand-new keystore instead.");
    warned = true;
  }

  const daysLeft = daysUntil(cert.notAfter);
  line(lines, "info", `Valid until: ${cert.notAfter.toISOString()}`);
  if (daysLeft < 0) {
    line(lines, "fail", `This signing key expired ${-daysLeft} day(s) ago. Google Play will reject any update signed with an expired key — see Google's key-upgrade process (Play Console > App integrity) if this is a live app.`);
    failed = true;
  } else if (daysLeft < 365) {
    line(lines, "warn", `This signing key expires in ${daysLeft} day(s). Google Play recommends keys valid for 25+ years precisely so this never comes up — if you're this close, plan ahead with Google Play's key-upgrade process.`);
    warned = true;
  } else {
    line(lines, "ok", `Signing key is valid for another ${daysLeft} day(s).`);
  }

  return { failed, warned, lines };
}

/** Formats a { failed, warned, lines } result (or an array of them) into the same plain-text report shape signing-doctor.sh prints, for display in a <pre>/log-output block. */
function formatReport(results) {
  const all = Array.isArray(results) ? results : [results];
  const out = [];
  out.push("==================================================================");
  out.push(" signing-doctor");
  out.push("==================================================================");
  out.push("");
  const LEVEL_PREFIX = { info: "     ", ok: "OK   ", warn: "WARN ", fail: "FAIL " };
  let anyFailed = false;
  let anyWarned = false;
  for (const result of all) {
    for (const { level, text } of result.lines) out.push(`${LEVEL_PREFIX[level]} ${text}`);
    out.push("");
    anyFailed = anyFailed || result.failed;
    anyWarned = anyWarned || result.warned;
  }
  out.push("==================================================================");
  if (anyFailed) out.push(" Result: FAILED — see the FAIL lines above for what to fix.");
  else if (anyWarned) out.push(" Result: PASSED WITH WARNINGS — see the WARN lines above.");
  else out.push(" Result: Everything checked looks consistent.");
  return { text: out.join("\n"), failed: anyFailed, warned: anyWarned };
}

export { diagnoseIosProfile, diagnoseAndroidKeystore, formatReport };
