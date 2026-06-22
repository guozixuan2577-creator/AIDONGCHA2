import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, "data");
const agentsDir = path.join(dataDir, "agents");

let cachedState = null;

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

export async function loadState() {
  if (cachedState) return cachedState;
  const files = (await fs.readdir(agentsDir)).filter((file) => file.endsWith(".json")).sort();
  const agents = [];
  for (const file of files) {
    agents.push(await readJson(path.join(agentsDir, file), null));
  }
  cachedState = {
    agents: agents.filter(Boolean),
    market: await readJson(path.join(dataDir, "market_knowledge.json"), []),
  };
  return cachedState;
}

export function hasDeepSeekKey() {
  return Boolean(process.env.DEEPSEEK_API_KEY);
}

function getHeader(headers, name) {
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === lowerName) return Array.isArray(value) ? value[0] : value;
  }
  return "";
}

export function authStatus(headers = {}) {
  const apiToken = process.env.API_TOKEN || "";
  const bearer = String(getHeader(headers, "authorization") || "").replace(/^Bearer\s+/i, "");
  const apiHeader = String(getHeader(headers, "x-api-token") || "");
  return {
    apiConfigured: Boolean(apiToken),
    apiAuthorized: Boolean(apiToken) && (apiHeader === apiToken || bearer === apiToken),
  };
}

export function requireBrainAuth(headers) {
  return authStatus(headers).apiAuthorized;
}

function normalize(value) {
  return String(value || "").toLowerCase();
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function asArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : value ? [value] : [];
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function coverageMode(value) {
  return value === "focused" ? "focused" : "broad";
}

function styleProfile(subjectivityLevel = 50) {
  const level = clampNumber(subjectivityLevel, 0, 100, 50);
  if (level <= 30) return { subjectivity_level: level, label: "客观", instruction: "偏研究员口吻，证据优先，清楚区分原文、推断和市场背景。" };
  if (level >= 70) return { subjectivity_level: level, label: "主观", instruction: "更像真实居民第一人称表达，可以有感受、犹豫和生活细节，但不能编造经历。" };
  return { subjectivity_level: level, label: "平衡", instruction: "兼顾证据和第一人称生活感，回答要像具体的人，而不是模板。" };
}

function tokenize(value) {
  const text = normalize(value);
  return [
    ...new Set([
      ...(text.match(/[\u4e00-\u9fff]{2,}/g) || []),
      ...(text.match(/[a-z0-9]{2,}/g) || []),
    ]),
  ].filter((token) => !["the", "and", "for", "with", "that", "this", "what", "why", "how", "手机", "用户"].includes(token));
}

function scoreDocument(tokens, text, tags = []) {
  const body = normalize(text);
  const tagText = normalize(tags.join(" "));
  let score = 0;
  for (const token of tokens) {
    if (body.includes(token)) score += token.length > 3 ? 3 : 2;
    if (tagText.includes(token)) score += 4;
  }
  return score;
}

function evidenceDimension(item) {
  const text = normalize([item.interview_module, item.question_text_raw, item.answer_text_clean, asArray(item.tags).join(" ")].join(" "));
  if (/family|friend|social|college|school|university|study|job|work|routine|daily|life|home/.test(text)) return "生活/家庭/学习工作/社交";
  if (/app|instagram|whatsapp|tiktok|youtube|netflix|game|drama|music|content|photo|video/.test(text)) return "App/内容/娱乐场景";
  if (/buy|purchase|journey|shop|channel|review|exchange|warranty|resale|trust|recommend/.test(text)) return "购机旅程/渠道/信任";
  if (/brand|infinix|tecno|samsung|vivo|oppo|iphone|realme|redmi|xiaomi|apple/.test(text)) return "品牌认知";
  if (/price|budget|pkr|rs\.?|expensive|cheap|pay|income|cost|value/.test(text)) return "价格预算";
  if (/camera|battery|charge|display|design|processor|performance|storage|ram|rom|5g|water|fingerprint|feature/.test(text)) return "功能/产品体验";
  if (/ad|advert|promotion|campaign|poster|influencer|marketing|launch/.test(text)) return "广告促销";
  return "其他深访细节";
}

function scoreEvidence(questionTokens, item) {
  return scoreDocument(
    questionTokens,
    [item.interview_module, item.question_text_raw, item.answer_text_clean, item.embedding_text].join("\n"),
    item.tags || [],
  ) + (item.evidence_strength === "strong" ? 1.5 : item.evidence_strength === "medium" ? 1 : 0.4);
}

function truncate(value, limit) {
  const text = cleanText(value);
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function agentSummary(agent) {
  return {
    agent_id: agent.agent_id,
    display_name: agent.display_name,
    current_phone_raw: agent.current_phone_raw,
    stats: agent.stats,
    profile: agent.full_profile,
  };
}

export function listAgents(state) {
  return state.agents.map(agentSummary);
}

export function getAgent(state, agentId) {
  return state.agents.find((agent) => agent.agent_id === agentId) || null;
}

function selectMarketContext(state, question, limit = 4) {
  const tokens = tokenize(question);
  return state.market
    .map((item) => ({
      item,
      score: scoreDocument(tokens, [item.title, item.text, item.embedding_text].join("\n"), item.tags || []),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.item);
}

function selectEvidence(agent, question, mode) {
  const tokens = tokenize(question);
  const scored = agent.all_evidence
    .map((item) => ({ item, score: scoreEvidence(tokens, item), dimension: evidenceDimension(item) }))
    .sort((a, b) => b.score - a.score || Number(b.item.confidence_score || 0) - Number(a.item.confidence_score || 0));
  const selected = [];
  const seen = new Set();
  const add = (entry, reason) => {
    if (!entry?.item?.evidence_id || seen.has(entry.item.evidence_id)) return;
    seen.add(entry.item.evidence_id);
    selected.push({ ...entry, reason });
  };

  for (const entry of scored.filter((entry) => entry.score > 1.5).slice(0, mode === "broad" ? 10 : 7)) add(entry, "问题直接命中");
  if (!selected.length) for (const entry of scored.slice(0, mode === "broad" ? 6 : 4)) add(entry, "最佳可用证据");

  const dimensions = [...new Set(scored.map((entry) => entry.dimension))];
  for (const dimension of dimensions.slice(0, mode === "broad" ? dimensions.length : 4)) {
    add(scored.find((entry) => entry.dimension === dimension), `覆盖维度：${dimension}`);
  }
  for (const entry of scored.filter((entry) => entry.item.evidence_strength === "strong").slice(0, mode === "broad" ? 8 : 4)) add(entry, "强证据补充");

  const maxItems = mode === "broad" ? 24 : 12;
  return selected.slice(0, maxItems).map((entry) => ({
    ...entry.item,
    retrieval_reason: entry.reason,
    retrieval_dimension: entry.dimension,
  }));
}

function buildPrompt({ agent, question, evidence, marketContext, mode, style, outputLanguage }) {
  const evidenceText = evidence
    .map((item) => `- ${item.citation_label || item.evidence_id} | ${item.retrieval_dimension} | ${item.retrieval_reason}\nQ: ${truncate(item.question_text_raw, 260)}\nA: ${truncate(item.answer_text_clean, mode === "broad" ? 1000 : 650)}`)
    .join("\n");
  const marketText = marketContext
    .map((item) => `- ${item.citation_label || item.market_id}: ${truncate(item.quote_display_text || item.text, 520)}`)
    .join("\n");
  return {
    system: [
      "你是一个由真实深访资料构成的巴基斯坦手机用户 agent。",
      "回答时必须以当前 agent 的完整深访证据为边界，不能编造访谈中没有的个人经历。",
      mode === "broad" ? "当前是 broad 模式：开放问题要尽量覆盖生活、家庭、学习/工作、社交、娱乐/App、购机、品牌、价格、功能、广告、渠道、顾虑等相关方面。" : "当前是 focused 模式：先回答问题本身，只补充最相关的背景。",
      style.instruction,
      "回答要避免模板化，必须使用这个用户独有的细节或原话倾向。",
      outputLanguage === "en" ? "Use English." : "默认用中文回答，必要时保留英文原话关键词。",
    ].join("\n"),
    user: JSON.stringify(
      {
        user_question: question,
        coverage_mode: mode,
        style_profile: style,
        agent_profile: agent.full_profile,
        retrieval_index: agent.retrieval_index,
        selected_interview_evidence: evidenceText,
        market_context: marketText || "(none)",
        output_contract: {
          answer_title: "短标题",
          answer: "直接回答。broad 模式下要覆盖多个相关深访方面；说明哪些来自原文、哪些是画像推断、哪些是市场背景。",
          supporting_basis: "2-4 条依据",
        },
      },
      null,
      2,
    ),
  };
}

async function callDeepSeek(prompt, style) {
  if (!hasDeepSeekKey()) return null;
  const response = await fetch("https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
      temperature: style.subjectivity_level >= 70 ? 0.62 : style.subjectivity_level <= 30 ? 0.32 : 0.45,
    }),
  });
  if (!response.ok) throw new Error(`DeepSeek API error ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const payload = await response.json();
  return payload.choices?.[0]?.message?.content?.trim() || "";
}

function answerTitle(answer) {
  const firstLine = String(answer || "").split(/\n+/).find(Boolean) || "Agent 回答";
  return firstLine.length > 42 ? `${firstLine.slice(0, 41)}...` : firstLine;
}

function modelRequired(agentId) {
  return {
    agent_id: agentId,
    answer_title: "需要配置 DeepSeek API Key",
    answer: "项目已准备好，但当前没有检测到 DEEPSEEK_API_KEY。请在 Vercel 环境变量中配置后重新部署。",
    supporting_basis: ["未检测到 DEEPSEEK_API_KEY", "API Key 只应放在 Vercel Environment Variables 中。"],
    model_required: true,
  };
}

export async function askAgent({ state, agentId, question, coverage_mode = "broad", subjectivity_level = 50, output_language = "zh", debug = false }) {
  const agent = getAgent(state, agentId);
  if (!agent) return { status: 404, body: { error: "Agent not found." } };
  if (!hasDeepSeekKey()) return { status: 428, body: modelRequired(agentId) };
  const mode = coverageMode(coverage_mode);
  const style = styleProfile(subjectivity_level);
  const evidence = selectEvidence(agent, question, mode);
  const marketContext = selectMarketContext(state, question, 4);
  const prompt = buildPrompt({ agent, question, evidence, marketContext, mode, style, outputLanguage: output_language });
  const answer = await callDeepSeek(prompt, style);
  const body = {
    agent_id: agent.agent_id,
    display_name: agent.display_name,
    current_phone_raw: agent.current_phone_raw,
    answer_title: answerTitle(answer),
    answer,
    coverage_mode: mode,
    style_profile: style,
    supporting_basis: evidence.slice(0, 4).map((item) => `${item.interview_module}: ${truncate(item.answer_text_clean, 150)}`),
    evidence_used: evidence.map((item) => ({
      evidence_id: item.evidence_id,
      source_row: item.source_row,
      interview_module: item.interview_module,
      dimension: item.retrieval_dimension,
      reason: item.retrieval_reason,
      citation_label: item.citation_label,
    })),
    model_required: false,
  };
  if (debug) body.hidden_prompt = prompt;
  return { status: 200, body };
}

export async function askTown({ state, question, coverage_mode = "broad", subjectivity_level = 50, output_language = "zh", debug = false }) {
  if (!hasDeepSeekKey()) return { status: 428, body: modelRequired("town") };
  const results = await Promise.all(
    state.agents.map((agent) =>
      askAgent({
        state,
        agentId: agent.agent_id,
        question,
        coverage_mode,
        subjectivity_level,
        output_language,
        debug,
      }),
    ),
  );
  const answers = results.filter((result) => result.status === 200).map((result) => result.body);
  return {
    status: 200,
    body: {
      question,
      agent_count: answers.length,
      summary_answer: answers.map((answer) => `${answer.display_name}: ${answer.answer_title}`).join("\n"),
      coverage_mode: coverageMode(coverage_mode),
      style_profile: styleProfile(subjectivity_level),
      agent_answers: answers,
    },
  };
}
