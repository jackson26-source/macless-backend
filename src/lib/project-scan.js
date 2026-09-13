// project-scan.js — best-effort detection of the buyer's actual app
// settings (bundle ID / package name, deployment target, platform,
// capabilities) straight from their own repo, instead of asking them to
// type values in blind that are already sitting in their own project
// files.
//
// Zero external dependencies, same posture as the rest of this codebase.
// This is deliberately read-only and deliberately best-effort: every
// extraction is wrapped so one missing or unusually-shaped file can never
// break the scan for the rest — if nothing matches, the caller just gets
// {} back and the buyer types values in by hand exactly like today. This
// never blocks or replaces the existing Configure-step flow, it only
// pre-fills it.
//
// Real repo layouts vary a lot more than any one framework's docs
// describe, so multiple candidate paths are tried in a sensible order
// per platform rather than assuming one fixed layout:
//  - Capacitor-wrapped web/RN apps often don't commit ios/ at all (it's
//    generated at build time by `cap add ios`) — appId lives in
//    capacitor.config.json/.ts instead.
//  - Expo-managed RN apps keep bundle identifier / package name in
//    app.json / app.config.json under expo.ios / expo.android.
//  - Bare React Native and native Swift projects commit a real
//    ios/*.xcodeproj/project.pbxproj with PRODUCT_BUNDLE_IDENTIFIER and
//    IPHONEOS_DEPLOYMENT_TARGET build settings.
//  - Flutter commits ios/Runner.xcodeproj/project.pbxproj the same way.
//  - Android reads applicationId out of android/app/build.gradle(.kts)
//    regardless of which JS/native framework sits on top.

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
    // atob() chokes on the newlines GitHub's API wraps base64 content
    // with — strip them first.
    const binary = atob(json.content.replace(/\n/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  } catch (e) {
    return null;
  }
}

function firstMatch(text, re) {
  const m = text.match(re);
  return m ? m[1].trim() : null;
}

function detectFromPbxproj(text) {
  // A project can list the same build setting under multiple
  // configurations (Debug/Release) — take the first, they're
  // overwhelmingly the same value in real projects, and this is a
  // pre-filled *default* the buyer reviews, not a silent commit.
  const bundleId = firstMatch(text, /PRODUCT_BUNDLE_IDENTIFIER\s*=\s*"?([A-Za-z0-9.\-_$()]+)"?;/);
  const deploymentTarget = firstMatch(text, /IPHONEOS_DEPLOYMENT_TARGET\s*=\s*([0-9.]+);/);
  return { bundleId: bundleId && !bundleId.includes("$(") ? bundleId : null, deploymentTarget };
}

function detectFromGradle(text) {
  return {
    packageName:
      firstMatch(text, /applicationId\s*[= ]\s*["']([a-zA-Z0-9._]+)["']/) ||
      firstMatch(text, /namespace\s*[= ]\s*["']([a-zA-Z0-9._]+)["']/),
  };
}

function detectFromCapacitorConfig(text) {
  // Real capacitor.config.json is plain JSON; the .ts variant wraps the
  // same object in `export default { ... }`, so a targeted regex is more
  // robust here than trying to strip TS syntax down to valid JSON.
  // Capacitor has exactly one app-identifier field -- appId -- used for
  // BOTH platforms (there's no separate Android identifier anywhere in
  // this config), so the same detected value is the right default for
  // both the iOS bundle ID and the Android package name.
  const appId = firstMatch(text, /appId['"]?\s*:\s*['"]([a-zA-Z0-9.\-_]+)['"]/);
  return { bundleId: appId, packageName: appId };
}

function detectFromExpoAppJson(text) {
  try {
    const data = JSON.parse(text);
    const expo = data.expo || data;
    return {
      bundleId: (expo.ios && expo.ios.bundleIdentifier) || null,
      packageName: (expo.android && expo.android.package) || null,
    };
  } catch (e) {
    return {};
  }
}

const CAPABILITY_KEYS = [
  { key: "com.apple.developer.applesignin", label: "Sign in with Apple" },
  { key: "aps-environment", label: "Push notifications" },
  { key: "com.apple.developer.icloud-container-identifiers", label: "iCloud / CloudKit" },
  { key: "com.apple.developer.icloud-services", label: "iCloud / CloudKit" },
  { key: "com.apple.developer.associated-domains", label: "Associated domains (universal links)" },
  { key: "com.apple.developer.in-app-payments", label: "Apple Pay" },
  { key: "com.apple.developer.healthkit", label: "HealthKit" },
  { key: "com.apple.developer.homekit", label: "HomeKit" },
  { key: "com.apple.security.application-groups", label: "App Groups" },
  { key: "com.apple.developer.game-center", label: "Game Center" },
];

function detectCapabilities(entitlementsText) {
  const found = [];
  for (const { key, label } of CAPABILITY_KEYS) {
    if (entitlementsText.includes(`<key>${key}</key>`) && !found.some((f) => f.label === label)) {
      found.push({ key, label });
    }
  }
  return found;
}

/**
 * Best-effort scan of the buyer's own repo for values the Configure step
 * currently asks them to type in by hand. Returns only what it actually
 * found — never throws, never invents a value, and the caller treats
 * everything here as an editable *default*, not a fact.
 */
async function scanProjectFiles(token, owner, repo, defaultBranch) {
  const detected = { bundleId: null, packageName: null, deploymentTarget: null, platform: null, capabilities: [] };

  let paths = [];
  try {
    const tree = await listRepoPaths(token, owner, repo, defaultBranch);
    if (tree.ok) paths = tree.paths;
  } catch (e) {
    return detected; // repo tree unreadable — caller falls back to manual entry, same as today
  }
  if (paths.length === 0) return detected;

  const findAll = (re) => paths.filter((p) => re.test(p));

  // --- platform + bundle ID / deployment target, in a sensible fallback order ---
  const pbxprojPaths = findAll(/\.xcodeproj\/project\.pbxproj$/);
  const capacitorConfigPaths = findAll(/^capacitor\.config\.(json|ts)$/);
  const expoAppJsonPaths = findAll(/^app\.(json|config\.json)$/);
  const pubspecPaths = findAll(/^pubspec\.yaml$/);
  const gradlePaths = findAll(/android\/app\/build\.gradle(\.kts)?$/);

  if (pubspecPaths.length > 0) detected.platform = "flutter";
  else if (capacitorConfigPaths.length > 0) detected.platform = "capacitor";
  else if (expoAppJsonPaths.length > 0 && findAll(/^(App|index)\.(js|jsx|ts|tsx)$/).length > 0) detected.platform = "expo";
  else if (pbxprojPaths.length > 0) detected.platform = "native-or-bare-rn";

  try {
    if (pbxprojPaths.length > 0) {
      // Prefer the shortest path — nested/derived project files (e.g. inside
      // Pods/) sit deeper and aren't the buyer's own app target.
      const shortest = pbxprojPaths.sort((a, b) => a.length - b.length)[0];
      const text = await getFileText(token, owner, repo, shortest);
      if (text) {
        const { bundleId, deploymentTarget } = detectFromPbxproj(text);
        if (bundleId) detected.bundleId = bundleId;
        if (deploymentTarget) detected.deploymentTarget = deploymentTarget;
      }
    }
    if ((!detected.bundleId || !detected.packageName) && capacitorConfigPaths.length > 0) {
      const text = await getFileText(token, owner, repo, capacitorConfigPaths[0]);
      if (text) {
        const { bundleId, packageName } = detectFromCapacitorConfig(text);
        if (bundleId && !detected.bundleId) detected.bundleId = bundleId;
        if (packageName && !detected.packageName) detected.packageName = packageName;
      }
    }
    if ((!detected.bundleId || !detected.packageName) && expoAppJsonPaths.length > 0) {
      const text = await getFileText(token, owner, repo, expoAppJsonPaths[0]);
      if (text) {
        const { bundleId, packageName } = detectFromExpoAppJson(text);
        if (bundleId && !detected.bundleId) detected.bundleId = bundleId;
        if (packageName && !detected.packageName) detected.packageName = packageName;
      }
    }
    if (!detected.packageName && gradlePaths.length > 0) {
      const text = await getFileText(token, owner, repo, gradlePaths[0]);
      if (text) {
        const { packageName } = detectFromGradle(text);
        if (packageName) detected.packageName = packageName;
      }
    }

    // --- capabilities, from the first real .entitlements file (skip Pods/ vendored copies) ---
    const entitlementsPaths = findAll(/\.entitlements$/).filter((p) => !/\/Pods\//.test(p));
    if (entitlementsPaths.length > 0) {
      const text = await getFileText(token, owner, repo, entitlementsPaths[0]);
      if (text) detected.capabilities = detectCapabilities(text);
    }
  } catch (e) {
    // Any single failed fetch/parse falls through to whatever was already
    // detected — never surfaces as an error to the buyer.
  }

  return detected;
}

export { scanProjectFiles };
