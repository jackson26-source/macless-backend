// github-api.js — Workers version. The REST calls (push secret/variable,
// trigger workflow, list runs, fetch failed logs) are identical to the
// desktop app's version, since GitHub's API doesn't care how the token
// was obtained. What's different here is the auth mechanism: a hosted,
// multi-buyer backend needs the standard OAuth **web** flow (authorize
// URL + callback + a client SECRET, unlike the desktop app's secret-free
// device flow), since this runs on a server that can actually keep a
// secret, and it needs to identify WHICH buyer is making each request.

const API = "https://api.github.com";

function authUrl(clientId, redirectUri, state) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "repo workflow",
    state,
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

async function exchangeCode(code, clientId, clientSecret, redirectUri) {
  const resp = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
  });
  const data = await resp.json();
  if (!data.access_token) return { ok: false, detail: data.error_description || data.error || "GitHub didn't return a token." };
  return { ok: true, token: data.access_token };
}

async function apiRequest(path, token, opts = {}) {
  const resp = await fetch(`${API}${path}`, {
    method: opts.method || "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "macless-backend",
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await resp.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (e) {
    /* non-JSON endpoints (e.g. raw logs) — caller uses text */
  }
  return { ok: resp.ok, status: resp.status, json, text };
}

async function whoAmI(token) {
  const r = await apiRequest("/user", token);
  if (!r.ok) return { ok: false };
  return { ok: true, login: r.json.login, id: r.json.id };
}

async function listRepos(token) {
  const r = await apiRequest("/user/repos?sort=updated&per_page=30", token);
  if (!r.ok) return { ok: false, repos: [] };
  return { ok: true, repos: r.json.map((repo) => ({ owner: repo.owner.login, name: repo.name, fullName: repo.full_name, defaultBranch: repo.default_branch })) };
}

async function createRepo(token, name, { private: isPrivate = true } = {}) {
  const r = await apiRequest("/user/repos", token, {
    method: "POST",
    body: { name, private: isPrivate, auto_init: true }, // auto_init so the repo has an initial commit/branch to base a tree on
  });
  if (!r.ok) return { ok: false, detail: (r.json && r.json.message) || `GitHub returned ${r.status}` };
  return { ok: true, owner: r.json.owner.login, repo: r.json.name, defaultBranch: r.json.default_branch };
}

/**
 * Writes a whole set of files into a repo in a single commit, using the
 * Git Data API (blobs -> tree -> commit -> update ref) — no local git,
 * no shell, no filesystem, so this is the only way a Worker can push a
 * multi-file template into a buyer's repo. Skips any file whose content
 * already matches (nothing changes -> nothing to commit), and no-ops
 * cleanly if every file was already up to date.
 */
async function commitFiles(token, owner, repo, branch, files, message) {
  const refResp = await apiRequest(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`, token);
  if (!refResp.ok) return { ok: false, detail: `Couldn't read branch ${branch}: ${(refResp.json && refResp.json.message) || refResp.status}` };
  const baseCommitSha = refResp.json.object.sha;

  const baseCommitResp = await apiRequest(`/repos/${owner}/${repo}/git/commits/${baseCommitSha}`, token);
  if (!baseCommitResp.ok) return { ok: false, detail: "Couldn't read the base commit." };
  const baseTreeSha = baseCommitResp.json.tree.sha;

  const paths = Object.keys(files);
  const blobs = [];
  for (const filePath of paths) {
    const blobResp = await apiRequest(`/repos/${owner}/${repo}/git/blobs`, token, {
      method: "POST",
      body: { content: files[filePath], encoding: "utf-8" },
    });
    if (!blobResp.ok) return { ok: false, detail: `Couldn't upload ${filePath}: ${(blobResp.json && blobResp.json.message) || blobResp.status}` };
    blobs.push({ path: filePath, mode: "100644", type: "blob", sha: blobResp.json.sha });
  }

  // GitHub's Git Data API has known eventual-consistency lag: creating many
  // blobs in a tight loop and then immediately referencing all their SHAs in
  // one tree-creation call can 404 even though every blob create succeeded,
  // because a read replica hasn't caught up yet. Retry a few times before
  // giving up. Confirmed live 2026-08-26: every blob upload succeeds, but
  // this call reliably 404s on the first try on both new and pre-existing
  // repos, which matches this exact symptom.
  let treeResp;
  for (let attempt = 1; attempt <= 3; attempt++) {
    treeResp = await apiRequest(`/repos/${owner}/${repo}/git/trees`, token, {
      method: "POST",
      body: { base_tree: baseTreeSha, tree: blobs },
    });
    if (treeResp.ok) break;
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
  }
  if (!treeResp.ok)
    return {
      ok: false,
      detail: `Couldn't build the commit tree after 3 tries: ${(treeResp.json && treeResp.json.message) || treeResp.status}`,
    };

  const commitResp = await apiRequest(`/repos/${owner}/${repo}/git/commits`, token, {
    method: "POST",
    body: { message, tree: treeResp.json.sha, parents: [baseCommitSha] },
  });
  if (!commitResp.ok) return { ok: false, detail: "Couldn't create the commit." };

  const updateRefResp = await apiRequest(`/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, token, {
    method: "PATCH",
    body: { sha: commitResp.json.sha },
  });
  if (!updateRefResp.ok) return { ok: false, detail: "Commit was created but the branch couldn't be updated (possibly diverged — try again)." };

  return { ok: true, commitSha: commitResp.json.sha, filesWritten: paths.length };
}

/** Lists every file path already in a repo's branch — used so connecting an EXISTING repo only adds template files that aren't already there, never overwrites the buyer's own code. */
async function listRepoPaths(token, owner, repo, branch) {
  const refResp = await apiRequest(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`, token);
  if (!refResp.ok) return { ok: false, paths: [] };
  const commitResp = await apiRequest(`/repos/${owner}/${repo}/git/commits/${refResp.json.object.sha}`, token);
  if (!commitResp.ok) return { ok: false, paths: [] };
  const treeResp = await apiRequest(`/repos/${owner}/${repo}/git/trees/${commitResp.json.tree.sha}?recursive=1`, token);
  if (!treeResp.ok) return { ok: false, paths: [] };
  const paths = (treeResp.json.tree || []).filter((e) => e.type === "blob").map((e) => e.path);
  return { ok: true, paths, truncated: !!treeResp.json.truncated };
}

async function encryptForRepo(token, owner, repo, plaintext) {
  let sodium;
  try {
    // libsodium-wrappers' own ESM build (dist/modules-esm/libsodium-wrappers.mjs)
    // has a real upstream packaging bug: it imports a sibling "./libsodium.mjs"
    // that the published npm package never actually ships, so a plain
    // `import("libsodium-wrappers")` fails to bundle with "Could not resolve
    // ./libsodium.mjs" (confirmed live 2026-08-27 against libsodium-wrappers
    // 0.7.16 with esbuild via both Wrangler 3 and 4 — not a Wrangler-version
    // issue). The CJS build (dist/modules/libsodium-wrappers.js) is a single
    // self-contained file with no such reference, so bundlers resolve it fine.
    // esbuild picks a package's "require" vs "import" export condition based
    // on whether the call site is `require(...)` or `import`/`import()` —
    // using require() here (still valid inside this ES module file; esbuild
    // fully inlines it at bundle time, no runtime `require` needed) forces
    // resolution to that working CJS file instead of the broken ESM one.
    // libsodium-wrappers' compiled loader has a leftover browser-detection
    // path ("useBackupModule") that reads `self.location.href` to resolve
    // its own script URL — a real browser/Node concept Workers doesn't
    // provide at all (confirmed live 2026-08-27: "Cannot read properties
    // of undefined (reading 'href')" at that exact call site). The actual
    // crypto code never uses this value for anything Workers needs (no
    // separate .wasm fetch — this build embeds everything), so a harmless
    // stub URL satisfies the check without changing what gets loaded.
    if (typeof self !== "undefined" && !self.location) {
      self.location = { href: "https://workers.invalid/" };
    }
    const mod = require("libsodium-wrappers");
    sodium = mod.default || mod;
    await sodium.ready;
  } catch (e) {
    return { ok: false, detail: "Couldn't load the encryption library needed to push secrets. This is a Macless bug, not something on your end — try again in a moment, and if it keeps happening, contact support." };
  }
  const keyResp = await apiRequest(`/repos/${owner}/${repo}/actions/secrets/public-key`, token);
  if (!keyResp.ok) return { ok: false, detail: "Couldn't fetch the repo's secrets public key." };
  const { key, key_id } = keyResp.json;
  const binKey = sodium.from_base64(key, sodium.base64_variants.ORIGINAL);
  const binMsg = sodium.from_string(plaintext);
  const encrypted = sodium.crypto_box_seal(binMsg, binKey);
  const encryptedBase64 = sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL);
  return { ok: true, encryptedValue: encryptedBase64, keyId: key_id };
}

async function pushSecret(token, owner, repo, name, value) {
  const enc = await encryptForRepo(token, owner, repo, value);
  if (!enc.ok) return { ok: false, detail: enc.detail };
  const r = await apiRequest(`/repos/${owner}/${repo}/actions/secrets/${encodeURIComponent(name)}`, token, {
    method: "PUT",
    body: { encrypted_value: enc.encryptedValue, key_id: enc.keyId },
  });
  return { ok: r.ok, detail: r.ok ? "set" : (r.json && r.json.message) || `GitHub returned ${r.status}` };
}

async function pushVariable(token, owner, repo, name, value) {
  const create = await apiRequest(`/repos/${owner}/${repo}/actions/variables`, token, { method: "POST", body: { name, value } });
  if (create.ok) return { ok: true, detail: "set" };
  if (create.status === 409 || create.status === 422) {
    const update = await apiRequest(`/repos/${owner}/${repo}/actions/variables/${encodeURIComponent(name)}`, token, { method: "PATCH", body: { name, value } });
    return { ok: update.ok, detail: update.ok ? "set" : (update.json && update.json.message) || `GitHub returned ${update.status}` };
  }
  return { ok: false, detail: (create.json && create.json.message) || `GitHub returned ${create.status}` };
}

async function triggerWorkflow(token, owner, repo, workflowFile, ref = "main") {
  const r = await apiRequest(`/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflowFile)}/dispatches`, token, { method: "POST", body: { ref } });
  return { ok: r.ok, detail: r.ok ? "triggered" : (r.json && r.json.message) || `GitHub returned ${r.status}` };
}

async function listRuns(token, owner, repo, workflowFile, limit = 5) {
  const r = await apiRequest(`/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?per_page=${limit}`, token);
  if (!r.ok) return { ok: false, detail: (r.json && r.json.message) || `GitHub returned ${r.status}`, runs: [] };
  const runs = (r.json.workflow_runs || []).map((run) => ({ databaseId: run.id, status: run.status, conclusion: run.conclusion, createdAt: run.created_at, displayTitle: run.display_title }));
  return { ok: true, runs };
}

async function runStatus(token, owner, repo, runId) {
  const r = await apiRequest(`/repos/${owner}/${repo}/actions/runs/${runId}`, token);
  if (!r.ok) return { ok: false, detail: (r.json && r.json.message) || `GitHub returned ${r.status}` };
  return { ok: true, status: r.json.status, conclusion: r.json.conclusion };
}

async function failedLogs(token, owner, repo, runId) {
  const jobsResp = await apiRequest(`/repos/${owner}/${repo}/actions/runs/${runId}/jobs`, token);
  if (!jobsResp.ok) return { ok: false, log: "Couldn't list jobs for this run." };
  const failedJob = (jobsResp.json.jobs || []).find((j) => j.conclusion === "failure");
  if (!failedJob) return { ok: false, log: "No failed job found in this run." };
  const logResp = await fetch(`${API}/repos/${owner}/${repo}/actions/jobs/${failedJob.id}/logs`, { headers: { Authorization: `Bearer ${token}`, "User-Agent": "macless-backend" } }).catch(() => null);
  if (!logResp || !logResp.ok) return { ok: false, log: "Couldn't fetch the failed step's log." };
  return { ok: true, log: await logResp.text() };
}

export { authUrl, exchangeCode, whoAmI, listRepos, createRepo, commitFiles, listRepoPaths, pushSecret, pushVariable, triggerWorkflow, listRuns, runStatus, failedLogs };
