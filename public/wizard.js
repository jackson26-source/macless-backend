(function () {
  // Phase 3 restructuring: this used to be a linear one-time wizard
  // (connect -> scan -> configure -> push -> build -> rejection) that was
  // "finished" once you'd been through it. It's now a persistent left-nav
  // shell — Project / Build & Sign / Simulator / Store Listing / Doctors /
  // Settings are all standing pages you can jump to any time, since
  // Simulator checks, expiry monitoring, and a store listing are all
  // things a buyer comes back to repeatedly, not just once. Every API
  // call below is unchanged from the old wizard; only the routing/layout
  // around them changed.
  var state = {
    scan: null,
    detected: null, // best-effort project detection from /api/scan-project — bundleId, packageName, deploymentTarget, platform, capabilities
    secretValues: {}, // name -> { kind, value (text) or base64 (file), filename (file only) }
    autoFilled: {}, // name -> true, for fields Macless generated via auto-sign
    workflowFile: null,
    simulatorWorkflowFile: null, // auto-detected simulator-preview-style workflow, for the Simulator section
    privacySignals: null,
    login: null,
    repos: [],
    owner: null,
    repo: null,
    defaultBranch: "main",
    connected: false,
    creatingNew: false,
    currentSection: "project",
  };

  function $(sel) { return document.querySelector(sel); }
  function $all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  // ---- nav / section switching ----
  function unlockSections() {
    $all(".nav-item").forEach(function (btn) {
      var s = btn.getAttribute("data-section");
      if (s === "project" || s === "doctors" || s === "settings") { btn.disabled = false; return; }
      btn.disabled = !state.connected;
    });
    var hint = $("#navHint");
    if (hint) hint.style.display = state.connected ? "none" : "block";
  }

  function switchSection(section) {
    state.currentSection = section;
    $all(".panel").forEach(function (p) { p.classList.toggle("active", p.getAttribute("data-section") === section); });
    $all(".nav-item").forEach(function (btn) { btn.classList.toggle("active", btn.getAttribute("data-section") === section); });
    if (section === "project") loadConnectStep();
    if (section === "build") renderSecretFields();
    if (section === "simulator") renderSimulatorSection();
    if (section === "store") renderStoreSection();
    if (section === "doctors") renderDoctorsSection();
    if (section === "settings") renderSettingsSection();
  }

  $all(".nav-item").forEach(function (btn) {
    btn.addEventListener("click", function () {
      if (btn.disabled) return;
      switchSection(btn.getAttribute("data-section"));
    });
  });

  async function api(path, opts) {
    var res;
    try {
      res = await fetch(path, Object.assign({ headers: { "Content-Type": "application/json" }, credentials: "same-origin" }, opts || {}));
    } catch (err) {
      // fetch() itself threw (offline, DNS failure, CORS, etc). Every caller
      // already checks result.ok and re-enables its own button/shows its own
      // error — normalize to that shape instead of letting a spinner hang
      // forever with no way to recover short of reloading the page.
      return { ok: false, detail: "Network error — couldn't reach the server. Check your connection and try again." };
    }
    if (res.status === 401) {
      // Session expired or was never established — send back through the
      // purchase-verification/login flow rather than showing a dead page.
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

  // ---- section: Project (repo picker + "what's in this repo") ----

  async function loadConnectStep() {
    var authStatus = await api("/api/auth/status");
    state.login = authStatus.login || null;
    $("#whoAmI").textContent = state.login || "…";

    if (state.connected && state.owner && state.repo) {
      renderConnectedRepoCard();
      return;
    }

    var el = $("#repoStatus");
    el.innerHTML = '<p class="empty-state">Loading your repos…</p>';
    $("#connectBtn").style.display = "inline-block";
    var reposResult = await api("/api/repos");
    if (!reposResult.ok) {
      el.innerHTML = '<p class="empty-state">' + escapeHtml(reposResult.detail || "Couldn't load your repos.") + "</p>";
      $("#connectBtn").style.display = "none";
      return;
    }
    state.repos = reposResult.repos;
    renderRepoPicker();
  }

  function renderConnectedRepoCard() {
    $("#repoStatus").innerHTML =
      '<div class="status-line"><span class="status-badge ok">connected</span><span>' + escapeHtml(state.owner + "/" + state.repo) + "</span></div>" +
      '<p class="hint" style="margin-top:8px;">Want a different repo? <a href="#" id="switchRepoLink">switch repos</a> — nothing about your current repo is touched until you connect a new one.</p>';
    $("#connectBtn").style.display = "none";
    var link = $("#switchRepoLink");
    if (link) link.addEventListener("click", function (e) { e.preventDefault(); disconnectRepo(); });
  }

  function disconnectRepo() {
    state.connected = false;
    $("#projectScanWrap").style.display = "none";
    unlockSections();
    loadConnectStep();
  }

  function renderRepoPicker() {
    var el = $("#repoStatus");
    var options = state.repos
      .map(function (r) { return '<option value="' + escapeHtml(r.fullName) + '" data-owner="' + escapeHtml(r.owner) + '" data-name="' + escapeHtml(r.name) + '" data-branch="' + escapeHtml(r.defaultBranch) + '">' + escapeHtml(r.fullName) + "</option>"; })
      .join("");
    el.innerHTML =
      '<div class="field"><label>Use an existing repo</label>' +
      '<select id="repoSelect"><option value="">Choose one…</option>' + options + "</select>" +
      '<p class="hint">We only add the pipeline files (workflows, fastlane, docs) — anything already in the repo is left untouched.</p></div>' +
      '<div class="divider">or</div>' +
      '<div class="field"><label>Create a new repo</label>' +
      '<input type="text" id="newRepoName" placeholder="my-app">' +
      '<label class="checkbox" style="margin-top:8px;"><input type="checkbox" id="newRepoPrivate" checked> Private repo</label></div>';

    $("#repoSelect").addEventListener("change", function (e) {
      var opt = e.target.selectedOptions[0];
      if (!opt || !opt.value) { state.owner = null; state.repo = null; state.creatingNew = false; }
      else {
        state.owner = opt.getAttribute("data-owner");
        state.repo = opt.getAttribute("data-name");
        state.defaultBranch = opt.getAttribute("data-branch") || "main";
        state.creatingNew = false;
        $("#newRepoName").value = "";
      }
      updateConnectButton();
    });
    $("#newRepoName").addEventListener("input", function (e) {
      if (e.target.value.trim()) {
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
    var ready = !!(state.owner && state.repo) || (state.creatingNew && $("#newRepoName") && $("#newRepoName").value.trim());
    $("#connectBtn").disabled = !ready;
  }

  $("#connectBtn") && $("#connectBtn").addEventListener("click", async function (e) {
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
    renderConnectedRepoCard();
    unlockSections();
    await loadScan();
    // First-time convenience: after connecting, the natural next stop is
    // filling in signing setup — but every section stays reachable from
    // here on, this is just where a first-time buyer would look next.
    switchSection("build");
  });

  // ---- section: Project, part 2 ("what's in this repo") ----
  async function loadScan() {
    if (!state.owner || !state.repo) return;
    var el = $("#scanResult");
    $("#projectScanWrap").style.display = "block";
    el.innerHTML = '<p class="empty-state">Scanning .github/workflows…</p>';
    var result = await api("/api/scan?owner=" + encodeURIComponent(state.owner) + "&repo=" + encodeURIComponent(state.repo));
    state.scan = result;

    if (!result.ok) {
      el.innerHTML = '<div class="card"><h3>No workflows found</h3><p>Didn\'t find any <code>.yml</code> files under <code>.github/workflows</code> in this repo.</p></div>';
      refreshDependentSections();
      return;
    }

    // Best-effort read of the buyer's own project files, alongside the
    // workflow scan above — never blocks Scan from finishing if this
    // fails or comes back empty, it only pre-fills Build & Sign's fields.
    state.detected = null;
    try {
      var projResult = await api(
        "/api/scan-project?owner=" + encodeURIComponent(state.owner) + "&repo=" + encodeURIComponent(state.repo) +
        "&defaultBranch=" + encodeURIComponent(state.defaultBranch)
      );
      if (projResult.ok) state.detected = projResult.detected;
    } catch (e) { /* Build & Sign just falls back to manual entry */ }

    var html = "";

    if (state.detected && (state.detected.bundleId || state.detected.packageName || state.detected.platform)) {
      var d = state.detected;
      html += '<div class="card"><h3>Detected from your project</h3><p class="hint">Found by reading your repo\'s own project files — review these, they\'re pre-filled in Build &amp; Sign but not locked in.</p><ul class="plain">';
      if (d.platform) html += "<li>Platform: <b>" + escapeHtml(d.platform) + "</b></li>";
      if (d.bundleId) html += "<li>iOS bundle ID: <b class=\"mono\">" + escapeHtml(d.bundleId) + "</b></li>";
      if (d.packageName) html += "<li>Android package name: <b class=\"mono\">" + escapeHtml(d.packageName) + "</b></li>";
      if (d.deploymentTarget) html += "<li>iOS deployment target: <b>" + escapeHtml(d.deploymentTarget) + "</b></li>";
      if (d.capabilities && d.capabilities.length) {
        html += "<li>Capabilities found in your entitlements file: <b>" + d.capabilities.map(function (c) { return escapeHtml(c.label); }).join(", ") + "</b> — Apple will ask about these at submission time, good to know now.</li>";
      }
      html += "</ul></div>";
    }

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

    if (result.workflows.length > 0) {
      state.workflowFile = result.workflows[0].file;
      var simWf = result.workflows.find(function (w) { return /simulator/i.test(w.file) || /simulator/i.test(w.name); });
      state.simulatorWorkflowFile = simWf ? simWf.file : null;
    }

    refreshDependentSections();
  }

  // Build & Sign / Simulator both render from state.scan — if either is
  // the section currently on screen when a (re-)scan finishes, refresh it
  // in place instead of leaving stale content up.
  function refreshDependentSections() {
    if (state.currentSection === "build") renderSecretFields();
    if (state.currentSection === "simulator") renderSimulatorSection();
  }

  // ---- section: Build & Sign ----
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

    // Pre-fill from /api/scan-project, if this field's exact name matches
    // something the project scan actually found — deliberately exact-name
    // matching only (not the generic BUNDLE_ID/PACKAGE_NAME fallback regex
    // in workflow-scan.js's HINTS), so a detected iOS value can never land
    // in an Android field or vice versa. Still just a default: it's a
    // normal editable text input, and typing into it overwrites this the
    // same way as any other field.
    var detectedValue = null;
    if (!isFile && !isManual && state.detected) {
      if (/^IOS_BUNDLE_ID$/i.test(s.name) && state.detected.bundleId) detectedValue = state.detected.bundleId;
      else if (/^ANDROID_PACKAGE_NAME$/i.test(s.name) && state.detected.packageName) detectedValue = state.detected.packageName;
    }
    if (detectedValue && !(state.secretValues[s.name] && state.secretValues[s.name].kind === "text")) {
      state.secretValues[s.name] = { kind: "text", scope: s.scope, value: detectedValue };
    }
    var detectedHint = detectedValue ? '<p class="hint"><span class="status-badge ok">detected</span> from your project — edit if this is wrong</p>' : "";

    // Persistent-shell change from the old one-time wizard: this panel is
    // now something you come back to, possibly minutes or days later, so
    // re-rendering it must not silently drop whatever was already typed
    // in — restore from state.secretValues (which detectedValue above may
    // itself have just seeded) rather than always starting blank.
    var existingTextValue = (!isFile && !isManual && state.secretValues[s.name] && state.secretValues[s.name].kind === "text") ? state.secretValues[s.name].value : null;
    var existingManualValue = (isManual && state.secretValues[s.name] && state.secretValues[s.name].kind === "text") ? state.secretValues[s.name].value : null;
    var existingFileName = (isFile && state.secretValues[s.name] && state.secretValues[s.name].kind === "file-base64") ? state.secretValues[s.name].filename : null;

    wrap.innerHTML =
      labelHtml + usedByHint + detectedHint +
      (isFile
        ? '<input type="file" data-secret="' + s.name + '" data-kind="file" data-scope="' + s.scope + '">' +
          (existingFileName ? '<p class="hint">Already selected: ' + escapeHtml(existingFileName) + " — choose again to replace it.</p>" : "")
        : isManual
        ? '<textarea data-secret="' + s.name + '" data-kind="text" data-scope="' + s.scope + '" placeholder="Paste the file contents here once you have it — see the label above for where to get it.">' +
          (existingManualValue ? escapeHtml(existingManualValue) : "") + "</textarea>"
        : '<input type="' + (isSecretText ? "password" : "text") + '" data-secret="' + s.name + '" data-kind="text" data-scope="' + s.scope + '"' +
          (existingTextValue ? ' value="' + escapeHtml(existingTextValue) + '"' : "") + ">");
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
      el.innerHTML = '<p class="empty-state">Connect a repo in Project first.</p>';
      $("#pushBtn").disabled = true;
      $("#autoSignCard").style.display = "none";
      renderBuildControls();
      updateDoctorAvailability();
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

    $("#pushBtn").disabled = false;

    // Auto-sign only covers iOS (cert/profile), not Android keystores —
    // only show it when there's actually a cert/profile field it could fill.
    var hasIosSigningFields = state.scan.secrets.some(function (s) { return /PROFILE|MOBILEPROVISION|CERT/i.test(s.name); });
    $("#autoSignCard").style.display = hasIosSigningFields ? "block" : "none";

    renderBuildControls();
    updateDoctorAvailability();
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
      // Password check MUST run before the p12-file check: DIST.*CERT (meant
      // to catch IOS_DIST_CERT_P12_BASE64) also matches IOS_DIST_CERT_PASSWORD,
      // and with the file-check first that overwrote the password field with
      // the .p12 file's own base64 instead of the real password -- every
      // auto-signed .p12 was then "unlockable" with nothing but its own bytes.
      if (AUTO_SIGN_FIELD_PATTERNS.p12Password.test(s.name)) {
        state.secretValues[s.name] = { kind: "text", scope: s.scope, value: result.p12Password };
        state.autoFilled[s.name] = true;
      } else if (AUTO_SIGN_FIELD_PATTERNS.p12.test(s.name)) {
        state.secretValues[s.name] = { kind: "file-base64", scope: s.scope, base64: result.p12Base64, filename: "signing.p12" };
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

  // ---- section: Build & Sign, part 2 (push secrets) ----
  $("#pushBtn") && $("#pushBtn").addEventListener("click", async function () {
    var el = $("#pushResult");
    el.innerHTML = "";
    var names = Object.keys(state.secretValues);
    if (names.length === 0) {
      el.innerHTML = '<p class="empty-state">Nothing filled in yet — fill in at least one field above.</p>';
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
  });

  // ---- section: Build & Sign, part 3 (trigger + status) ----
  function renderBuildControls() {
    var el = $("#buildControls");
    if (!state.scan || !state.scan.ok || state.scan.workflows.length === 0) {
      el.innerHTML = '<p class="empty-state">Connect a repo in Project first.</p>';
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
    if (state.currentSection !== "build") return; // stop polling once the buyer's navigated away
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

    // If this run produced a Simulator-preview screenshot artifact, show it
    // right here too — best-effort: most workflows don't produce one, and a
    // missing artifact isn't an error worth surfacing, just nothing to show.
    // The Simulator section shows the same thing with a dedicated trigger;
    // this is just so a generic build here isn't missing it if it applies.
    try {
      var artifactResult = await api("/api/build-artifact?owner=" + encodeURIComponent(state.owner) + "&repo=" + encodeURIComponent(state.repo) + "&runId=" + run.databaseId);
      if (artifactResult.ok && artifactResult.imageDataUrl) {
        var shotWrap = document.createElement("div");
        shotWrap.className = "card";
        shotWrap.innerHTML = '<h3>Simulator screenshot</h3><p class="hint">From this run\'s Simulator preview, a few seconds after launch — a sanity check, not a substitute for testing on a real device.</p>';
        var shotImg = document.createElement("img");
        // Loaded as a same-origin image request (raw=1), not the data: URL
        // the JSON above also returns -- macless.dev's site-wide CSP img-src
        // doesn't allow data:, so a data: URL here would silently never
        // render in any CSP-enforcing browser. 'self' already covers this.
        shotImg.src = "/api/build-artifact?owner=" + encodeURIComponent(state.owner) + "&repo=" + encodeURIComponent(state.repo) + "&runId=" + run.databaseId + "&raw=1";
        shotImg.alt = "Simulator screenshot";
        shotImg.className = "sim-screenshot";
        shotWrap.appendChild(shotImg);
        statusEl.appendChild(shotWrap);
      }
    } catch (e) { /* no screenshot for this run — not an error, just nothing to show */ }

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
        sdHeading.textContent = "Running Signing Doctor against the cert/profile/keystore fields from Signing setup, since a signing mismatch is the single hardest failure to spot by eye:";
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
        hint.textContent = "No cert/profile/keystore field is filled in above to check automatically — if this looks like a signing error, fill those in above. If Apple later sends a rejection instead, paste it into Doctors → Rejection Doctor.";
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

  // Closes the loop from Doctors too: once you've checked (and fixed) your
  // signing files, or confirmed a rejection fix, push + rebuild without
  // manually hunting back through the nav to do it.
  function rebuildNow() {
    switchSection("build");
    if ($("#workflowSelect") && state.workflowFile) $("#workflowSelect").value = state.workflowFile;
    triggerBuild();
  }

  // ---- section: Simulator ----
  function renderSimulatorSection() {
    var el = $("#simulatorBody");
    if (!state.scan || !state.scan.ok) {
      el.innerHTML = '<p class="empty-state">Connect a repo in Project first.</p>';
      return;
    }
    if (!state.simulatorWorkflowFile) {
      el.innerHTML =
        '<div class="card"><h3>No Simulator workflow found</h3><p>This repo\'s pipeline doesn\'t include a Simulator-preview-style workflow yet. If you added the pipeline a while ago, reconnecting in Project picks up any new template files without touching your own code — or trigger any workflow manually from Build &amp; Sign and check its logs there.</p></div>';
      return;
    }
    el.innerHTML =
      '<div class="btn-row"><button class="btn" id="simTriggerBtn">Run Simulator check</button></div>' +
      '<div id="simStatus"></div>';
    $("#simTriggerBtn").addEventListener("click", triggerSimulatorCheck);
  }

  async function triggerSimulatorCheck() {
    var statusEl = $("#simStatus");
    statusEl.innerHTML = '<p class="empty-state">Triggering…</p>';
    var result = await api("/api/trigger-build", { method: "POST", body: JSON.stringify({ owner: state.owner, repo: state.repo, workflowFile: state.simulatorWorkflowFile, ref: state.defaultBranch }) });
    if (!result.ok) {
      statusEl.innerHTML = '<div class="card"><h3>Couldn\'t trigger</h3><p>' + escapeHtml(result.detail || "") + "</p></div>";
      return;
    }
    statusEl.innerHTML = '<p class="empty-state">Triggered — waiting for it to show up in the run list…</p>';
    pollSimulatorStatus();
  }

  async function pollSimulatorStatus() {
    var statusEl = $("#simStatus");
    if (state.currentSection !== "simulator") return; // stop polling once the buyer's navigated away
    var result = await api("/api/build-status?owner=" + encodeURIComponent(state.owner) + "&repo=" + encodeURIComponent(state.repo) + "&workflowFile=" + encodeURIComponent(state.simulatorWorkflowFile));
    if (!result.ok || !result.runs || result.runs.length === 0) {
      statusEl.innerHTML = '<p class="empty-state">No runs yet — checking again…</p>';
      setTimeout(pollSimulatorStatus, 5000);
      return;
    }
    var run = result.runs[0];
    var badge = run.status === "completed" ? (run.conclusion === "success" ? "ok" : "fail") : "pending";
    var label = run.status === "completed" ? run.conclusion : run.status;
    statusEl.innerHTML =
      '<div class="status-line"><span class="status-badge ' + badge + '">' + escapeHtml(label) + "</span><span>" +
      escapeHtml(run.displayTitle || "run #" + run.databaseId) + "</span></div>";

    if (run.status !== "completed") {
      setTimeout(pollSimulatorStatus, 5000);
      return;
    }

    try {
      var artifactResult = await api("/api/build-artifact?owner=" + encodeURIComponent(state.owner) + "&repo=" + encodeURIComponent(state.repo) + "&runId=" + run.databaseId);
      if (artifactResult.ok && artifactResult.imageDataUrl) {
        var shotWrap = document.createElement("div");
        shotWrap.className = "card";
        shotWrap.innerHTML = '<h3>Screenshot</h3><p class="hint">A few seconds after launch — a sanity check, not a substitute for testing on a real device.</p>';
        var shotImg = document.createElement("img");
        // Same reasoning as the inline preview above: same-origin raw=1
        // request instead of the data: URL, since the page's CSP img-src
        // has no data: entry and would otherwise block this silently.
        shotImg.src = "/api/build-artifact?owner=" + encodeURIComponent(state.owner) + "&repo=" + encodeURIComponent(state.repo) + "&runId=" + run.databaseId + "&raw=1";
        shotImg.alt = "Simulator screenshot";
        shotImg.className = "sim-screenshot large";
        shotWrap.appendChild(shotImg);
        statusEl.appendChild(shotWrap);
      } else {
        var noShot = document.createElement("p");
        noShot.className = "hint";
        noShot.style.marginTop = "10px";
        noShot.textContent = artifactResult.detail || "No screenshot artifact on this run.";
        statusEl.appendChild(noShot);
      }
    } catch (e) { /* no screenshot for this run — not an error, just nothing to show */ }

    if (run.conclusion !== "success") {
      var logs = await api("/api/build-logs?owner=" + encodeURIComponent(state.owner) + "&repo=" + encodeURIComponent(state.repo) + "&runId=" + run.databaseId);
      var logDiv = document.createElement("div");
      logDiv.className = "log-output";
      logDiv.textContent = logs.log || "(couldn't fetch failed step logs)";
      statusEl.appendChild(logDiv);
    }

    var rerunBtn = document.createElement("button");
    rerunBtn.className = "btn btn-secondary";
    rerunBtn.style.marginTop = "12px";
    rerunBtn.textContent = "Run again";
    rerunBtn.addEventListener("click", triggerSimulatorCheck);
    statusEl.appendChild(rerunBtn);
  }

  // ---- section: Store Listing ----
  function renderStoreSection() {
    var el = $("#storeBody");
    if (!state.connected) {
      el.innerHTML = '<p class="empty-state">Connect a repo in Project first.</p>';
      return;
    }
    el.innerHTML =
      '<h2 class="section-heading" style="margin-top:0;">Listing copy</h2>' +
      '<p class="section-sub">Pushed straight into <code>fastlane/metadata/</code> in your repo as plain text files — the same format fastlane\'s own <code>deliver</code> action reads, which your pipeline\'s App Store submission workflow already uses.</p>' +
      '<div class="field"><label>App name <span class="hint">(max 30 characters)</span></label><input type="text" id="mdName" maxlength="30"><div class="char-count" id="mdNameCount">0 / 30</div></div>' +
      '<div class="field"><label>Subtitle <span class="hint">(max 30 characters)</span></label><input type="text" id="mdSubtitle" maxlength="30"><div class="char-count" id="mdSubtitleCount">0 / 30</div></div>' +
      '<div class="field"><label>Promotional text <span class="hint">(max 170 characters — can be updated without a new build)</span></label><input type="text" id="mdPromo" maxlength="170"><div class="char-count" id="mdPromoCount">0 / 170</div></div>' +
      '<div class="field"><label>Description <span class="hint">(max 4000 characters)</span></label><textarea id="mdDescription" maxlength="4000" style="min-height:160px; font-family:var(--sans); font-size:14.5px;"></textarea><div class="char-count" id="mdDescriptionCount">0 / 4000</div></div>' +
      '<div class="field"><label>Keywords <span class="hint">(comma-separated, max 100 characters total)</span></label><input type="text" id="mdKeywords" maxlength="100"><div class="char-count" id="mdKeywordsCount">0 / 100</div></div>' +
      '<div class="field"><label>Release notes <span class="hint">(what\'s new in this version)</span></label><textarea id="mdReleaseNotes" style="min-height:100px; font-family:var(--sans); font-size:14.5px;"></textarea></div>' +
      '<div class="field"><label>Support URL</label><input type="text" id="mdSupportUrl" placeholder="https://"></div>' +
      '<div class="field"><label>Marketing URL <span class="hint">(optional)</span></label><input type="text" id="mdMarketingUrl" placeholder="https://"></div>' +
      '<div class="field"><label>Privacy policy URL</label><input type="text" id="mdPrivacyUrl" placeholder="https://"></div>' +
      '<div class="field"><label>Primary category <span class="hint">(Apple\'s category name, e.g. BUSINESS, GAMES, PRODUCTIVITY — full list is in App Store Connect)</span></label><input type="text" id="mdPrimaryCategory" placeholder="e.g. PRODUCTIVITY"></div>' +
      '<div class="field"><label>Secondary category <span class="hint">(optional)</span></label><input type="text" id="mdSecondaryCategory"></div>' +
      '<div class="field"><label>Age rating</label><input type="text" id="mdAgeRating" placeholder="e.g. 4+"><p class="hint">Reference only — Apple\'s age rating is a set of content questions inside App Store Connect, not a single field, so this isn\'t pushed anywhere. Set it directly in App Store Connect.</p></div>' +
      '<div class="btn-row"><button class="btn" id="pushMetadataBtn">Push metadata files</button></div>' +
      '<div id="pushMetadataResult"></div>' +
      '<h2 class="section-heading">Privacy category suggestions</h2>' +
      '<p class="section-sub">Best-effort read of your repo\'s own Info.plist permission requests and a few well-known SDKs — suggestion-only, never submitted anywhere on your behalf. Review each one and fill in App Store Connect\'s own Privacy section yourself.</p>' +
      '<div class="btn-row"><button class="btn btn-secondary" id="scanPrivacyBtn">Scan for privacy signals</button></div>' +
      '<div id="privacyResult"></div>';

    $("#pushMetadataBtn").addEventListener("click", pushMetadata);
    $("#scanPrivacyBtn").addEventListener("click", scanPrivacy);
    // Apple's own limits are hard walls -- the browser's native maxlength
    // silently truncates mid-word with zero indication when a buyer types
    // or pastes past it (found live 2026-09-13: a 31-char subtitle got
    // silently cut to "...RSVP styl"). A live counter can't undo a paste
    // that already got truncated by the browser, but it means the buyer
    // SEES they're at the wall instead of finding out after it's on the
    // App Store -- same "never fail silently" posture as the server-side
    // limit check in /api/push-metadata.
    [["mdName", 30], ["mdSubtitle", 30], ["mdPromo", 170], ["mdDescription", 4000], ["mdKeywords", 100]].forEach(function (pair) {
      var input = $("#" + pair[0]);
      var counter = $("#" + pair[0] + "Count");
      function update() {
        var len = input.value.length;
        counter.textContent = len + " / " + pair[1];
        counter.style.color = len >= pair[1] ? "var(--fail)" : "";
      }
      input.addEventListener("input", update);
      update();
    });
  }

  async function pushMetadata() {
    var resultEl = $("#pushMetadataResult");
    var body = {
      owner: state.owner, repo: state.repo, defaultBranch: state.defaultBranch,
      name: $("#mdName").value, subtitle: $("#mdSubtitle").value, promotionalText: $("#mdPromo").value,
      description: $("#mdDescription").value, keywords: $("#mdKeywords").value, releaseNotes: $("#mdReleaseNotes").value,
      supportUrl: $("#mdSupportUrl").value, marketingUrl: $("#mdMarketingUrl").value, privacyUrl: $("#mdPrivacyUrl").value,
      primaryCategory: $("#mdPrimaryCategory").value, secondaryCategory: $("#mdSecondaryCategory").value,
    };
    resultEl.innerHTML = '<p class="empty-state">Pushing…</p>';
    var result = await api("/api/push-metadata", { method: "POST", body: JSON.stringify(body) });
    if (!result.ok) {
      resultEl.innerHTML = '<div class="card"><h3>Couldn\'t push</h3><p>' + escapeHtml(result.detail || "") + "</p></div>";
      return;
    }
    resultEl.innerHTML = '<div class="card"><h3>Pushed</h3><p>Wrote ' + result.filesWritten + " file" + (result.filesWritten === 1 ? "" : "s") + " to <code>fastlane/metadata/</code> in your repo.</p></div>";
  }

  async function scanPrivacy() {
    var resultEl = $("#privacyResult");
    resultEl.innerHTML = '<p class="empty-state">Reading your repo\'s own files…</p>';
    var result = await api("/api/scan-privacy?owner=" + encodeURIComponent(state.owner) + "&repo=" + encodeURIComponent(state.repo) + "&defaultBranch=" + encodeURIComponent(state.defaultBranch));
    if (!result.ok) {
      resultEl.innerHTML = '<div class="card"><h3>Couldn\'t scan</h3><p>' + escapeHtml(result.detail || "") + "</p></div>";
      return;
    }
    state.privacySignals = result.signals;
    var s = result.signals;
    if ((!s.infoPlistSignals || !s.infoPlistSignals.length) && (!s.sdkSignals || !s.sdkSignals.length)) {
      resultEl.innerHTML = '<div class="card"><h3>Nothing detected</h3><p>Didn\'t find any recognized permission requests or known SDKs in this repo — that doesn\'t mean there\'s nothing to declare, just that this scan didn\'t recognize a pattern. Review App Store Connect\'s Privacy questionnaire directly.</p></div>';
      return;
    }
    var html = "";
    if (s.infoPlistSignals && s.infoPlistSignals.length) {
      html += '<h3 style="font-size:15px;margin-top:16px;">From your Info.plist permission requests</h3>';
      s.infoPlistSignals.forEach(function (sig) {
        html += '<div class="privacy-signal"><div class="signal-title">' + escapeHtml(sig.capability) + ' <span class="mono hint">(' + escapeHtml(sig.key) + ")</span></div>";
        if (sig.category) html += '<span class="signal-category">' + escapeHtml(sig.category) + "</span>";
        if (sig.note) html += '<div class="signal-note">' + escapeHtml(sig.note) + "</div>";
        html += "</div>";
      });
    }
    if (s.sdkSignals && s.sdkSignals.length) {
      html += '<h3 style="font-size:15px;margin-top:20px;">Known SDKs found in your dependencies</h3>';
      html += '<p class="privacy-hedge">Weaker signal — presence of the SDK, not confirmation of what it does in your app. Verify against each SDK\'s own privacy documentation.</p>';
      s.sdkSignals.forEach(function (sig) {
        html += '<div class="privacy-signal"><div class="signal-title">' + escapeHtml(sig.sdk) + "</div>";
        sig.categories.forEach(function (c) { html += '<span class="signal-category">' + escapeHtml(c) + "</span>"; });
        html += "</div>";
      });
    }
    resultEl.innerHTML = html;
  }

  // ---- section: Doctors ----
  function updateDoctorAvailability() {
    var hasSigningFields = !!(state.scan && state.scan.ok && state.scan.secrets.some(function (s) { return /PROFILE|MOBILEPROVISION|CERT|KEYSTORE/i.test(s.name); }));
    $("#signingDoctorCard").style.display = hasSigningFields ? "block" : "none";
    $("#signingDoctorEmpty").style.display = hasSigningFields ? "none" : "block";
  }

  function renderDoctorsSection() {
    updateDoctorAvailability();
  }

  function findSecretValueByPattern(pattern) {
    var name = Object.keys(state.secretValues).find(function (n) { return pattern.test(n); });
    return name ? state.secretValues[name] : null;
  }

  // Shared by the Doctors-section button AND the build-failure auto-check
  // (see pollBuildStatus/pollSimulatorStatus) — one diagnosis engine, run
  // from wherever it's useful, instead of a one-off click handler
  // duplicated in multiple places.
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

  $("#signingDoctorBtn") && $("#signingDoctorBtn").addEventListener("click", async function () {
    var out = $("#signingDoctorOutput");
    out.style.display = "block";
    out.textContent = "Checking…";
    if ($("#signingRebuildBtn")) $("#signingRebuildBtn").style.display = "none";

    var body = buildSigningDoctorRequestBody();
    if (!body) {
      out.textContent = "Fill in a provisioning profile and/or an Android keystore file under Build & Sign first.";
      return;
    }

    var result = await api("/api/diagnose-signing", { method: "POST", body: JSON.stringify(body) });
    out.textContent = result.output || "(no output)";
    if (state.connected && state.workflowFile && $("#signingRebuildBtn")) {
      $("#signingRebuildBtn").style.display = "inline-block";
    }
  });

  $("#signingRebuildBtn") && $("#signingRebuildBtn").addEventListener("click", rebuildNow);

  // ---- section: Doctors, part 2 (rejection doctor) ----
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

  // ---- section: Settings ----
  function renderSettingsSection() {
    $("#settingsWhoAmI").textContent = state.login || "…";
    var repoInfo = $("#settingsRepoInfo");
    var switchBtn = $("#switchRepoBtn");
    if (state.connected && state.owner && state.repo) {
      repoInfo.innerHTML = "Connected to <code>" + escapeHtml(state.owner + "/" + state.repo) + "</code> (branch <code>" + escapeHtml(state.defaultBranch) + "</code>).";
      switchBtn.style.display = "inline-block";
    } else {
      repoInfo.textContent = "Not connected yet — pick one in Project.";
      switchBtn.style.display = "none";
    }
  }

  $("#switchRepoBtn") && $("#switchRepoBtn").addEventListener("click", function () {
    disconnectRepo();
    switchSection("project");
  });

  $("#signOutBtn") && $("#signOutBtn").addEventListener("click", async function () {
    await api("/api/logout", { method: "POST" });
    window.location.href = "https://macless.dev/";
  });

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  unlockSections();
  switchSection("project");
})();
