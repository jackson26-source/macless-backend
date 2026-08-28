(function () {
  var STEP_ORDER = ["connect", "scan", "configure", "push", "build", "rejection"];
  var state = {
    scan: null,
    secretValues: {}, // name -> { kind, value (text) or base64 (file) }
    autoFilled: {}, // name -> true, for fields Macless generated via auto-sign
    workflowFile: null,
    login: null,
    repos: [],
    owner: null,
    repo: null,
    defaultBranch: "main",
    connected: false,
    creatingNew: false,
  };

  function $(sel) { return document.querySelector(sel); }
  function $all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  function renderStepsNav(current) {
    var nav = $("#stepsNav");
    nav.innerHTML = "";
    var idx = STEP_ORDER.indexOf(current);
    STEP_ORDER.forEach(function (s, i) {
      var dot = document.createElement("div");
      dot.className = "step-dot" + (i < idx ? " done" : i === idx ? " active" : "");
      nav.appendChild(dot);
    });
  }

  function goTo(step) {
    $all(".panel").forEach(function (p) { p.classList.remove("active"); });
    var target = document.querySelector('.panel[data-step="' + step + '"]');
    if (target) target.classList.add("active");
    renderStepsNav(step);
    if (step === "connect") loadConnectStep();
    if (step === "scan") loadScan();
    if (step === "configure") renderSecretFields();
    if (step === "push") loadPushReady();
    if (step === "build") renderBuildControls();
  }

  document.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-next]");
    if (btn && !btn.disabled) goTo(btn.getAttribute("data-next"));
  });

  async function api(path, opts) {
    var res;
    try {
      res = await fetch(path, Object.assign({ headers: { "Content-Type": "application/json" }, credentials: "same-origin" }, opts || {}));
    } catch (err) {
      // fetch() itself threw (offline, DNS failure, CORS, etc). Every caller
      // already checks result.ok and re-enables its own button/shows its own
      // error — normalize to that shape instead of letting a spinner (e.g.
      // the Connect step's "Setting things up…") hang forever with no way
      // to recover short of reloading the page.
      return { ok: false, detail: "Network error — couldn't reach the server. Check your connection and try again." };
    }
    if (res.status === 401) {
      // Session expired or was never established — send back through the
      // purchase-verification/login flow rather than showing a dead wizard.
      window.location.href = "/login";
      return new Promise(function () {}); // never resolves; we're navigating away
    }
    try {
      return await res.json();
    } catch (err) {
      // Response came back but wasn't valid JSON (e.g. a proxy/edge error
      // page) — same reasoning as above, fail into the normal error path.
      return { ok: false, detail: "Unexpected response from the server (status " + res.status + "). Try again in a moment." };
    }
  }

  // ---- step: connect (repo picker — auth already happened before /app loaded) ----

  async function loadConnectStep() {
    var authStatus = await api("/api/auth/status");
    state.login = authStatus.login || null;
    $("#whoAmI").textContent = state.login || "…";

    var el = $("#repoStatus");
    el.innerHTML = '<p class="empty-state">Loading your repos…</p>';
    var reposResult = await api("/api/repos");
    state.repos = reposResult.ok ? reposResult.repos : [];
    renderRepoPicker();
  }

  function renderRepoPicker() {
    var el = $("#repoStatus");
    var options = state.repos
      .map(function (r) { return '<option value="' + escapeHtml(r.fullName) + '" data-owner="' + escapeHtml(r.owner) + '" data-name="' + escapeHtml(r.name) + '" data-branch="' + escapeHtml(r.defaultBranch) + '">' + escapeHtml(r.fullName) + "</option>"; })
      .join("");
    el.innerHTML =
      '<div class="field"><label>Use an existing repo</label>' +
      '<select id="repoSelect"><option value="">Choose one…</option>' + options + '</select>' +
      '<p class="hint">We only add the pipeline files (workflows, fastlane, docs) — anything already in the repo is left untouched.</p></div>' +
      '<div class="divider">or</div>' +
      '<div class="field"><label>Create a new repo</label>' +
      '<input type="text" id="newRepoName" placeholder="my-app">' +
      '<label class="checkbox" style="margin-top:8px;"><input type="checkbox" id="newRepoPrivate" checked> Private repo</label></div>';

    $("#repoSelect").addEventListener("change", function (e) {
      var opt = e.target.selectedOptions[0];
      if (!opt || !opt.value) { state.owner = null; state.repo = null; state.creatingNew = false; }
      else {
        var newOwner = opt.getAttribute("data-owner");
        var newRepo = opt.getAttribute("data-name");
        // Picking a different repo than the one already connected means the
        // user wants to switch targets, not just move on to the next step —
        // re-enable Connect so a real POST /api/connect fires against the
        // newly selected repo instead of the button staying permanently
        // disabled from the earlier connection (see updateConnectButton()).
        if (state.connected && (newOwner !== state.owner || newRepo !== state.repo)) {
          state.connected = false;
        }
        state.owner = newOwner;
        state.repo = newRepo;
        state.defaultBranch = opt.getAttribute("data-branch") || "main";
        state.creatingNew = false;
        $("#newRepoName").value = "";
      }
      updateConnectButton();
    });
    $("#newRepoName").addEventListener("input", function (e) {
      if (e.target.value.trim()) {
        // Typing a brand-new repo name is also switching targets — same
        // reasoning as the repoSelect branch above.
        if (state.connected) state.connected = false;
        state.creatingNew = true;
        state.owner = null;
        state.repo = null;
        $("#repoSelect").value = "";
      } else {
        state.creatingNew = false;
      }
      updateConnectButton();
    });
    updateConnectButton();
  }

  function updateConnectButton() {
    var ready = state.connected ? false : (!!(state.owner && state.repo) || (state.creatingNew && $("#newRepoName") && $("#newRepoName").value.trim()));
    $("#connectBtn").disabled = !ready;
  }

  $("#connectBtn") && $("#connectBtn").addEventListener("click", async function (e) {
    if (state.connected) return; // data-next handles navigation once already connected
    e.preventDefault();
    var resultEl = $("#connectResult");
    resultEl.innerHTML = '<p class="empty-state">Setting things up — this can take a few seconds…</p>';
    $("#connectBtn").disabled = true;

    var body = state.creatingNew
      ? { newRepoName: $("#newRepoName").value.trim(), private: $("#newRepoPrivate").checked }
      : { owner: state.owner, repo: state.repo, defaultBranch: state.defaultBranch };

    var result = await api("/api/connect", { method: "POST", body: JSON.stringify(body) });
    if (!result.ok) {
      resultEl.innerHTML = '<div class="card"><h3>Couldn\'t connect</h3><p>' + escapeHtml(result.detail || "unknown error") + "</p></div>";
      $("#connectBtn").disabled = false;
      return;
    }
    state.connected = true;
    state.owner = result.owner;
    state.repo = result.repo;
    state.defaultBranch = result.defaultBranch || "main";
    var addedNote = result.filesWritten === 0 ? "Repo already had every pipeline file." : "Added " + result.filesWritten + " file" + (result.filesWritten === 1 ? "" : "s") + ".";
    resultEl.innerHTML = '<div class="card"><h3>Connected</h3><p>Connected to <code>' + escapeHtml(state.owner + "/" + state.repo) + "</code>. " + addedNote + "</p></div>";
    $("#repoPath").textContent = state.owner + "/" + state.repo;
    goTo("scan");
  });

  // ---- step: scan ----
  async function loadScan() {
    var el = $("#scanResult");
    el.innerHTML = '<p class="empty-state">Scanning .github/workflows…</p>';
    var result = await api("/api/scan?owner=" + encodeURIComponent(state.owner) + "&repo=" + encodeURIComponent(state.repo));
    state.scan = result;

    if (!result.ok) {
      el.innerHTML = '<div class="card"><h3>No workflows found</h3><p>Didn\'t find any <code>.yml</code> files under <code>.github/workflows</code> in this repo.</p></div>';
      $("#toConfigure").disabled = true;
      return;
    }

    var html = "";
    result.workflows.forEach(function (w) {
      html +=
        '<div class="card"><h3>' + escapeHtml(w.name) + " <span class=\"mono hint\">(" + escapeHtml(w.file) + ')</span></h3>' +
        "<p>" + w.refs.length + " reference" + (w.refs.length === 1 ? "" : "s") + " to secrets/variables</p></div>";
    });
    var required = result.secrets.filter(function (s) { return s.required; });
    var optional = result.secrets.filter(function (s) { return !s.required; });
    html += '<div class="card"><h3>All secrets &amp; variables across every workflow (' + result.secrets.length + ")</h3><div class=\"secret-list\">";
    html += '<p class="hint">' + required.length + " required, " + optional.length + " optional (already have a default in the workflow unless you override them).</p>";
    result.secrets.forEach(function (s) {
      html +=
        '<div class="secret-row"><span class="name">' + escapeHtml(s.name) +
        '</span><span class="mono hint" style="margin-left:6px;">' + (s.scope === "variable" ? "variable" : "secret") +
        (s.required ? "" : ", optional") + "</span><span class=\"label\">" +
        escapeHtml(s.label || "(no description matched — will still be asked for)") + "</span></div>";
    });
    html += "</div></div>";
    el.innerHTML = html;
    $("#toConfigure").disabled = result.secrets.length === 0;

    if (result.workflows.length > 0) state.workflowFile = result.workflows[0].file;
  }

  // ---- step: configure ----
  function fieldHtml(s) {
    var wrap = document.createElement("div");
    wrap.className = "field";
    var isFile = s.kind === "file-base64";
    var isSecretText = s.kind === "secret-text";
    var isManual = s.kind === "manual-elsewhere";
    var usedByHint = s.usedBy && s.usedBy.length ? '<p class="hint" style="margin:2px 0 6px;">used by: ' + escapeHtml(s.usedBy.join(", ")) + "</p>" : "";
    var labelHtml =
      "<label>" + escapeHtml(s.label || s.name) + ' <span class="mono hint">' + escapeHtml(s.name) +
      "</span> <span class=\"mono hint\">(" + (s.scope === "variable" ? "variable" : "secret") + ")</span></label>";

    if (state.autoFilled && state.autoFilled[s.name]) {
      wrap.innerHTML =
        labelHtml + usedByHint +
        '<p class="hint"><span class="status-badge ok">auto-generated</span> by Macless — ' +
        '<a href="#" data-clear-auto="' + s.name + '">use my own instead</a></p>';
      return wrap;
    }

    wrap.innerHTML =
      labelHtml + usedByHint +
      (isFile
        ? '<input type="file" data-secret="' + s.name + '" data-kind="file" data-scope="' + s.scope + '">'
        : isManual
        ? '<textarea data-secret="' + s.name + '" data-kind="text" data-scope="' + s.scope + '" placeholder="Paste the file contents here once you have it — see the label above for where to get it."></textarea>'
        : '<input type="' + (isSecretText ? "password" : "text") + '" data-secret="' + s.name + '" data-kind="text" data-scope="' + s.scope + '">');
    return wrap;
  }

  document.addEventListener("click", function (e) {
    var link = e.target.closest("[data-clear-auto]");
    if (!link) return;
    e.preventDefault();
    var name = link.getAttribute("data-clear-auto");
    if (state.autoFilled) delete state.autoFilled[name];
    delete state.secretValues[name];
    renderSecretFields();
  });

  function renderSecretFields() {
    var el = $("#secretFields");
    if (!state.scan || !state.scan.ok) {
      el.innerHTML = '<p class="empty-state">Run the scan step first.</p>';
      return;
    }
    el.innerHTML = "";
    var required = state.scan.secrets.filter(function (s) { return s.required; });
    var optional = state.scan.secrets.filter(function (s) { return !s.required; });

    required.forEach(function (s) { el.appendChild(fieldHtml(s)); });

    if (optional.length) {
      var details = document.createElement("details");
      details.className = "advanced";
      var summary = document.createElement("summary");
      summary.textContent = "Advanced / optional (" + optional.length + ") — already have a working default, only touch these if you know you need to";
      details.appendChild(summary);
      optional.forEach(function (s) { details.appendChild(fieldHtml(s)); });
      el.appendChild(details);
    }

    var hasSigningFields = state.scan.secrets.some(function (s) { return /PROFILE|MOBILEPROVISION|CERT|KEYSTORE/i.test(s.name); });
    $("#signingDoctorCard").style.display = hasSigningFields ? "block" : "none";
    // Auto-sign only covers iOS (cert/profile), not Android keystores —
    // only show it when there's actually a cert/profile field it could fill.
    var hasIosSigningFields = state.scan.secrets.some(function (s) { return /PROFILE|MOBILEPROVISION|CERT/i.test(s.name); });
    $("#autoSignCard").style.display = hasIosSigningFields ? "block" : "none";
  }

  // ---- Auto-sign: generate a cert/profile/.p12 via the buyer's own Apple API key ----
  var AUTO_SIGN_FIELD_PATTERNS = {
    p12: /CERT.*BASE64|DIST.*CERT/i,
    p12Password: /CERT.*PASS|P12.*PASS/i,
    profile: /PROFILE|MOBILEPROVISION/i,
    teamId: /TEAM_?ID/i,
  };

  function applyAutoSignResult(result) {
    if (!state.scan || !state.scan.secrets) return;
    state.autoFilled = state.autoFilled || {};
    state.scan.secrets.forEach(function (s) {
      if (AUTO_SIGN_FIELD_PATTERNS.p12.test(s.name)) {
        state.secretValues[s.name] = { kind: "file-base64", scope: s.scope, base64: result.p12Base64, filename: "signing.p12" };
        state.autoFilled[s.name] = true;
      } else if (AUTO_SIGN_FIELD_PATTERNS.p12Password.test(s.name)) {
        state.secretValues[s.name] = { kind: "text", scope: s.scope, value: result.p12Password };
        state.autoFilled[s.name] = true;
      } else if (AUTO_SIGN_FIELD_PATTERNS.profile.test(s.name)) {
        state.secretValues[s.name] = { kind: "file-base64", scope: s.scope, base64: result.profileBase64, filename: "profile.mobileprovision" };
        state.autoFilled[s.name] = true;
      } else if (AUTO_SIGN_FIELD_PATTERNS.teamId.test(s.name)) {
        state.secretValues[s.name] = { kind: "text", scope: s.scope, value: result.teamId };
        state.autoFilled[s.name] = true;
      }
    });
  }

  function readFileAsText(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = reject;
      reader.readAsText(file);
    });
  }

  $("#autoSignBtn") && $("#autoSignBtn").addEventListener("click", async function () {
    var statusEl = $("#autoSignStatus");
    var btn = $("#autoSignBtn");
    var keyId = $("#autoSignKeyId").value.trim();
    var issuerId = $("#autoSignIssuerId").value.trim();
    var bundleId = $("#autoSignBundleId").value.trim();
    var file = $("#autoSignP8File").files[0];

    if (!keyId || !issuerId || !bundleId || !file) {
      statusEl.innerHTML = '<p class="empty-state">Fill in the Key ID, Issuer ID, bundle identifier, and choose your .p8 file first.</p>';
      return;
    }

    btn.disabled = true;
    statusEl.innerHTML = '<p class="hint">Talking to Apple’s API — this can take a few seconds…</p>';
    try {
      var p8Pem = await readFileAsText(file);
      var result = await api("/api/auto-sign", {
        method: "POST",
        body: JSON.stringify({ keyId: keyId, issuerId: issuerId, p8Pem: p8Pem, bundleIdentifier: bundleId }),
      });
      if (!result.ok) {
        statusEl.innerHTML = '<p class="empty-state">' + escapeHtml(result.detail || "Something went wrong.") + "</p>";
      } else {
        applyAutoSignResult(result);
        renderSecretFields();
        statusEl.innerHTML = '<p class="hint">Done — certificate and profile generated and filled in below. Review them, then continue.</p>';
      }
    } catch (e) {
      statusEl.innerHTML = '<p class="empty-state">Something went wrong talking to Apple’s API. Try again in a moment.</p>';
    }
    btn.disabled = false;
  });

  // ---- Signing Doctor (checks whatever cert/profile/keystore fields have been filled in above) ----
  function findSecretValueByPattern(pattern) {
    var name = Object.keys(state.secretValues).find(function (n) { return pattern.test(n); });
    return name ? state.secretValues[name] : null;
  }

  // Shared by the Configure-step button AND the build-failure auto-check below
  // (see pollBuildStatus) — one diagnosis engine, run from wherever it's useful,
  // instead of a one-off click handler duplicated in two places.
  function buildSigningDoctorRequestBody() {
    var profile = findSecretValueByPattern(/PROFILE|MOBILEPROVISION/i);
    var cert = findSecretValueByPattern(/CERT.*BASE64|DIST.*CERT/i);
    var certPassword = findSecretValueByPattern(/CERT.*PASS|P12.*PASS/i);
    var teamId = findSecretValueByPattern(/TEAM_?ID/i);
    var bundleId = findSecretValueByPattern(/BUNDLE_?ID/i);
    var keystore = findSecretValueByPattern(/KEYSTORE.*BASE64|ANDROID.*KEYSTORE/i);
    var keystorePassword = findSecretValueByPattern(/KEYSTORE.*PASS/i);
    var keyAlias = findSecretValueByPattern(/KEY.*ALIAS/i);
    var keyPassword = findSecretValueByPattern(/KEY_?PASS(WORD)?/i);

    if (!profile && !keystore) return null;

    var body = {};
    if (profile) {
      body.profileBase64 = profile.base64;
      if (teamId && teamId.value) body.expectedTeamId = teamId.value;
      if (bundleId && bundleId.value) body.expectedBundleId = bundleId.value;
      if (cert) {
        body.certBase64 = cert.base64;
        body.certPassword = certPassword ? certPassword.value : "";
      }
    }
    if (keystore) {
      body.androidKeystoreBase64 = keystore.base64;
      body.androidKeystorePassword = keystorePassword ? keystorePassword.value : "";
      if (keyAlias && keyAlias.value) body.androidKeyAlias = keyAlias.value;
      if (keyPassword && keyPassword.value) body.androidKeyPassword = keyPassword.value;
    }
    return body;
  }

  // Closes the loop from the Configure step too: once you've checked (and
  // fixed) your signing files here, push + rebuild without walking back
  // through the wizard to do it.
  function rebuildNow() {
    goTo("build");
    if ($("#workflowSelect") && state.workflowFile) $("#workflowSelect").value = state.workflowFile;
    triggerBuild();
  }

  $("#signingDoctorBtn") && $("#signingDoctorBtn").addEventListener("click", async function () {
    var out = $("#signingDoctorOutput");
    out.style.display = "block";
    out.textContent = "Checking…";
    if ($("#signingRebuildBtn")) $("#signingRebuildBtn").style.display = "none";

    var body = buildSigningDoctorRequestBody();
    if (!body) {
      out.textContent = "Choose a provisioning profile and/or an Android keystore file above first.";
      return;
    }

    var result = await api("/api/diagnose-signing", { method: "POST", body: JSON.stringify(body) });
    out.textContent = result.output || "(no output)";
    if (state.connected && state.workflowFile && $("#signingRebuildBtn")) {
      $("#signingRebuildBtn").style.display = "inline-block";
    }
  });

  $("#signingRebuildBtn") && $("#signingRebuildBtn").addEventListener("click", rebuildNow);

  document.addEventListener("change", async function (e) {
    var input = e.target.closest('input[data-kind="file"]');
    if (!input) return;
    var name = input.getAttribute("data-secret");
    var scope = input.getAttribute("data-scope") || "secret";
    var file = input.files[0];
    if (!file) return;
    var base64 = await fileToBase64(file);
    state.secretValues[name] = { kind: "file-base64", scope: scope, base64: base64, filename: file.name };
  });

  document.addEventListener("input", function (e) {
    var input = e.target.closest('[data-kind="text"]');
    if (!input) return;
    var name = input.getAttribute("data-secret");
    var scope = input.getAttribute("data-scope") || "secret";
    state.secretValues[name] = { kind: "text", scope: scope, value: input.value };
  });

  function fileToBase64(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var result = reader.result;
        var base64 = result.substring(result.indexOf(",") + 1);
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  // ---- step: push ----
  function loadPushReady() {
    $("#pushBtn").disabled = false;
  }

  $("#pushBtn") && $("#pushBtn").addEventListener("click", async function () {
    var el = $("#pushResult");
    el.innerHTML = "";
    var names = Object.keys(state.secretValues);
    if (names.length === 0) {
      el.innerHTML = '<p class="empty-state">Nothing filled in yet — go back and fill in at least one field.</p>';
      return;
    }
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      var entry = state.secretValues[name];
      var value = entry.kind === "file-base64" ? entry.base64 : entry.value;
      var row = document.createElement("div");
      row.className = "status-line";
      row.innerHTML = '<span class="status-badge pending">pushing</span><span>' + escapeHtml(name) + "</span>";
      el.appendChild(row);
      var result = await api("/api/push-secret", { method: "POST", body: JSON.stringify({ owner: state.owner, repo: state.repo, name: name, value: value, scope: entry.scope || "secret" }) });
      row.innerHTML =
        '<span class="status-badge ' + (result.ok ? "ok" : "fail") + '">' + (result.ok ? "pushed" : "failed") + "</span><span>" +
        escapeHtml(name) + "</span>" + (result.ok ? "" : ' <span class="hint">' + escapeHtml(result.detail || "") + "</span>");
    }
    $("#toBuild").disabled = false;
  });

  // ---- step: build ----
  function renderBuildControls() {
    var el = $("#buildControls");
    if (!state.scan || !state.scan.ok || state.scan.workflows.length === 0) {
      el.innerHTML = '<p class="empty-state">Run the scan step first.</p>';
      return;
    }
    var opts = state.scan.workflows
      .map(function (w) { return '<option value="' + escapeHtml(w.file) + '">' + escapeHtml(w.name) + "</option>"; })
      .join("");
    el.innerHTML =
      '<div class="field"><label>Workflow to run</label><select id="workflowSelect">' + opts + "</select></div>" +
      '<button class="btn" id="triggerBtn">Trigger build</button>';
    $("#workflowSelect").value = state.workflowFile || state.scan.workflows[0].file;
    $("#workflowSelect").addEventListener("change", function (e) { state.workflowFile = e.target.value; });
    $("#triggerBtn").addEventListener("click", triggerBuild);
  }

  async function triggerBuild() {
    var statusEl = $("#buildStatus");
    statusEl.innerHTML = '<p class="empty-state">Triggering…</p>';
    var result = await api("/api/trigger-build", { method: "POST", body: JSON.stringify({ owner: state.owner, repo: state.repo, workflowFile: state.workflowFile, ref: state.defaultBranch }) });
    if (!result.ok) {
      statusEl.innerHTML = '<div class="card"><h3>Couldn\'t trigger</h3><p>' + escapeHtml(result.detail || "") + "</p></div>";
      return;
    }
    statusEl.innerHTML = '<p class="empty-state">Triggered — waiting for it to show up in the run list…</p>';
    pollBuildStatus();
  }

  async function pollBuildStatus() {
    var statusEl = $("#buildStatus");
    var result = await api("/api/build-status?owner=" + encodeURIComponent(state.owner) + "&repo=" + encodeURIComponent(state.repo) + "&workflowFile=" + encodeURIComponent(state.workflowFile));
    if (!result.ok || !result.runs || result.runs.length === 0) {
      statusEl.innerHTML = '<p class="empty-state">No runs yet — checking again…</p>';
      setTimeout(pollBuildStatus, 5000);
      return;
    }
    var run = result.runs[0];
    var badge = run.status === "completed" ? (run.conclusion === "success" ? "ok" : "fail") : "pending";
    var label = run.status === "completed" ? run.conclusion : run.status;
    statusEl.innerHTML =
      '<div class="status-line"><span class="status-badge ' + badge + '">' + escapeHtml(label) + "</span><span>" +
      escapeHtml(run.displayTitle || "run #" + run.databaseId) + "</span></div>";

    if (run.status !== "completed") {
      setTimeout(pollBuildStatus, 5000);
      return;
    }

    // Close the loop: diagnose -> fix -> resubmit as one motion on this same
    // panel, instead of three separate stitched-together tools (check logs
    // elsewhere, fix elsewhere, come back and manually re-run from GitHub).
    if (run.conclusion !== "success") {
      var logs = await api("/api/build-logs?owner=" + encodeURIComponent(state.owner) + "&repo=" + encodeURIComponent(state.repo) + "&runId=" + run.databaseId);
      var logDiv = document.createElement("div");
      logDiv.className = "log-output";
      logDiv.textContent = logs.log || "(couldn't fetch failed step logs)";
      statusEl.appendChild(logDiv);

      var signingBody = buildSigningDoctorRequestBody();
      if (signingBody) {
        var sdHeading = document.createElement("p");
        sdHeading.className = "hint";
        sdHeading.style.marginTop = "10px";
        sdHeading.textContent = "Running Signing Doctor against the cert/profile/keystore fields from the Signing setup step, since a signing mismatch is the single hardest failure to spot by eye:";
        statusEl.appendChild(sdHeading);

        var sdOut = document.createElement("div");
        sdOut.className = "log-output";
        sdOut.textContent = "Checking…";
        statusEl.appendChild(sdOut);

        var sdResult = await api("/api/diagnose-signing", { method: "POST", body: JSON.stringify(signingBody) });
        sdOut.textContent = sdResult.output || "(no output)";
      } else {
        var hint = document.createElement("p");
        hint.className = "hint";
        hint.style.marginTop = "10px";
        hint.textContent = "No cert/profile/keystore field is filled in above to check automatically — if this looks like a signing error, go back to Signing setup and fill those in. If Apple later sends a rejection instead, paste it into Rejection Doctor below.";
        statusEl.appendChild(hint);
      }
    }

    var rebuildBtn = document.createElement("button");
    rebuildBtn.className = "btn btn-secondary";
    rebuildBtn.style.marginTop = "12px";
    rebuildBtn.textContent = "Rebuild now";
    rebuildBtn.addEventListener("click", triggerBuild);
    statusEl.appendChild(rebuildBtn);
  }

  // ---- step: rejection ----
  $("#rdBtn") && $("#rdBtn").addEventListener("click", async function () {
    var text = $("#rdInput").value;
    var result = await api("/api/diagnose-rejection", { method: "POST", body: JSON.stringify({ text: text }) });
    $("#rdCount").textContent = result.message || "";
    var el = $("#rdResults");
    el.innerHTML = "";
    (result.matches || []).forEach(function (m) {
      var div = document.createElement("div");
      div.className = "rd-match";
      var guidelineLine = m.guideline && m.guideline !== "—" ? "Guideline " + m.guideline : "No specific guideline number, common pattern";
      div.innerHTML =
        '<div class="rd-guideline">' + escapeHtml(guidelineLine) + "</div><h3>" + escapeHtml(m.title) + "</h3>" +
        '<p><span class="rd-label">What this usually means: </span>' + escapeHtml(m.explain) + "</p>" +
        '<p><span class="rd-label">What to actually do: </span>' + escapeHtml(m.fix) + "</p>";

      var appealBtn = document.createElement("button");
      appealBtn.className = "btn btn-secondary";
      appealBtn.style.marginTop = "8px";
      appealBtn.textContent = "Draft Resolution Center reply";
      var appealOut = document.createElement("div");
      appealOut.className = "log-output";
      appealOut.style.display = "none";
      appealOut.style.marginTop = "8px";
      appealBtn.addEventListener("click", async function () {
        appealBtn.disabled = true;
        var letter = await api("/api/appeal-letter", {
          method: "POST",
          body: JSON.stringify({ match: m, appName: state.repo || undefined }),
        });
        appealBtn.disabled = false;
        appealOut.style.display = "block";
        if (letter && letter.ok) {
          appealOut.textContent = "Subject: " + letter.subject + "\n\n" + letter.body;
        } else {
          appealOut.textContent = (letter && (letter.error || letter.detail)) || "Couldn't draft a reply for this match.";
        }
      });
      div.appendChild(appealBtn);
      div.appendChild(appealOut);
      el.appendChild(div);
    });
    // Once you've made whatever fix a match pointed to (code, entitlements,
    // config already pushed to the repo), confirm it without leaving this page.
    var rebuildWrap = $("#rejectionRebuildWrap");
    if (rebuildWrap) rebuildWrap.style.display = (state.connected && state.workflowFile && (result.matches || []).length > 0) ? "block" : "none";
  });

  $("#rejectionRebuildBtn") && $("#rejectionRebuildBtn").addEventListener("click", rebuildNow);

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  goTo("connect");
})();
