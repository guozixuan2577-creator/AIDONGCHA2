# 巴基斯坦手机用户小镇 · 干净 Agent 版

这是一个可直接部署到 Vercel 的干净项目包。

## 内容

- `data/agents/`：8 个详尽版用户 agent JSON，保留每位用户所有非空深访问答。
- `api/`：Vercel Serverless API。
- `lib/`：agent 召回和 DeepSeek 调用逻辑。
- `public/`：中文前端页面。

## Vercel 环境变量

```text
DEEPSEEK_API_KEY=你的 DeepSeek API Key
DEEPSEEK_MODEL=deepseek-chat
API_TOKEN=一个私密 token，用于 /api/brain/:agent_id
```

## 可用接口

- `GET /api/health`
- `GET /api/agents`
- `GET /api/agents/:id`
- `POST /api/ask-agent`
- `POST /api/ask-town`
- `POST /api/brain/:agent_id`

默认回答中文，默认 `coverage_mode=broad`，会尽量覆盖深访中相关的多个方面。
