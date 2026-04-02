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

function normalizeAnthropicContentBlocks(content) {
  if (Array.isArray(content)) return content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return [];
}

function extractTextFromAnthropicToolResultContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (!block || typeof block !== "object") return "";
      if (block.type === "text") return String(block.text || "");
      return "";
    })
    .join("");
}

function normalizeGeminiFunctionCallArgs(args) {
  if (args && typeof args === "object" && !Array.isArray(args)) return args;
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return {};
}

function extractGeminiFunctionCalls(candidate) {
  const calls = [];
  const directCall = candidate?.functionCall;
  if (directCall && typeof directCall === "object") {
    const name = typeof directCall.name === "string" ? directCall.name.trim() : "";
    if (name) {
      calls.push({ name, input: normalizeGeminiFunctionCallArgs(directCall.args) });
    }
  }

  const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
  for (const part of parts) {
    const functionCall = part?.functionCall;
    if (!functionCall || typeof functionCall !== "object") continue;
    const name = typeof functionCall.name === "string" ? functionCall.name.trim() : "";
    if (!name) continue;
    calls.push({ name, input: normalizeGeminiFunctionCallArgs(functionCall.args) });
  }
  return calls;
}

function normalizeStopSequences(stopSequences) {
  if (!Array.isArray(stopSequences)) return [];
  return stopSequences
    .filter((s) => typeof s === "string")
    .map((s) => s.trim())
    .filter(Boolean);
}

function deriveAnthropicStopState({ candidate, hasToolCall, stopSequences }) {
  if (hasToolCall) {
    return { stopReason: "tool_use", stopSequence: null };
  }

  const finishReason = String(candidate?.finishReason || "").toUpperCase();
  if (finishReason === "MAX_TOKENS") {
    return { stopReason: "max_tokens", stopSequence: null };
  }

  const normalizedStopSequences = normalizeStopSequences(stopSequences);
  const finishMessage = String(candidate?.finishMessage || "").toLowerCase();
  const text = extractTextFromGeminiCandidate(candidate);
  const matchedStopSequence =
    normalizedStopSequences.find((seq) => finishMessage.includes(seq.toLowerCase())) ||
    normalizedStopSequences.find((seq) => text.includes(seq)) ||
    null;

  if (matchedStopSequence) {
    return { stopReason: "stop_sequence", stopSequence: matchedStopSequence };
  }

  return { stopReason: "end_turn", stopSequence: null };
}

function normalizeAnthropicToolResultResponse(content, isError) {
  const response = {};
  if (content && typeof content === "object" && !Array.isArray(content)) {
    Object.assign(response, content);
  } else {
    response.content = extractTextFromAnthropicToolResultContent(content);
  }
  if (isError === true) response.is_error = true;
  return response;
}

function inferSchemaTypeFromEnumValues(values) {
  if (!Array.isArray(values) || !values.length) return "string";
  const first = values.find((value) => value !== null && value !== undefined);
  if (typeof first === "number") return Number.isInteger(first) ? "integer" : "number";
  if (typeof first === "boolean") return "boolean";
  return "string";
}

function sanitizeGeminiSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object", properties: {} };
  }

  const anyOfCandidates = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : Array.isArray(schema.allOf)
        ? schema.allOf
        : [];
  const anyOf = anyOfCandidates
    .map((item) => sanitizeGeminiSchema(item))
    .filter((item) => item && typeof item === "object");

  const enumValues = Array.isArray(schema.enum) ? schema.enum.filter((v) => v !== undefined) : undefined;
  const constValue = schema.const !== undefined ? [schema.const] : undefined;
  const mergedEnum = enumValues?.length ? enumValues : constValue;

  let type = typeof schema.type === "string" ? schema.type.toLowerCase() : "";
  if (!type) {
    if (Array.isArray(schema.type)) {
      type = String(schema.type.find((t) => t && t !== "null") || "").toLowerCase();
    } else if (schema.properties && typeof schema.properties === "object") {
      type = "object";
    } else if (schema.items) {
      type = "array";
    } else if (mergedEnum?.length) {
      type = inferSchemaTypeFromEnumValues(mergedEnum);
    } else {
      type = "string";
    }
  }

  if (!["object", "array", "string", "number", "integer", "boolean"].includes(type)) {
    type = "string";
  }

  const result = { type };

  if (typeof schema.description === "string" && schema.description.trim()) {
    result.description = schema.description.trim();
  }
  if (typeof schema.format === "string" && schema.format.trim()) {
    result.format = schema.format.trim();
  }

  const nullableFromTypeArray =
    Array.isArray(schema.type) && schema.type.some((t) => String(t).toLowerCase() === "null");
  if (schema.nullable === true || nullableFromTypeArray) {
    result.nullable = true;
  }

  if (mergedEnum?.length) {
    result.enum = mergedEnum;
  }
  if (typeof schema.minLength === "number") result.minLength = schema.minLength;
  if (typeof schema.maxLength === "number") result.maxLength = schema.maxLength;
  if (typeof schema.minimum === "number") result.minimum = schema.minimum;
  if (typeof schema.maximum === "number") result.maximum = schema.maximum;
  if (typeof schema.pattern === "string" && schema.pattern) result.pattern = schema.pattern;
  if (typeof schema.minItems === "number") result.minItems = schema.minItems;
  if (typeof schema.maxItems === "number") result.maxItems = schema.maxItems;

  if (type === "object") {
    const rawProperties = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
    const properties = {};
    for (const [key, value] of Object.entries(rawProperties)) {
      properties[key] = sanitizeGeminiSchema(value);
    }
    result.properties = properties;

    if (Array.isArray(schema.required) && schema.required.length) {
      result.required = schema.required.filter((name) => typeof name === "string" && properties[name]);
    }
  } else if (type === "array") {
    result.items = sanitizeGeminiSchema(schema.items || { type: "string" });
  }

  if (anyOf.length) {
    result.anyOf = anyOf;
  }

  return result;
}

function buildGeminiToolsFromAnthropic(tools) {
  if (!Array.isArray(tools)) return undefined;
  const functionDeclarations = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    const name = typeof tool.name === "string" ? tool.name.trim() : "";
    if (!name) continue;
    const declaration = {
      name,
      parameters:
        tool.input_schema && typeof tool.input_schema === "object"
          ? sanitizeGeminiSchema(tool.input_schema)
          : { type: "object", properties: {} }
    };
    if (typeof tool.description === "string" && tool.description.trim()) {
      declaration.description = tool.description.trim();
    }
    functionDeclarations.push(declaration);
  }
  if (!functionDeclarations.length) return undefined;
  return [{ functionDeclarations }];
}

function buildGeminiToolConfigFromAnthropic(toolChoice) {
  if (!toolChoice || typeof toolChoice !== "object") return undefined;
  const type = typeof toolChoice.type === "string" ? toolChoice.type : "";
  if (type === "auto") {
    return { functionCallingConfig: { mode: "AUTO" } };
  }
  if (type === "any") {
    return { functionCallingConfig: { mode: "ANY" } };
  }
  if (type === "tool") {
    const name = typeof toolChoice.name === "string" ? toolChoice.name.trim() : "";
    if (!name) return { functionCallingConfig: { mode: "ANY" } };
    return { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [name] } };
  }
  return undefined;
}

function extractAnthropicBlocksFromGeminiCandidate(candidate, stopSequences) {
  const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
  const content = [];

  for (const part of parts) {
    if (typeof part?.text === "string" && part.text) {
      content.push({ type: "text", text: part.text });
    }

  }

  const calls = extractGeminiFunctionCalls(candidate);
  for (const call of calls) {
    content.push({
      type: "tool_use",
      id: randomId("toolu"),
      name: call.name,
      input: call.input
    });
  }

  const hasToolCall = calls.length > 0;
  const { stopReason, stopSequence } = deriveAnthropicStopState({
    candidate,
    hasToolCall,
    stopSequences
  });

  return { content, stopReason, stopSequence };
}

function buildGeminiRequestFromAnthropic({
  system,
  messages,
  temperature,
  top_p,
  max_tokens,
  stream,
  tools,
  tool_choice,
  stop_sequences
}) {
  const systemText = extractTextFromAnthropicContent(system);
  const contents = [];
  const toolUseNameById = new Map();

  for (const msg of Array.isArray(messages) ? messages : []) {
    if (!msg || typeof msg !== "object") continue;
    const role = msg.role;
    const blocks = normalizeAnthropicContentBlocks(msg.content);
    const parts = [];

    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;

      if (block.type === "text") {
        const text = String(block.text || "");
        if (text) parts.push({ text });
        continue;
      }

      if (block.type === "tool_use") {
        const name = typeof block.name === "string" ? block.name.trim() : "";
        if (!name) continue;
        const id = typeof block.id === "string" ? block.id : "";
        if (id) toolUseNameById.set(id, name);
        parts.push({
          functionCall: {
            name,
            args: block.input && typeof block.input === "object" ? block.input : {}
          }
        });
        continue;
      }

      if (block.type === "tool_result") {
        const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
        const toolName = toolUseNameById.get(toolUseId);
        if (!toolName) continue;
        parts.push({
          functionResponse: {
            name: toolName,
            response: normalizeAnthropicToolResultResponse(block.content, block.is_error)
          }
        });
      }
    }

    if (!parts.length) continue;

    if (role === "assistant") {
      contents.push({ role: "model", parts });
      continue;
    }

    contents.push({ role: "user", parts });
  }

  const generationConfig = {};
  const t = coerceNumber(temperature);
  if (t !== undefined) generationConfig.temperature = t;

  const tp = coerceNumber(top_p);
  if (tp !== undefined) generationConfig.topP = tp;

  const mt = coerceNumber(max_tokens);
  if (mt !== undefined) generationConfig.maxOutputTokens = mt;

  const stopSequences = normalizeStopSequences(stop_sequences);
  if (stopSequences.length) generationConfig.stopSequences = stopSequences;

  const payload = {
    contents: contents.length ? contents : [{ role: "user", parts: [{ text: "" }] }]
  };

  if (systemText) {
    payload.systemInstruction = { parts: [{ text: systemText }] };
  }

  if (Object.keys(generationConfig).length) {
    payload.generationConfig = generationConfig;
  }

  const geminiTools = buildGeminiToolsFromAnthropic(tools);
  if (geminiTools) payload.tools = geminiTools;

  const geminiToolConfig = buildGeminiToolConfigFromAnthropic(tool_choice);
  if (geminiToolConfig) payload.toolConfig = geminiToolConfig;

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

function parseGeminiStreamLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed) return undefined;
  const payload = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
  if (!payload || payload === "[DONE]") return undefined;
  try {
    return JSON.parse(payload);
  } catch {
    return undefined;
  }
}

function estimateTokens(text) {
  const value = typeof text === "string" ? text : "";
  if (!value) return 0;
  return Math.max(1, Math.ceil(value.length / 4));
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
          const json = parseGeminiStreamLine(line);
          if (!json) continue;

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
  const stopSequences = normalizeStopSequences(body.stop_sequences);

  const payload = buildGeminiRequestFromAnthropic({
    system: body.system,
    messages: body.messages,
    temperature: body.temperature,
    top_p: body.top_p,
    max_tokens: maxTokens,
    stream,
    tools: body.tools,
    tool_choice: body.tool_choice,
    stop_sequences: stopSequences
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

      let textBlockStarted = false;
      let textBlockIndex = -1;
      let stopReason = "end_turn";
      let stopSequence = null;
      let inputTokens = 0;
      let outputTokens = 0;
      const emittedToolUses = new Set();
      let nextContentBlockIndex = 0;

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
          const json = parseGeminiStreamLine(line);
          if (!json) continue;

          const candidate = Array.isArray(json?.candidates) ? json.candidates[0] : undefined;
          if (!candidate) continue;

          const promptTokenCount = json?.usageMetadata?.promptTokenCount;
          if (typeof promptTokenCount === "number") {
            inputTokens = Math.max(inputTokens, promptTokenCount);
          }
          const candidatesTokenCount = json?.usageMetadata?.candidatesTokenCount;
          if (typeof candidatesTokenCount === "number") {
            outputTokens = Math.max(outputTokens, candidatesTokenCount);
          }

          const deltaText = extractTextFromGeminiCandidate(candidate);
          if (deltaText) {
            if (!textBlockStarted) {
              writeSseEvent(res, "content_block_start", {
                type: "content_block_start",
                index: nextContentBlockIndex,
                content_block: { type: "text", text: "" }
              });
              textBlockStarted = true;
              textBlockIndex = nextContentBlockIndex;
              nextContentBlockIndex += 1;
            }
            writeSseEvent(res, "content_block_delta", {
              type: "content_block_delta",
              index: textBlockIndex,
              delta: { type: "text_delta", text: deltaText }
            });
            if (typeof candidatesTokenCount !== "number") {
              outputTokens += estimateTokens(deltaText);
            }
          }

          const calls = extractGeminiFunctionCalls(candidate);
          for (const call of calls) {
            const input = call.input;
            const name = call.name;
            const dedupeKey = `${name}:${JSON.stringify(input)}`;
            if (emittedToolUses.has(dedupeKey)) continue;
            emittedToolUses.add(dedupeKey);
            stopReason = "tool_use";
            const toolUse = {
              type: "tool_use",
              id: randomId("toolu"),
              name,
              input
            };
            writeSseEvent(res, "content_block_start", {
              type: "content_block_start",
              index: nextContentBlockIndex,
              content_block: toolUse
            });
            writeSseEvent(res, "content_block_stop", {
              type: "content_block_stop",
              index: nextContentBlockIndex
            });
            nextContentBlockIndex += 1;
          }

          if (stopReason !== "tool_use") {
            const stopState = deriveAnthropicStopState({
              candidate,
              hasToolCall: false,
              stopSequences
            });
            stopReason = stopState.stopReason;
            stopSequence = stopState.stopSequence;
          }
        }
      }

      if (textBlockStarted) {
        writeSseEvent(res, "content_block_stop", {
          type: "content_block_stop",
          index: textBlockIndex
        });
      }
      writeSseEvent(res, "message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: stopSequence },
        usage: { input_tokens: inputTokens, output_tokens: outputTokens }
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
    const { content, stopReason, stopSequence } = extractAnthropicBlocksFromGeminiCandidate(
      candidate,
      stopSequences
    );

    const inputTokens = json?.usageMetadata?.promptTokenCount;
    const outputTokens = json?.usageMetadata?.candidatesTokenCount;

    res.json({
      id,
      type: "message",
      role: "assistant",
      model: body.model || normalizedModel,
      content: content.length ? content : [{ type: "text", text: "" }],
      stop_reason: stopReason,
      stop_sequence: stopSequence,
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
