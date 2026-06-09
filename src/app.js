let providers = {};
let modelCatalog = [];
let state;

const STORAGE_KEY = "ai-emergent-provider-api-keys";
const LEGACY_STORAGE_KEY = "ai-emergent-provider-keys";
const REQUEST_TIMEOUT_MS = 120000;

const elements = {
  settingsPanel: document.querySelector("#settingsPanel"),
  workspace: document.querySelector("#workspace"),
  settingsToggle: document.querySelector("#settingsToggle"),
  settingsBody: document.querySelector("#settingsBody"),
  settingsSummary: document.querySelector("#settingsSummary"),
  settingsIndicator: document.querySelector("#settingsIndicator"),
  summarizerSelect: document.querySelector("#summarizerSelect"),
  roundsInput: document.querySelector("#roundsInput"),
  biasSelect: document.querySelector("#biasSelect"),
  modelList: document.querySelector("#modelList"),
  ollamaRefreshButton: document.querySelector("#ollamaRefreshButton"),
  ollamaStatus: document.querySelector("#ollamaStatus"),
  estimatedCost: document.querySelector("#estimatedCost"),
  roundDelta: document.querySelector("#roundDelta"),
  processTotal: document.querySelector("#processTotal"),
  promptInput: document.querySelector("#promptInput"),
  continueSessionInput: document.querySelector("#continueSessionInput"),
  runButton: document.querySelector("#runButton"),
  runState: document.querySelector("#runState"),
  activityPanel: document.querySelector("#activityPanel"),
  activityLog: document.querySelector("#activityLog"),
  progressStatus: document.querySelector("#progressStatus"),
  progressFill: document.querySelector("#progressFill"),
  finalPanel: document.querySelector("#finalPanel"),
  finalSummary: document.querySelector("#finalSummary"),
  modelDetails: document.querySelector("#modelDetails"),
  clearButton: document.querySelector("#clearButton")
};

async function loadModelConfig() {
  const response = await fetch("src/models.json", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Unable to load model config: ${response.status}`);
  }
  return response.json();
}

function normalizeModel(model) {
  return {
    requiresKey: true,
    summarizer: false,
    selected: false,
    estimatedRoundCost: 0,
    maxTokens: 1200,
    ...model
  };
}

function loadProviderKeys() {
  const storedKeys = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  const legacyKeys = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) || "{}");

  return Object.fromEntries(
    Object.entries(providers).map(([providerId, provider]) => {
      if (provider.local) return [providerId, ""];
      const storedValue = storedKeys[providerId];
      const legacyValue = legacyKeys[providerId];
      return [providerId, typeof storedValue === "string" ? storedValue : legacyValue === true ? "" : ""];
    })
  );
}

function saveProviderKeys() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.providerKeys));
}

function getProviderApiKey(providerId) {
  return state.providerKeys[providerId]?.trim() || "";
}

function isOllamaModel(model) {
  return providers[model.provider]?.adapter === "ollama";
}

function hasProviderAccess(model) {
  const provider = providers[model.provider];
  if (provider?.local) {
    if (isOllamaModel(model)) {
      if (state?.ollama?.status === "unavailable") return false;
      if (model.installed === false) return false;
    }
    return true;
  }
  return !model.requiresKey || Boolean(getProviderApiKey(model.provider));
}

function selectedModels() {
  return modelCatalog.filter((model) => state.selectedModels.has(model.id));
}

function selectedProviderWarnings() {
  const warningProviders = new Set();
  for (const model of selectedModels()) {
    if (!hasProviderAccess(model)) {
      warningProviders.add(model.provider);
    }
  }
  const summarizer = selectedSummarizer();
  if (summarizer && !hasProviderAccess(summarizer)) {
    warningProviders.add(summarizer.provider);
  }
  return [...warningProviders];
}

function selectedSummarizer() {
  return modelCatalog.find((model) => model.id === elements.summarizerSelect.value) || modelCatalog.find((model) => model.summarizer);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatCost(value) {
  return `$${value.toFixed(4)}`;
}

function estimateTotalCost() {
  const rounds = Number(elements.roundsInput.value || 3);
  const perRound = selectedModels().reduce((sum, model) => sum + model.estimatedRoundCost, 0);
  const summarizer = selectedSummarizer();
  const summarizerCost = (summarizer?.estimatedRoundCost || 0.0015) * rounds;
  return perRound * rounds + summarizerCost;
}

function renderSummarizerOptions() {
  const summarizers = modelCatalog.filter((model) => model.summarizer);
  elements.summarizerSelect.innerHTML = summarizers
    .map((model) => `<option value="${model.id}">${escapeHtml(model.name)}</option>`)
    .join("");
  elements.summarizerSelect.value = summarizers[0]?.id || "";
}

function localModelStatus(model) {
  if (!isOllamaModel(model)) {
    return { label: "Local runtime", className: "ok" };
  }

  if (state.ollama.status === "checking") {
    return { label: "Checking", className: "ok" };
  }
  if (state.ollama.status === "unavailable") {
    return { label: "Ollama off", className: "warning" };
  }
  if (model.installed === false) {
    return { label: "Not installed", className: "warning" };
  }
  if (model.installed === true) {
    return { label: "Installed", className: "ok" };
  }
  return { label: "Local runtime", className: "ok" };
}

function renderModelList() {
  const renderedKeyEntryProviders = new Set();
  elements.modelList.innerHTML = [...modelCatalog]
    .sort((a, b) => a.rank - b.rank)
    .map((model) => {
      const provider = providers[model.provider];
      const checked = state.selectedModels.has(model.id) ? "checked" : "";
      const missingKey = !hasProviderAccess(model);
      const localStatus = provider.local ? localModelStatus(model) : null;
      const statusLabel = localStatus?.label || (missingKey ? "Missing API key" : "API key ready");
      const statusClass = localStatus?.className || (missingKey ? "warning" : "ok");
      const sourceLabel = provider.local ? "Local" : "Cloud";
      const showKeyControls = model.requiresKey && !renderedKeyEntryProviders.has(model.provider);
      const editingKey = state.editingProviderKeys.has(model.provider);
      if (showKeyControls) {
        renderedKeyEntryProviders.add(model.provider);
      }
      const keyControls = showKeyControls
        ? missingKey || editingKey
          ? `
          <div class="key-entry">
            <input data-provider-key="${model.provider}" type="password" placeholder="${editingKey ? "Enter replacement key" : escapeHtml(provider.keyLabel)}" aria-label="${escapeHtml(provider.keyLabel)}" />
            <button data-save-key="${model.provider}" type="button">Save</button>
            ${editingKey ? `<button data-cancel-key="${model.provider}" type="button">Cancel</button>` : ""}
            <a href="${escapeHtml(provider.apiKeyPage)}" target="_blank" rel="noreferrer">Get key</a>
          </div>
        `
          : `
          <div class="key-entry key-entry-ready">
            <span>${escapeHtml(provider.keyLabel)} saved for ${escapeHtml(provider.name)}</span>
            <button data-change-key="${model.provider}" type="button">Change</button>
            <a href="${escapeHtml(provider.usagePage || provider.apiKeyPage)}" target="_blank" rel="noreferrer">Usage</a>
          </div>
        `
        : "";

      return `
        <article class="model-card">
          <label class="model-main">
            <input type="checkbox" data-model-id="${escapeHtml(model.id)}" ${checked} />
            <span>
              <strong>${escapeHtml(model.name)}</strong>
              <small>${escapeHtml(provider.name)} · ${sourceLabel} · ${escapeHtml(model.localInfo || model.apiModel || model.detailName || model.id)}</small>
            </span>
          </label>
          <button class="key-status ${statusClass}" data-provider-status="${escapeHtml(model.provider)}" type="button">
            ${statusLabel}
          </button>
          ${keyControls}
        </article>
      `;
    })
    .join("");
}

function renderCosts() {
  elements.estimatedCost.textContent = formatCost(estimateTotalCost());
  elements.roundDelta.textContent = formatCost(state.lastRoundCost);
  elements.processTotal.textContent = formatCost(state.totalCost);
}

function renderOllamaStatus() {
  if (!elements.ollamaStatus) return;
  elements.ollamaStatus.textContent = state.ollama.message;
  elements.ollamaStatus.classList.toggle("warning", state.ollama.status === "unavailable");
  elements.ollamaStatus.classList.toggle("ok", state.ollama.status === "ready");
  if (elements.ollamaRefreshButton) {
    elements.ollamaRefreshButton.disabled = state.ollama.status === "checking";
    elements.ollamaRefreshButton.textContent = state.ollama.status === "checking" ? "Checking..." : "Refresh Ollama";
  }
}

function renderSettingsState() {
  const warnings = selectedProviderWarnings();
  const selectedCount = selectedModels().length;
  const warningText = warnings.length === 0 ? "No warnings" : `${warnings.length} setup warning${warnings.length > 1 ? "s" : ""}`;

  elements.settingsSummary.textContent = `${selectedCount} models selected · ${warningText}`;
  elements.settingsIndicator.textContent = warnings.length > 0 ? String(warnings.length) : "⚙";
  elements.settingsIndicator.classList.toggle("active", warnings.length > 0);
  elements.settingsPanel.classList.toggle("collapsed", state.settingsCollapsed);
  elements.workspace.classList.toggle("settings-collapsed", state.settingsCollapsed);
  elements.settingsToggle.setAttribute("aria-expanded", String(!state.settingsCollapsed));
}

function render() {
  renderModelList();
  renderCosts();
  renderOllamaStatus();
  renderSettingsState();
}

function setProgress(status, percent) {
  elements.progressStatus.textContent = status;
  elements.progressFill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  elements.activityLog.textContent = status;
}

function buildSessionContext() {
  if (!elements.continueSessionInput.checked || state.sessionTurns.length === 0) return "";
  const turns = state.sessionTurns
    .slice(-3)
    .map((turn, index) => `${index + 1}. Previous question: ${turn.prompt}\nSummary: ${turn.shortSummary}`)
    .join("\n");
  return `Prior session context, only use it if it is clearly relevant to the current question:\n${turns}`;
}

function baseSystemPrompt(model) {
  return [
    `You are ${model.name}, participating in a multi-model discussion.`,
    "Answer the user's current question directly. Do not switch into app-design, planning, or meta-commentary unless the user asks for that.",
    "Stay within the user's scope. Do not introduce new debates that are not needed to answer the question.",
    "Give a concise but useful answer with explicit reasoning and practical tradeoffs.",
    "If information is uncertain, say what would need to be checked instead of pretending certainty."
  ].join(" ");
}

function buildRoundRequest(prompt, round, disagreementPacket) {
  const sessionContext = buildSessionContext();
  if (round === 1) {
    return [
      sessionContext,
      `User question:\n${prompt.trim()}`,
      "Round 1 task: answer the question directly from your model's perspective. Include the main conclusion, reasons, and important caveats."
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  return [
    sessionContext,
    `User question:\n${prompt.trim()}`,
    `Round ${round} debate task: reconsider only these unresolved disagreements from the prior synthesis:\n${disagreementPacket}`,
    "State whether you agree, disagree, or refine your earlier answer. Keep the reply focused on the user's question."
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function fetchJson(url, options) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await httpRequest(url, options, controller.signal);
    const text = response.body;
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { raw: text };
    }
    if (response.status < 200 || response.status >= 300) {
      const message = payload.error?.message || payload.message || payload.raw || `${response.status} ${response.statusText || ""}`;
      throw new Error(message);
    }
    return payload;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function httpRequest(url, options, signal) {
  const tauriInvoke = window.__TAURI__?.core?.invoke;
  if (tauriInvoke) {
    const response = await tauriInvoke("http_request", {
      request: {
        url,
        method: options.method || "GET",
        headers: options.headers || {},
        body: options.body || null
      }
    });
    return {
      status: response.status,
      statusText: response.status_text,
      body: response.body
    };
  }

  const response = await fetch(url, {
    ...options,
    signal
  });
  return {
    status: response.status,
    statusText: response.statusText,
    body: await response.text()
  };
}

function formatOllamaModelName(name) {
  const base = name.replace(":latest", "");
  return base
    .split(/[-_:]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function slugModelId(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function describeOllamaModel(model) {
  const parameterSize = model.details?.parameter_size;
  const family = model.details?.family;
  const sizeGb = model.size ? `${(model.size / 1024 / 1024 / 1024).toFixed(1)} GB` : "";
  return [model.name || model.model, parameterSize, family, sizeGb].filter(Boolean).join(" · ");
}

async function syncOllamaModels({ silent = false } = {}) {
  const provider = Object.values(providers).find((candidate) => candidate.adapter === "ollama");
  if (!provider) return;

  state.ollama.status = "checking";
  state.ollama.message = "Checking installed Ollama models...";
  render();

  try {
    const payload = await fetchJson(`${provider.baseUrl}/api/tags`, {
      method: "GET",
      headers: {}
    });
    const installedModels = Array.isArray(payload.models) ? payload.models : [];
    const installedByName = new Map(installedModels.map((model) => [model.name || model.model, model]));
    const installedNames = new Set(installedByName.keys());

    for (const model of modelCatalog.filter(isOllamaModel)) {
      const installed = installedByName.get(model.apiModel);
      model.installed = installedNames.has(model.apiModel);
      if (installed) {
        model.localInfo = describeOllamaModel(installed);
      }
    }

    const currentApiModels = new Set(modelCatalog.filter(isOllamaModel).map((model) => model.apiModel));
    const maxRank = Math.max(...modelCatalog.map((model) => model.rank || 0), 0);
    let nextRank = maxRank + 1;

    for (const installed of installedModels) {
      const apiModel = installed.name || installed.model;
      if (!apiModel || currentApiModels.has(apiModel)) continue;

      const discoveredModel = normalizeModel({
        id: `ollama:${slugModelId(apiModel)}`,
        provider: "ollama",
        apiModel,
        name: `Ollama ${formatOllamaModelName(apiModel)}`,
        detailName: `Ollama ${apiModel} local model`,
        localInfo: describeOllamaModel(installed),
        rank: nextRank,
        selected: false,
        requiresKey: false,
        estimatedRoundCost: 0,
        summarizer: false,
        installed: true,
        discovered: true
      });
      nextRank += 1;
      modelCatalog.push(discoveredModel);
      currentApiModels.add(apiModel);
    }

    state.ollama.status = "ready";
    state.ollama.message =
      installedModels.length === 0
        ? "Ollama is running, but no local models are installed."
        : `Ollama ready · ${installedModels.length} installed: ${installedModels.map((model) => model.name || model.model).join(", ")}`;
  } catch (error) {
    for (const model of modelCatalog.filter(isOllamaModel)) {
      model.installed = undefined;
    }
    state.ollama.status = "unavailable";
    state.ollama.message = `Ollama unavailable · ${error.message}`;
    if (!silent) {
      elements.activityPanel.classList.remove("hidden");
      setProgress(state.ollama.message, 0);
    }
  }

  render();
}

async function callOpenAICompatible(model, systemPrompt, userPrompt) {
  const provider = providers[model.provider];
  const key = getProviderApiKey(model.provider);
  const payload = await fetchJson(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`
    },
    body: JSON.stringify({
      model: model.apiModel,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.2,
      max_tokens: model.maxTokens || 1200
    })
  });
  return payload.choices?.[0]?.message?.content?.trim() || "";
}

async function callAnthropic(model, systemPrompt, userPrompt) {
  const provider = providers[model.provider];
  const key = getProviderApiKey(model.provider);
  const payload = await fetchJson(`${provider.baseUrl}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: model.apiModel,
      system: systemPrompt,
      max_tokens: model.maxTokens || 1200,
      messages: [{ role: "user", content: userPrompt }]
    })
  });
  return payload.content?.map((part) => part.text || "").join("\n").trim() || "";
}

async function callGemini(model, systemPrompt, userPrompt) {
  const provider = providers[model.provider];
  const key = encodeURIComponent(getProviderApiKey(model.provider));
  const payload = await fetchJson(`${provider.baseUrl}/models/${model.apiModel}:generateContent?key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }]
        }
      ],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: model.maxTokens || 1200
      }
    })
  });
  return payload.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("\n").trim() || "";
}

async function callOllama(model, systemPrompt, userPrompt) {
  const provider = providers[model.provider];
  const payload = await fetchJson(`${provider.baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: model.apiModel,
      stream: false,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ]
    })
  });
  return payload.message?.content?.trim() || payload.response?.trim() || "";
}

async function callModel(model, systemPrompt, userPrompt) {
  const provider = providers[model.provider];
  if (!provider) throw new Error(`Provider ${model.provider} is not configured.`);
  if (!hasProviderAccess(model)) {
    if (isOllamaModel(model)) {
      throw new Error(`${model.apiModel} is not available in Ollama. Refresh Ollama models or run: ollama pull ${model.apiModel}`);
    }
    throw new Error(`${provider.name} needs an API key before it can be called.`);
  }

  if (provider.adapter === "openai-compatible") return callOpenAICompatible(model, systemPrompt, userPrompt);
  if (provider.adapter === "anthropic") return callAnthropic(model, systemPrompt, userPrompt);
  if (provider.adapter === "google-gemini") return callGemini(model, systemPrompt, userPrompt);
  if (provider.adapter === "ollama") return callOllama(model, systemPrompt, userPrompt);

  throw new Error(`Provider adapter ${provider.adapter} is not supported.`);
}

async function askModel(model, prompt, round, disagreementPacket) {
  const startedAt = performance.now();
  const request = buildRoundRequest(prompt, round, disagreementPacket);
  try {
    const text = await callModel(model, baseSystemPrompt(model), request);
    if (!text) throw new Error("Provider returned an empty response.");
    return {
      model,
      round,
      latency: Math.round(performance.now() - startedAt),
      request,
      text,
      ok: true
    };
  } catch (error) {
    return {
      model,
      round,
      latency: Math.round(performance.now() - startedAt),
      request,
      text: "",
      error: error.message,
      ok: false
    };
  }
}

function buildSummaryPrompt(responses, round, maxRounds) {
  const successfulResponses = responses.filter((response) => response.ok);
  const failedResponses = responses.filter((response) => !response.ok);
  const responseText = successfulResponses
    .map((response) => `Model: ${response.model.name}\nResponse:\n${response.text}`)
    .join("\n\n---\n\n");
  const failures = failedResponses.map((response) => `${response.model.name}: ${response.error}`).join("\n");

  return [
    "Synthesize this multi-model discussion.",
    `Original user question:\n${elements.promptInput.value.trim()}`,
    `Round: ${round} of ${maxRounds}`,
    failedResponses.length ? `Models that failed and should not be treated as opinions:\n${failures}` : "",
    `Successful model responses:\n${responseText}`,
    "Return only valid JSON with this exact shape:",
    `{
  "short_summary": "No more than 250 words, direct answer to the user's question.",
  "common_points": ["dot-list item"],
  "disagreements": [
    {
      "point": "specific disagreement still relevant to the user's question",
      "positions": [
        { "model": "model name", "position": "model's position" }
      ]
    }
  ],
  "model_points": [
    {
      "model": "model name",
      "point": "the model's main argument",
      "challenged_by": [
        { "model": "other model name", "challenge": "how that model challenges this point" }
      ],
      "response_back": "how this model's latest response addresses the challenges"
    }
  ]
}`,
    "Important: keep disagreements inside the user's actual question. Do not add study-order, project-planning, app-design, or other adjacent topics unless the user asked for them.",
    round < maxRounds
      ? "If there are no meaningful disagreements, return an empty disagreements array."
      : "This is the final allowed round; still report significant disagreements if they remain."
  ]
    .filter(Boolean)
    .join("\n\n");
}

function parseSummaryJson(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced || trimmed.match(/\{[\s\S]*\}/)?.[0] || trimmed;
  const parsed = JSON.parse(candidate);
  return {
    shortSummary: String(parsed.short_summary || parsed.shortSummary || "").trim(),
    common: Array.isArray(parsed.common_points) ? parsed.common_points.map(String).filter(Boolean) : [],
    disagreements: Array.isArray(parsed.disagreements)
      ? parsed.disagreements
          .map((item) =>
            typeof item === "string"
              ? { point: item, positions: [] }
              : {
                  point: String(item.point || "").trim(),
                  positions: Array.isArray(item.positions) ? item.positions : []
                }
          )
          .filter((item) => item.point)
      : [],
    modelPoints: Array.isArray(parsed.model_points) ? parsed.model_points : []
  };
}

async function summarizeRound(responses, round, maxRounds) {
  const successfulResponses = responses.filter((response) => response.ok);
  if (successfulResponses.length === 0) {
    throw new Error("No selected model returned a real response. Check API keys, local Ollama status, and network access.");
  }

  const summarizer = selectedSummarizer();
  if (!summarizer) throw new Error("No summarizer model is configured.");

  const request = buildSummaryPrompt(responses, round, maxRounds);
  const systemPrompt = [
    "You are the discussion summarizer.",
    "Be faithful to the supplied model responses and the user's exact question.",
    "Do not invent consensus or disagreements.",
    "Return valid JSON only."
  ].join(" ");
  const text = await callModel(summarizer, systemPrompt, request);
  const parsed = parseSummaryJson(text);
  return {
    ...parsed,
    responses,
    summarizer,
    summarizerRequest: request,
    summarizerResponse: text
  };
}

function disagreementText(disagreement) {
  return typeof disagreement === "string" ? disagreement : disagreement.point;
}

function buildModelDetail(response, summary, allResponses) {
  const transcript = state.modelTranscripts[response.model.id] || [];
  const modelPoint = summary.modelPoints.find((point) => point.model === response.model.name) || {};
  const challenges = Array.isArray(modelPoint.challenged_by) ? modelPoint.challenged_by : [];
  const challengeItems = challenges.length
    ? challenges.map((item) => `<li><strong>${escapeHtml(item.model)}:</strong> ${escapeHtml(item.challenge)}</li>`).join("")
    : allResponses
        .filter((candidate) => candidate.model.id !== response.model.id && candidate.ok)
        .slice(0, 3)
        .map((candidate) => `<li><strong>${escapeHtml(candidate.model.name)}:</strong> See transcript for its separate reasoning.</li>`)
        .join("");
  const transcriptItems = transcript
    .map(
      (entry) => `
        <article class="transcript-item">
          <div><strong>Round ${entry.round}</strong><small>${entry.latency} ms · ${escapeHtml(entry.status)}</small></div>
          <p><strong>Request:</strong> ${escapeHtml(entry.request)}</p>
          <p><strong>Response:</strong> ${escapeHtml(entry.response)}</p>
        </article>
      `
    )
    .join("");

  return `
    <details class="model-detail">
      <summary>
        <span>${escapeHtml(response.model.name)}</span>
        <small>${response.ok ? "View argument, objections, and transcript" : "View error and transcript"}</small>
      </summary>
      <div class="model-detail-body">
        ${
          response.ok
            ? `
              <p><strong>Point:</strong> ${escapeHtml(modelPoint.point || response.text)}</p>
              <p><strong>Argument:</strong> ${escapeHtml(response.text)}</p>
              <p><strong>How other AI challenged it:</strong></p>
              <ul>${challengeItems}</ul>
              <p><strong>Response back:</strong> ${escapeHtml(modelPoint.response_back || "No separate response-back was synthesized for this model.")}</p>
            `
            : `<p><strong>Error:</strong> ${escapeHtml(response.error)}</p>`
        }
        <details class="transcript-detail">
          <summary>Session request/response log (${transcript.length})</summary>
          <div class="transcript-list">${transcriptItems}</div>
        </details>
      </div>
    </details>
  `;
}

function buildFinalSummary(roundSummaries) {
  const last = roundSummaries.at(-1);
  const commonPointItems = last.common.map((point) => `<li>${escapeHtml(point)}</li>`).join("");
  const disagreementItems = last.disagreements
    .map((item) => {
      const positions = item.positions?.length
        ? `<ul>${item.positions.map((position) => `<li><strong>${escapeHtml(position.model)}:</strong> ${escapeHtml(position.position)}</li>`).join("")}</ul>`
        : "";
      return `<li>${escapeHtml(disagreementText(item))}${positions}</li>`;
    })
    .join("");
  const latestResponses = last.responses;
  const detailCards = latestResponses.map((response) => buildModelDetail(response, last, latestResponses)).join("");

  return `
    <div class="result-counts">
      <span>${last.common.length} common points</span>
      <span>${last.disagreements.length} disagreements</span>
    </div>
    <p>${escapeHtml(last.shortSummary || "The summarizer returned no short summary.")}</p>
    <p><strong>Common points:</strong></p>
    <ul>${commonPointItems || "<li>No common points were identified.</li>"}</ul>
    <p><strong>Significant disagreements:</strong></p>
    <ul>${disagreementItems || "<li>No significant disagreements were identified.</li>"}</ul>
    <div class="detail-list">${detailCards}</div>
  `;
}

function validateBeforeRun() {
  const activeModels = selectedModels();
  if (activeModels.length === 0) return "Select at least one model.";
  if (!elements.promptInput.value.trim()) return "Enter a question first.";
  const summarizer = selectedSummarizer();
  if (!summarizer) return "Select a summarizer model.";
  if (!hasProviderAccess(summarizer)) return `${providers[summarizer.provider].name} API key is required for the selected summarizer.`;
  return "";
}

async function runDiscussion() {
  if (state.running) return;
  const validationError = validateBeforeRun();
  if (validationError) {
    elements.activityPanel.classList.remove("hidden");
    setProgress(validationError, 0);
    return;
  }

  if (!elements.continueSessionInput.checked) {
    state.sessionTurns = [];
    state.modelTranscripts = {};
    elements.activityLog.innerHTML = "";
    elements.finalSummary.innerHTML = "";
    elements.modelDetails.innerHTML = "";
    elements.activityPanel.classList.add("hidden");
    elements.finalPanel.classList.add("hidden");
    state.totalCost = 0;
    state.lastRoundCost = 0;
  }
  state.running = true;
  state.totalCost = 0;
  state.lastRoundCost = 0;
  elements.activityPanel.classList.remove("hidden");
  elements.finalPanel.classList.add("hidden");
  elements.activityLog.innerHTML = "";
  elements.finalSummary.innerHTML = "";
  elements.modelDetails.innerHTML = "";
  elements.runState.textContent = "Running";
  elements.runButton.disabled = true;
  setProgress("Preparing selected models", 4);
  renderCosts();

  const activeModels = selectedModels();
  const maxRounds = Number(elements.roundsInput.value || 3);
  const roundSummaries = [];
  let disagreementPacket = "";

  try {
    for (let round = 1; round <= maxRounds; round += 1) {
      const roundBase = ((round - 1) / maxRounds) * 90;
      setProgress(`Round ${round}: asking ${activeModels.length} models`, roundBase + 8);
      const responses = await Promise.all(activeModels.map((model) => askModel(model, elements.promptInput.value, round, disagreementPacket)));
      for (const response of responses) {
        state.modelTranscripts[response.model.id] ||= [];
        state.modelTranscripts[response.model.id].push({
          round: response.round,
          request: response.request,
          response: response.ok ? response.text : response.error,
          latency: response.latency,
          status: response.ok ? "ok" : "error",
          prompt: elements.promptInput.value.trim(),
          createdAt: new Date().toISOString()
        });
      }
      setProgress(`Round ${round}: summarizing model responses`, roundBase + 22);

      const summarizer = selectedSummarizer();
      state.lastRoundCost = activeModels.reduce((sum, model) => sum + model.estimatedRoundCost, 0) + (summarizer?.estimatedRoundCost || 0);
      state.totalCost += state.lastRoundCost;
      renderCosts();

      const summary = await summarizeRound(responses, round, maxRounds);
      roundSummaries.push(summary);
      setProgress(
        summary.disagreements.length === 0 ? `Round ${round}: agreement reached` : `Round ${round}: ${summary.disagreements.length} disagreements found`,
        roundBase + 30
      );

      if (summary.disagreements.length === 0) break;
      disagreementPacket = summary.disagreements.map(disagreementText).join("\n");
    }

    elements.finalPanel.classList.remove("hidden");
    const finalRound = roundSummaries.at(-1);
    elements.finalSummary.innerHTML = buildFinalSummary(roundSummaries);
    state.sessionTurns.push({
      prompt: elements.promptInput.value.trim(),
      commonCount: finalRound.common.length,
      disagreementCount: finalRound.disagreements.length,
      shortSummary: finalRound.shortSummary,
      completedAt: new Date().toISOString()
    });
    setProgress(`Completed · ${finalRound.common.length} common · ${finalRound.disagreements.length} disagreements`, 100);
    elements.runState.textContent = "Complete";
  } catch (error) {
    elements.activityPanel.classList.remove("hidden");
    setProgress(`Stopped: ${error.message}`, 0);
    elements.runState.textContent = "Error";
  } finally {
    elements.runButton.disabled = false;
    state.running = false;
  }
}

function bindEvents() {
  elements.settingsToggle.addEventListener("click", () => {
    state.settingsCollapsed = !state.settingsCollapsed;
    renderSettingsState();
  });

  elements.modelList.addEventListener("change", (event) => {
    const checkbox = event.target.closest("input[type='checkbox']");
    if (!checkbox) return;
    if (checkbox.checked) {
      state.selectedModels.add(checkbox.dataset.modelId);
    } else {
      state.selectedModels.delete(checkbox.dataset.modelId);
    }
    render();
  });

  elements.modelList.addEventListener("click", (event) => {
    const saveButton = event.target.closest("[data-save-key]");
    const changeButton = event.target.closest("[data-change-key]");
    const cancelButton = event.target.closest("[data-cancel-key]");
    const statusButton = event.target.closest("[data-provider-status]");

    if (saveButton) {
      const providerId = saveButton.dataset.saveKey;
      const input = elements.modelList.querySelector(`[data-provider-key="${providerId}"]`);
      if (input?.value.trim()) {
        state.providerKeys[providerId] = input.value.trim();
        state.editingProviderKeys.delete(providerId);
        saveProviderKeys();
        render();
      }
      return;
    }

    if (changeButton) {
      state.editingProviderKeys.add(changeButton.dataset.changeKey);
      render();
      return;
    }

    if (cancelButton) {
      state.editingProviderKeys.delete(cancelButton.dataset.cancelKey);
      render();
      return;
    }

    if (statusButton && statusButton.classList.contains("warning")) {
      const providerId = statusButton.dataset.providerStatus;
      const input = elements.modelList.querySelector(`[data-provider-key="${providerId}"]`);
      input?.focus();
    }
  });

  elements.roundsInput.addEventListener("change", renderCosts);
  elements.summarizerSelect.addEventListener("change", render);
  elements.ollamaRefreshButton?.addEventListener("click", () => {
    syncOllamaModels();
  });
  elements.runButton.addEventListener("click", runDiscussion);
  elements.clearButton.addEventListener("click", () => {
    elements.activityLog.innerHTML = "";
    elements.finalSummary.innerHTML = "";
    elements.modelDetails.innerHTML = "";
    elements.activityPanel.classList.add("hidden");
    elements.finalPanel.classList.add("hidden");
    setProgress("Ready", 0);
    elements.runState.textContent = "Ready";
    state.totalCost = 0;
    state.lastRoundCost = 0;
    state.sessionTurns = [];
    state.modelTranscripts = {};
    renderCosts();
  });
}

async function init() {
  try {
    const config = await loadModelConfig();
    providers = config.providers;
    modelCatalog = config.models.map(normalizeModel);
    state = {
      running: false,
      settingsCollapsed: true,
      selectedModels: new Set(modelCatalog.filter((model) => model.selected).map((model) => model.id)),
      providerKeys: loadProviderKeys(),
      editingProviderKeys: new Set(),
      ollama: {
        status: "unknown",
        message: "Ollama not checked yet"
      },
      totalCost: 0,
      lastRoundCost: 0,
      sessionTurns: [],
      modelTranscripts: {}
    };
    renderSummarizerOptions();
    render();
    bindEvents();
    syncOllamaModels({ silent: true });
  } catch (error) {
    elements.runState.textContent = "Config error";
    elements.activityPanel.classList.remove("hidden");
    setProgress(`Model config failed: ${error.message}`, 0);
  }
}

init();
