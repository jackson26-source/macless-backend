// workflow-scan.js — Workers version. The pure text-parsing logic below
// (REF_RE, HINTS, hintFor, scanWorkflowTexts) is copied verbatim from the
// desktop app's version, since it has zero Node-specific dependencies —
// same exact secret/variable detection, same corrections against the real
// product zip. The only thing that changes here is WHERE the workflow
// file text comes from: the desktop app reads it off local disk; a
// Worker has no local disk, so this fetches it from GitHub's own
// Contents API instead, using the buyer's token.

const REF_RE =
  /(secrets|vars)(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\])(\s*\|\|\s*'[^']*'|\s*\|\|\s*"[^"]*")?/g;

const HINTS = [
  { match: /^APPLE_TEAM_ID$/i, kind: "text", label: "Apple Developer Team ID" },
  { match: /^APPSTORE_API_KEY_ID$/i, kind: "text", label: "App Store Connect API Key ID" },
  { match: /^APPSTORE_API_ISSUER_ID$/i, kind: "text", label: "App Store Connect API Issuer ID" },
  { match: /^APPSTORE_API_PRIVATE_KEY_BASE64$/i, kind: "file-base64", label: "App Store Connect API private key (.p8, base64-encoded)" },
  { match: /^IOS_DIST_CERT_P12_BASE64$/i, kind: "file-base64", label: "iOS distribution certificate (.p12, base64-encoded)" },
  { match: /^IOS_DIST_CERT_PASSWORD$/i, kind: "secret-text", label: "Certificate (.p12) password" },
  { match: /^IOS_APP_PROVISION_PROFILE_BASE64$/i, kind: "file-base64", label: "Provisioning profile (.mobileprovision, base64-encoded)" },
  { match: /^IOS_BUNDLE_ID$/i, kind: "text", label: "App bundle ID (e.g. com.example.app)" },
  { match: /^IOS_PROVISIONING_PROFILE_NAME$/i, kind: "text", label: "The exact Name you gave the provisioning profile in Apple's portal" },
  { match: /^IOS_PROJECT_NAME$/i, kind: "text", label: "Xcode project/scheme name (only if it isn't the default \"App\")" },
  { match: /^IOS_XCODE_VERSION$/i, kind: "text", label: "Xcode version override (optional — defaults to latest-stable)" },
  { match: /^IOS_FLUTTER_VERSION$/i, kind: "text", label: "Flutter version (Flutter builds only)" },
  { match: /^IOS_NEW_ARCHITECTURE$/i, kind: "text", label: "React Native New Architecture flag (advanced, RN builds only)" },
  { match: /^ANDROID_KEYSTORE_BASE64$/i, kind: "file-base64", label: "Android release keystore, base64-encoded" },
  { match: /^ANDROID_KEYSTORE_PASSWORD$/i, kind: "secret-text", label: "Android keystore password" },
  { match: /^ANDROID_KEY_ALIAS$/i, kind: "text", label: "Android signing key alias" },
  { match: /^ANDROID_KEY_PASSWORD$/i, kind: "secret-text", label: "Android signing key password (usually same as keystore password)" },
  { match: /^ANDROID_PACKAGE_NAME$/i, kind: "text", label: "Android package name (e.g. com.example.app)" },
  { match: /^ANDROID_PLAY_TRACK$/i, kind: "text", label: "Play Store release track (optional — defaults to internal)" },
  {
    match: /^ANDROID_PLAY_SERVICE_ACCOUNT_JSON$/i,
    kind: "manual-elsewhere",
    label: "Google Play service account JSON — this app doesn't walk you through Play Console; see ANDROID.md section 2, then paste the file's contents here once you have it",
  },
  { match: /^NOTIFY_WEBHOOK_URL$/i, kind: "text", label: "Notification webhook URL (Discord/Slack) — optional" },
  { match: /CERT.*PASS|P12.*PASS/i, kind: "secret-text", label: "Certificate (.p12) password" },
  { match: /KEYSTORE.*PASS/i, kind: "secret-text", label: "Android keystore password" },
  { match: /KEY.*ALIAS/i, kind: "text", label: "Android signing key alias" },
  { match: /KEY_?PASS(WORD)?/i, kind: "secret-text", label: "Android signing key password" },
  { match: /TEAM_?ID/i, kind: "text", label: "Apple Developer Team ID" },
  { match: /BUNDLE_?ID|PACKAGE_?NAME/i, kind: "text", label: "App bundle ID / package name" },
  { match: /WEBHOOK|NOTIFY/i, kind: "text", label: "Notification webhook URL (Discord/Slack) — optional" },
  { match: /PROVISION.*PROFILE|MOBILEPROVISION/i, kind: "file-base64", label: "Provisioning profile (.mobileprovision, base64-encoded)" },
  { match: /CERT.*BASE64|P12.*BASE64|DIST.*CERT/i, kind: "file-base64", label: "iOS distribution certificate (.p12, base64-encoded)" },
  { match: /API.*KEY.*BASE64|KEY.*BASE64/i, kind: "file-base64", label: "API private key (base64-encoded)" },
  { match: /KEYSTORE.*BASE64|ANDROID.*KEYSTORE/i, kind: "file-base64", label: "Android release keystore, base64-encoded" },
];

function hintFor(name) {
  for (const h of HINTS) {
    if (h.match.test(name)) return { kind: h.kind, label: h.label };
  }
  return { kind: "text", label: null };
}

/** Pure function: given [{file, text}], returns the same {workflows, secrets} shape the desktop app's scanner does. No I/O. */
function scanWorkflowTexts(files) {
  const map = new Map();
  const workflows = [];

  for (const { file, text } of files) {
    const nameMatch = text.match(/^name:\s*(.+)$/m);
    const workflowName = nameMatch ? nameMatch[1].trim().replace(/^["']|["']$/g, "") : file;

    const foundHere = [];
    let m;
    REF_RE.lastIndex = 0;
    while ((m = REF_RE.exec(text)) !== null) {
      const scope = m[1] === "vars" ? "variable" : "secret";
      const refName = m[2] || m[3];
      const hasDefault = !!m[4];
      if (!refName) continue;

      const key = `${scope}:${refName}`;
      foundHere.push({ name: refName, scope });

      if (!map.has(key)) {
        const hint = hintFor(refName);
        map.set(key, { name: refName, scope, kind: hint.kind, label: hint.label, required: !hasDefault, usedBy: new Set() });
      } else if (!hasDefault) {
        map.get(key).required = true;
      }
      map.get(key).usedBy.add(file);
    }

    workflows.push({ file, name: workflowName, refs: foundHere });
  }

  const secrets = Array.from(map.values())
    .map((s) => ({ ...s, usedBy: Array.from(s.usedBy).sort() }))
    .sort((a, b) => (a.required === b.required ? a.name.localeCompare(b.name) : a.required ? -1 : 1));

  return { ok: workflows.length > 0, workflows, secrets };
}

/** Fetches .github/workflows/*.yml straight from the buyer's GitHub repo (no local disk here) and scans it. */
async function scanRepoWorkflows(token, owner, repo) {
  const listResp = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/.github/workflows`, {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": "macless-backend", Accept: "application/vnd.github+json" },
  });
  if (listResp.status === 404) return { ok: false, reason: "no-workflows-dir", workflows: [], secrets: [] };
  if (!listResp.ok) return { ok: false, reason: "github-error", workflows: [], secrets: [] };
  const entries = await listResp.json();
  const ymlFiles = entries.filter((e) => e.type === "file" && (e.name.endsWith(".yml") || e.name.endsWith(".yaml")));
  if (ymlFiles.length === 0) return { ok: false, reason: "empty-workflows-dir", workflows: [], secrets: [] };

  const files = await Promise.all(
    ymlFiles.map(async (entry) => {
      const fileResp = await fetch(entry.url, {
        headers: { Authorization: `Bearer ${token}`, "User-Agent": "macless-backend", Accept: "application/vnd.github.raw" },
      });
      const text = fileResp.ok ? await fileResp.text() : "";
      return { file: entry.name, text };
    })
  );

  return scanWorkflowTexts(files);
}

export { scanWorkflowTexts, scanRepoWorkflows, hintFor };
