const state = {
  agents: [],
  mode: "single",
};

const $ = (selector) => document.querySelector(selector);

const els = {
  healthBadge: $("#healthBadge"),
  agentSelect: $("#agentSelect"),
  agentList: $("#agentList"),
  agentCount: $("#agentCount"),
  questionInput: $("#questionInput"),
  languageSelect: $("#languageSelect"),
  coverageMode: $("#coverageMode"),
  subjectivityLevel: $("#subjectivityLevel"),
  subjectivityValue: $("#subjectivityValue"),
  answerArea: $("#answerArea"),
  askBtn: $("#askBtn"),
  sampleBtn: $("#sampleBtn"),
  refreshBtn: $("#refreshBtn"),
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || data.answer || data.error || "请求失败");
    error.status = response.status;
    error.payload = data;
    throw error;
  }
  return data;
}

function agentTitle(agent) {
  return String(agent.display_name || agent.agent_id || "").replace(/\s+/g, " ").trim();
}

function tags(items, limit = 8) {
  const values = (Array.isArray(items) ? items : [items]).filter(Boolean).slice(0, limit);
  return values.length ? `<ul class="tag-list">${values.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : "";
}

function renderAgents() {
  els.agentCount.textContent = `${state.agents.length} 位`;
  els.agentSelect.innerHTML = state.agents
    .map((agent) => `<option value="${escapeHtml(agent.agent_id)}">${escapeHtml(agentTitle(agent))}</option>`)
    .join("");
  els.agentList.innerHTML = state.agents
    .map((agent) => {
      const profile = agent.profile || {};
      const base = profile.base_profile || {};
      const model = profile.mobile_decision_model || {};
      return `
        <article class="agent-card">
          <h3>${escapeHtml(agentTitle(agent))}</h3>
          <p>${escapeHtml(agent.current_phone_raw || "当前手机未知")}</p>
          <p>${escapeHtml([base.occupation_or_role, base.city_or_area].filter(Boolean).join(" / ") || "深访 agent")}</p>
          ${tags([...(model.valued_features || []).slice(0, 4), `${agent.stats?.nonempty_evidence_count || 0} 条深访证据`])}
        </article>
      `;
    })
    .join("");
}

function renderSingleAnswer(payload) {
  return `
    <article class="answer-card">
      <h3>${escapeHtml(payload.answer_title || "Agent 回答")}</h3>
      <div class="answer-meta">
        <span>${escapeHtml(payload.display_name || payload.agent_id || "Agent")}</span>
        <span>${escapeHtml(payload.coverage_mode || "broad")}</span>
        <span>${escapeHtml(payload.style_profile?.label || "平衡")}</span>
        <span>${escapeHtml((payload.evidence_used || []).length)} 条证据</span>
      </div>
      <p>${escapeHtml(payload.answer || "").replaceAll("\n", "<br />")}</p>
      ${renderEvidence(payload.evidence_used)}
    </article>
  `;
}

function renderEvidence(evidence) {
  const items = (evidence || []).slice(0, 8);
  if (!items.length) return "";
  return `
    <details class="evidence-box">
      <summary>本次调用的证据</summary>
      <ul>
        ${items.map((item) => `<li>${escapeHtml(item.citation_label || item.evidence_id)} · ${escapeHtml(item.dimension || "")}</li>`).join("")}
      </ul>
    </details>
  `;
}

function renderTownAnswer(payload) {
  return `
    <article class="answer-card">
      <h3>全镇汇总</h3>
      <p>${escapeHtml(payload.summary_answer || "").replaceAll("\n", "<br />")}</p>
    </article>
    ${(payload.agent_answers || []).map(renderSingleAnswer).join("")}
  `;
}

function renderModelRequired(payload) {
  return `
    <article class="answer-card">
      <h3>${escapeHtml(payload.answer_title || "需要配置 DeepSeek")}</h3>
      <p>${escapeHtml(payload.answer || "请在 Vercel 环境变量中配置 DEEPSEEK_API_KEY。")}</p>
    </article>
  `;
}

async function loadBasics() {
  const health = await fetch("/api/health").then((response) => response.json());
  els.healthBadge.textContent = health.has_deepseek_key ? "DeepSeek 已连接" : "待配置 DeepSeek";
  els.healthBadge.className = `status-pill ${health.has_deepseek_key ? "ready" : "warn"}`;
  state.agents = await api("/api/agents");
  renderAgents();
}

async function ask() {
  const question = els.questionInput.value.trim();
  if (!question) {
    els.answerArea.innerHTML = `<p class="empty-state">请先输入问题。</p>`;
    return;
  }
  els.askBtn.disabled = true;
  els.answerArea.innerHTML = `<p class="empty-state">Agent 正在读取深访证据并生成回答...</p>`;
  try {
    const body = {
      question,
      coverage_mode: els.coverageMode.value,
      subjectivity_level: Number(els.subjectivityLevel.value || 50),
      output_language: els.languageSelect.value,
    };
    if (state.mode === "single") {
      body.agent_id = els.agentSelect.value;
      els.answerArea.innerHTML = renderSingleAnswer(await api("/api/ask-agent", { method: "POST", body: JSON.stringify(body) }));
    } else {
      els.answerArea.innerHTML = renderTownAnswer(await api("/api/ask-town", { method: "POST", body: JSON.stringify(body) }));
    }
  } catch (error) {
    els.answerArea.innerHTML = error.status === 428 && error.payload ? renderModelRequired(error.payload) : `<p class="error-state">${escapeHtml(error.message)}</p>`;
  } finally {
    els.askBtn.disabled = false;
  }
}

function bindEvents() {
  document.querySelectorAll(".segment").forEach((button) => {
    button.addEventListener("click", () => {
      state.mode = button.dataset.mode;
      document.querySelectorAll(".segment").forEach((item) => item.classList.toggle("active", item === button));
      els.agentSelect.disabled = state.mode === "town";
    });
  });
  els.askBtn.addEventListener("click", ask);
  els.refreshBtn.addEventListener("click", () => loadBasics().catch(showLoadError));
  els.subjectivityLevel.addEventListener("input", () => {
    els.subjectivityValue.textContent = els.subjectivityLevel.value;
  });
  els.sampleBtn.addEventListener("click", () => {
    els.questionInput.value = "这个用户是怎样的人？他或她如何看待换手机、预算、品牌和功能？";
    els.questionInput.focus();
  });
}

function showLoadError(error) {
  els.agentList.innerHTML = `<p class="error-state">${escapeHtml(error.message)}</p>`;
}

bindEvents();
loadBasics().catch(showLoadError);
