import {
  askAgent,
  askTown,
  authStatus,
  getAgent,
  hasDeepSeekKey,
  listAgents,
  loadState,
  requireBrainAuth,
} from "../lib/agent-core.js";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type,authorization,x-api-token");
}

function send(res, status, body) {
  setCors(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch {
    return {};
  }
}

function getPath(req) {
  const url = new URL(req.url || "/", "http://localhost");
  return url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
}

function badRequest(res, message) {
  return send(res, 400, { error: "Bad request", message });
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  try {
    const state = await loadState();
    const [resource, id] = getPath(req);

    if (req.method === "GET" && resource === "health") {
      const auth = authStatus(req.headers);
      return send(res, 200, {
        ok: true,
        runtime: "vercel-functions",
        agents: state.agents.length,
        market_knowledge: state.market.length,
        has_deepseek_key: hasDeepSeekKey(),
        api_token_configured: auth.apiConfigured,
      });
    }

    if (req.method === "GET" && resource === "agents" && !id) {
      return send(res, 200, listAgents(state));
    }

    if (req.method === "GET" && resource === "agents" && id) {
      const agent = getAgent(state, id);
      if (!agent) return send(res, 404, { error: "Agent not found." });
      return send(res, 200, agent);
    }

    if (req.method === "POST" && resource === "ask-agent") {
      const body = await readBody(req);
      const agentId = body.agent_id || body.respondent_id;
      if (!agentId) return badRequest(res, "agent_id is required.");
      if (!body.question) return badRequest(res, "question is required.");
      const result = await askAgent({
        state,
        agentId,
        question: body.question,
        coverage_mode: body.coverage_mode || "broad",
        subjectivity_level: body.subjectivity_level ?? 50,
        output_language: body.output_language || "zh",
        debug: Boolean(body.debug),
      });
      return send(res, result.status, result.body);
    }

    if (req.method === "POST" && resource === "ask-town") {
      const body = await readBody(req);
      if (!body.question) return badRequest(res, "question is required.");
      const result = await askTown({
        state,
        question: body.question,
        coverage_mode: body.coverage_mode || "broad",
        subjectivity_level: body.subjectivity_level ?? 50,
        output_language: body.output_language || "zh",
        debug: Boolean(body.debug),
      });
      return send(res, result.status, result.body);
    }

    if (resource === "brain") {
      if (req.method !== "POST") return send(res, 405, { error: "Method not allowed." });
      if (!requireBrainAuth(req.headers)) return send(res, 401, { error: "Unauthorized", message: "需要有效的 API_TOKEN。" });
      if (!id) return badRequest(res, "agent_id is required in /api/brain/:agent_id.");
      const body = await readBody(req);
      if (!body.question) return badRequest(res, "question is required.");
      const result = await askAgent({
        state,
        agentId: id,
        question: body.question,
        coverage_mode: body.coverage_mode || "broad",
        subjectivity_level: body.subjectivity_level ?? 50,
        output_language: body.output_language || "zh",
        debug: Boolean(body.debug),
      });
      return send(res, result.status, result.body);
    }

    return send(res, 404, { error: "Not found." });
  } catch (error) {
    return send(res, 500, {
      error: "Internal server error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
