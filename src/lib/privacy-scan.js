// privacy-scan.js — best-effort suggestions for which Apple App Privacy
// "nutrition label" categories a buyer's app likely needs to declare in
// App Store Connect, based on reading the buyer's OWN repo files.
//
// Deliberately SUGGESTION-ONLY, same discipline as Signing Doctor's whole
// design (translate, don't auto-decide): guessing wrong on a privacy
// declaration is an App Review rejection risk, not just a UX inconvenience,
// so this never writes anything anywhere and never claims certainty.
// Nothing here is pushed to Apple or committed to the repo — it's read-only
// output the buyer reviews and then fills in themselves in App Store
// Connect's own Privacy section.
//
// Two independent signal sources, kept and labelled separately because
// they carry very different confidence:
//
//  1. Info.plist usage-description keys (NS*UsageDescription). These are
//     Apple's OWN documented API — a real app that includes one of these
//     keys is, by Apple's own requirement, asking the OS for permission to
//     access that exact capability. High confidence: this is reading a
//     fact about the app, not guessing.
//
//  2. Well-known third-party SDKs found in dependency manifests
//     (package.json, Podfile.lock). Presence of a package name is a much
//     weaker signal than an Info.plist key — it tells you the SDK is
//     present, not what it actually does with data in THIS app — so these
//     are shown under their own, more hedged heading and the buyer is
//     pointed at that SDK's own privacy manifest / documentation to verify.
//
// Zero external dependencies, same posture as the rest of this codebase.

import { listRepoPaths } from "./github-api.js";

const API = "https://api.github.com";

async function getFileText(token, owner, repo, path) {
  const resp = await fetch(`${API}/repos/${owner}/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "macless-backend" },
  });
  if (!resp.ok) return null;
  const json = await resp.json().catch(() => null);
  if (!json || json.encoding !== "base64" || typeof json.content !== "string") return null;
  try {
    const binary = atob(json.content.replace(/\n/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  } catch (e) {
    return null;
  }
}

// Apple's own Info.plist purpose-string keys, each one an explicit,
// documented request for a specific OS capability. "category" is what
// Apple's App Privacy nutrition label actually calls the data type that
// capability most directly maps to — left null where there's no clean
// 1:1 mapping, with a plain-language note instead of a guessed category.
const USAGE_DESCRIPTION_KEYS = [
  { key: "NSCameraUsageDescription", capability: "Camera", category: "Photos or Videos", note: "Only a reportable data type if photos/video captured are stored, transmitted, or linked to the user — access alone isn't." },
  { key: "NSPhotoLibraryUsageDescription", capability: "Photo library (read)", category: "Photos or Videos", note: null },
  { key: "NSPhotoLibraryAddUsageDescription", capability: "Photo library (write)", category: "Photos or Videos", note: null },
  { key: "NSLocationWhenInUseUsageDescription", capability: "Location (in use)", category: "Location", note: "Declare Precise or Coarse depending on the accuracy your app actually uses." },
  { key: "NSLocationAlwaysAndWhenInUseUsageDescription", capability: "Location (always)", category: "Location", note: "Background location tends to draw extra App Review scrutiny — make sure the justification in your usage string matches what the app does." },
  { key: "NSContactsUsageDescription", capability: "Contacts", category: "Contacts", note: null },
  { key: "NSMicrophoneUsageDescription", capability: "Microphone", category: "Audio Data", note: "Only reportable if audio is stored or transmitted, not for on-device-only processing." },
  { key: "NSCalendarsUsageDescription", capability: "Calendars", category: null, note: "No dedicated Apple nutrition-label category for calendar data specifically — usually falls under \"Other Data\" if calendar content is collected or transmitted." },
  { key: "NSCalendarsFullAccessUsageDescription", capability: "Calendars (full access)", category: null, note: "Same as NSCalendarsUsageDescription." },
  { key: "NSRemindersUsageDescription", capability: "Reminders", category: null, note: "No dedicated category — usually \"Other Data\" if reminder content is collected or transmitted." },
  { key: "NSHealthShareUsageDescription", capability: "Health data (read)", category: "Health & Fitness", note: null },
  { key: "NSHealthUpdateUsageDescription", capability: "Health data (write)", category: "Health & Fitness", note: null },
  { key: "NSMotionUsageDescription", capability: "Motion & fitness", category: "Health & Fitness", note: "Specifically the \"Fitness\" data type under Health & Fitness." },
  { key: "NSBluetoothAlwaysUsageDescription", capability: "Bluetooth", category: null, note: "No dedicated category by itself — review whether Bluetooth is used to identify/track a device, which would fall under Identifiers." },
  { key: "NSBluetoothPeripheralUsageDescription", capability: "Bluetooth peripherals", category: null, note: "Same as NSBluetoothAlwaysUsageDescription." },
  { key: "NSFaceIDUsageDescription", capability: "Face ID", category: null, note: "Usually NOT a reportable data type — Face ID match results never leave the device unless your own code independently transmits something derived from it." },
  { key: "NSSpeechRecognitionUsageDescription", capability: "Speech recognition", category: "Audio Data", note: "Also review User Content if transcribed text is stored or transmitted." },
  { key: "NSUserTrackingUsageDescription", capability: "App Tracking Transparency prompt", category: "Data Used to Track You", note: "Presence of this key means the app asks for tracking permission — review this category carefully, it's the one Apple checks most closely at review." },
];

// A short, deliberately conservative list of very well-known SDKs whose
// core purpose is unambiguous and widely documented — not an attempt at
// exhaustive dependency analysis. Matched against raw package.json /
// Podfile.lock text rather than parsed dependency trees, since buyers'
// manifests vary too much in shape (npm vs yarn vs pnpm lockfile-adjacent
// fields, CocoaPods subspecs, etc.) to parse reliably — a substring match
// against known package names is far more robust than trying to walk
// every possible manifest format.
const KNOWN_SDK_SIGNALS = [
  { pattern: /firebase[/-]?(crashlytics)/i, sdk: "Firebase Crashlytics", categories: ["Diagnostics (Crash Data)"] },
  { pattern: /firebase[/-]?analytics|@react-native-firebase\/analytics/i, sdk: "Firebase Analytics", categories: ["Usage Data", "Identifiers"] },
  { pattern: /\bstripe\b/i, sdk: "Stripe", categories: ["Payment Info"] },
  { pattern: /\bsentry\b/i, sdk: "Sentry", categories: ["Diagnostics (Crash Data)"] },
  { pattern: /\bbugsnag\b/i, sdk: "Bugsnag", categories: ["Diagnostics (Crash Data)"] },
  { pattern: /\bmixpanel\b/i, sdk: "Mixpanel", categories: ["Usage Data", "Identifiers"] },
  { pattern: /\bamplitude\b/i, sdk: "Amplitude", categories: ["Usage Data", "Identifiers"] },
  { pattern: /analytics-react-native|@segment\/analytics|\bsegment\b/i, sdk: "Segment", categories: ["Usage Data", "Identifiers"] },
  { pattern: /onesignal/i, sdk: "OneSignal", categories: ["Identifiers (Push Token)", "Usage Data"] },
  { pattern: /facebook-android-sdk|react-native-fbsdk|\bFBSDK/i, sdk: "Facebook SDK", categories: ["Identifiers", "Usage Data", "Purchases"] },
  { pattern: /google-mobile-ads|admob|\bGoogleMobileAds\b/i, sdk: "Google AdMob", categories: ["Identifiers", "Usage Data", "Purchases"] },
  { pattern: /revenuecat|purchases-react-native|\bPurchases\b/i, sdk: "RevenueCat", categories: ["Purchases"] },
  { pattern: /react-native-geolocation|expo-location|\bCoreLocation\b/i, sdk: "Location SDK", categories: ["Location"] },
];

/**
 * Best-effort read of the buyer's repo for privacy-relevant signals.
 * Returns { infoPlistSignals, sdkSignals, filesChecked } — never throws
 * (any failed fetch/parse is just dropped, same "worst case is an empty
 * result and the buyer does it by hand" posture as scanProjectFiles).
 */
async function scanPrivacySignals(token, owner, repo, defaultBranch) {
  const result = { infoPlistSignals: [], sdkSignals: [], filesChecked: [] };

  let paths = [];
  try {
    const tree = await listRepoPaths(token, owner, repo, defaultBranch);
    if (tree.ok) paths = tree.paths;
  } catch (e) {
    return result;
  }
  if (paths.length === 0) return result;

  const findAll = (re) => paths.filter((p) => re.test(p));

  // --- Info.plist usage-description keys ---
  try {
    const plistPaths = findAll(/Info\.plist$/).filter((p) => !/\/Pods\//.test(p) && !/DerivedData/.test(p));
    // Same reasoning as project-scan.js's pbxproj pick: the shortest path
    // is almost always the buyer's own app target, not a nested dependency.
    const sorted = plistPaths.sort((a, b) => a.length - b.length);
    for (const p of sorted.slice(0, 3)) {
      const text = await getFileText(token, owner, repo, p);
      if (!text) continue;
      result.filesChecked.push(p);
      for (const entry of USAGE_DESCRIPTION_KEYS) {
        if (text.includes(`<key>${entry.key}</key>`) && !result.infoPlistSignals.some((s) => s.key === entry.key)) {
          result.infoPlistSignals.push(entry);
        }
      }
    }
  } catch (e) {
    // fall through with whatever was found before the failure
  }

  // --- known third-party SDKs, from package.json + Podfile.lock ---
  try {
    const manifestPaths = findAll(/^package\.json$/).concat(findAll(/^ios\/Podfile\.lock$/), findAll(/^Podfile\.lock$/));
    const seenSdks = new Set();
    for (const p of manifestPaths.slice(0, 4)) {
      const text = await getFileText(token, owner, repo, p);
      if (!text) continue;
      result.filesChecked.push(p);
      for (const entry of KNOWN_SDK_SIGNALS) {
        if (entry.pattern.test(text) && !seenSdks.has(entry.sdk)) {
          seenSdks.add(entry.sdk);
          result.sdkSignals.push({ sdk: entry.sdk, categories: entry.categories });
        }
      }
    }
  } catch (e) {
    // fall through with whatever was found before the failure
  }

  return result;
}

export { scanPrivacySignals };
