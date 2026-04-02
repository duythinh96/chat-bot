import "dotenv/config";
import cors from "cors";
import express from "express";
import crypto from "crypto";

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = Number(process.env.PORT || 8787);
const DEFAULT_MODEL = process.env.GEMINI_DEFAULT_MODEL || "gemini-2.5-flash";

function nowUnixSeconds() {
  return Math.floor(Date.now() / 1000);
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
}

function normalizeModel(model) {
  if (!model) return DEFAULT_MODEL;
  if (model.startsWith("google/")) return model.slice("google/".length);
  if (model.startsWith("gemini/")) return model.slice("gemini/".length);
  if (model.startsWith("claude-")) return DEFAULT_MODEL;
  return model;
}

function coerceNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

function extractBearerToken(authorizationHeaderValue) {
  if (typeof authorizationHeaderValue !== "string") return "";
  const match = authorizationHeaderValue.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}

function getGeminiApiKey(req) {
  const envKey = process.env.GEMINI_API_KEY;
  if (typeof envKey === "string" && envKey.trim()) return envKey.trim();

  const xApiKey = req.get("x-api-key");
  if (typeof xApiKey === "string" && xApiKey.trim()) return xApiKey.trim();

  const bearer = extractBearerToken(req.get("authorization"));
  if (bearer) return bearer;

  return "";
}

function buildGeminiRequestFromOpenAI({ messages, temperature, top_p, max_tokens, stream }) {
  const systemTexts = [];
  const contents = [];

  for (const msg of Array.isArray(messages) ? messages : []) {
    if (!msg || typeof msg !== "object") continue;
    const role = msg.role;
    const content = typeof msg.content === "string" ? msg.content : "";
    if (!content) continue;

    if (role === "system") {
      systemTexts.push(content);
      continue;
    }

    if (role === "assistant") {
      contents.push({ role: "model", parts: [{ text: content }] });
      continue;
    }

    contents.push({ role: "user", parts: [{ text: content }] });
  }

  const generationConfig = {};

  const t = coerceNumber(temperature);
  if (t !== undefined) generationConfig.temperature = t;

  const tp = coerceNumber(top_p);
  if (tp !== undefined) generationConfig.topP = tp;

  const mt = coerceNumber(max_tokens);
  if (mt !== undefined) generationConfig.maxOutputTokens = mt;

  const payload = {
    contents: contents.length ? contents : [{ role: "user", parts: [{ text: "" }] }]
  };

  if (systemTexts.length) {
    payload.systemInstruction = { parts: [{ text: systemTexts.join("\n") }] };
  }

  if (Object.keys(generationConfig).length) {
    payload.generationConfig = generationConfig;
  }

  if (stream) {
    payload.stream = true;
  }

  return payload;
}

function extractTextFromAnthropicContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && typeof b === "object" && b.type === "text" ? String(b.text || "") : ""))
    .join("");
}

function buildGeminiRequestFromAnthropic({ system, messages, temperature, top_p, max_tokens, stream }) {
  const systemText = extractTextFromAnthropicContent(system);
  const contents = [];

  for (const msg of Array.isArray(messages) ? messages : []) {
    if (!msg || typeof msg !== "object") continue;
    const role = msg.role;
    const text = extractTextFromAnthropicContent(msg.content);
    if (!text) continue;

    if (role === "assistant") {
      contents.push({ role: "model", parts: [{ text }] });
      continue;
    }

    contents.push({ role: "user", parts: [{ text }] });
  }

  const generationConfig = {};
  const t = coerceNumber(temperature);
  if (t !== undefined) generationConfig.temperature = t;

  const tp = coerceNumber(top_p);
  if (tp !== undefined) generationConfig.topP = tp;

  const mt = coerceNumber(max_tokens);
  if (mt !== undefined) generationConfig.maxOutputTokens = mt;

  const payload = {
    contents: contents.length ? contents : [{ role: "user", parts: [{ text: "" }] }]
  };

  if (systemText) {
    payload.systemInstruction = { parts: [{ text: systemText }] };
  }

  if (Object.keys(generationConfig).length) {
    payload.generationConfig = generationConfig;
  }

  if (stream) {
    payload.stream = true;
  }

  return payload;
}

function extractTextFromGeminiCandidate(candidate) {
  const parts = candidate?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts.map((p) => (typeof p?.text === "string" ? p.text : "")).join("");
}

function asOpenAIChatCompletion({ id, model, text, promptTokens, completionTokens }) {
  return {
    id,
    object: "chat.completion",
    created: nowUnixSeconds(),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text ?? "" },
        finish_reason: "stop"
      }
    ],
    usage: {
      prompt_tokens: promptTokens ?? 0,
      completion_tokens: completionTokens ?? 0,
      total_tokens: (promptTokens ?? 0) + (completionTokens ?? 0)
    }
  };
}

function writeSse(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function writeSseDone(res) {
  res.write("data: [DONE]\n\n");
}

function writeSseEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

app.get("/healthz", (req, res) => {
  res.json({ ok: true });
});

app.get("/v1/models", (req, res) => {
  res.json({
    object: "list",
    data: [
      { id: "google/gemini-2.5-flash", object: "model", created: 0, owned_by: "google" },
      { id: "google/gemini-2.5-pro", object: "model", created: 0, owned_by: "google" },
      { id: "google/gemini-2.5-flash-lite", object: "model", created: 0, owned_by: "google" },
      { id: "google/gemini-2.0-flash-001", object: "model", created: 0, owned_by: "google" }
    ]
  });
});

app.post("/v1/chat/completions", async (req, res) => {
  const apiKey = getGeminiApiKey(req);
  if (!apiKey) {
    res.status(500).json({
      error: { message: "Missing GEMINI_API_KEY env var", type: "server_error" }
    });
    return;
  }

  const { model, messages, temperature, top_p, max_tokens, stream } = req.body || {};
  const normalizedModel = normalizeModel(model);

  const payload = buildGeminiRequestFromOpenAI({
    messages,
    temperature,
    top_p,
    max_tokens,
    stream: Boolean(stream)
  });

  const id = randomId("chatcmpl");

  try {
    if (stream) {
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        normalizedModel
      )}:streamGenerateContent?key=${encodeURIComponent(apiKey)}`;

      const upstream = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!upstream.ok || !upstream.body) {
        const text = await upstream.text().catch(() => "");
        res.status(502);
        writeSse(res, {
          id,
          object: "chat.completion.chunk",
          created: nowUnixSeconds(),
          model: normalizedModel,
          choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }],
          error: { message: text || `Upstream error (${upstream.status})` }
        });
        writeSseDone(res);
        res.end();
        return;
      }

      writeSse(res, {
        id,
        object: "chat.completion.chunk",
        created: nowUnixSeconds(),
        model: normalizedModel,
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }]
      });

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          let json;
          try {
            json = JSON.parse(trimmed);
          } catch {
            continue;
          }

          const candidate = Array.isArray(json?.candidates) ? json.candidates[0] : undefined;
          const deltaText = extractTextFromGeminiCandidate(candidate);
          if (!deltaText) continue;

          writeSse(res, {
            id,
            object: "chat.completion.chunk",
            created: nowUnixSeconds(),
            model: normalizedModel,
            choices: [{ index: 0, delta: { content: deltaText }, finish_reason: null }]
          });
        }
      }

      writeSse(res, {
        id,
        object: "chat.completion.chunk",
        created: nowUnixSeconds(),
        model: normalizedModel,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
      });
      writeSseDone(res);
      res.end();
      return;
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      normalizedModel
    )}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const upstream = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      res.status(502).json({
        error: { message: text || `Upstream error (${upstream.status})`, type: "upstream_error" }
      });
      return;
    }

    const json = await upstream.json();
    const candidate = Array.isArray(json?.candidates) ? json.candidates[0] : undefined;
    const text = extractTextFromGeminiCandidate(candidate);

    const promptTokens = json?.usageMetadata?.promptTokenCount;
    const completionTokens = json?.usageMetadata?.candidatesTokenCount;

    res.json(
      asOpenAIChatCompletion({
        id,
        model: normalizedModel,
        text,
        promptTokens: typeof promptTokens === "number" ? promptTokens : 0,
        completionTokens: typeof completionTokens === "number" ? completionTokens : 0
      })
    );
  } catch (err) {
    res.status(500).json({
      error: { message: err?.message || "Unknown error", type: "server_error" }
    });
  }
});

app.post("/v1/messages", async (req, res) => {
  const apiKey = getGeminiApiKey(req);
  if (!apiKey) {
    res.status(500).json({
      error: { message: "Missing GEMINI_API_KEY env var", type: "server_error" }
    });
    return;
  }

  const body = req.body || {};
  const normalizedModel = normalizeModel(body.model);
  const maxTokens = typeof body.max_tokens === "number" ? body.max_tokens : undefined;
  const stream = Boolean(body.stream);

  const payload = buildGeminiRequestFromAnthropic({
    system: body.system,
    messages: body.messages,
    temperature: body.temperature,
    top_p: body.top_p,
    max_tokens: maxTokens,
    stream
  });

  const id = randomId("msg");

  try {
    if (stream) {
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");

      writeSseEvent(res, "message_start", {
        type: "message_start",
        message: {
          id,
          type: "message",
          role: "assistant",
          model: body.model || normalizedModel,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 }
        }
      });

      writeSseEvent(res, "content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" }
      });

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        normalizedModel
      )}:streamGenerateContent?key=${encodeURIComponent(apiKey)}`;

      const upstream = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!upstream.ok || !upstream.body) {
        const text = await upstream.text().catch(() => "");
        writeSseEvent(res, "error", { type: "error", error: { message: text } });
        res.end();
        return;
      }

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          let json;
          try {
            json = JSON.parse(trimmed);
          } catch {
            continue;
          }

          const candidate = Array.isArray(json?.candidates) ? json.candidates[0] : undefined;
          const deltaText = extractTextFromGeminiCandidate(candidate);
          if (!deltaText) continue;

          writeSseEvent(res, "content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: deltaText }
          });
        }
      }

      writeSseEvent(res, "content_block_stop", { type: "content_block_stop", index: 0 });
      writeSseEvent(res, "message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 0 }
      });
      writeSseEvent(res, "message_stop", { type: "message_stop" });
      res.end();
      return;
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      normalizedModel
    )}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const upstream = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      res.status(502).json({
        type: "error",
        error: { type: "upstream_error", message: text || `Upstream error (${upstream.status})` }
      });
      return;
    }

    const json = await upstream.json();
    const candidate = Array.isArray(json?.candidates) ? json.candidates[0] : undefined;
    const text = extractTextFromGeminiCandidate(candidate);

    const inputTokens = json?.usageMetadata?.promptTokenCount;
    const outputTokens = json?.usageMetadata?.candidatesTokenCount;

    res.json({
      id,
      type: "message",
      role: "assistant",
      model: body.model || normalizedModel,
      content: [{ type: "text", text: text ?? "" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: typeof inputTokens === "number" ? inputTokens : 0,
        output_tokens: typeof outputTokens === "number" ? outputTokens : 0
      }
    });
  } catch (err) {
    res.status(500).json({
      type: "error",
      error: { type: "server_error", message: err?.message || "Unknown error" }
    });
  }
});

app.listen(PORT, () => {
  process.stdout.write(`Gemini proxy listening on http://localhost:${PORT}\n`);
});
