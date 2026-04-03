# Gemini OpenRouter-like API (Node server)

This server provides an OpenAI/OpenRouter-style API for calling chat completions, while using the Gemini API underneath (Google Generative Language API).

## Requirements

- Node.js >= 18
- 1 Gemini API key (env: `GEMINI_API_KEY`)

## Example models

Common models you can try:

- `google/gemini-2.5-flash` (default)
- `google/gemini-2.5-pro`
- `google/gemini-2.5-flash-lite`
- `google/gemini-2.0-flash-001`

## Install

```bash
cd /Users/nguyenduythinh/Desktop/myapp/chat-bot
npm install
```

## Run the server

```bash
GEMINI_API_KEY="YOUR_KEY" npm run dev
```

Supported environment variables:

- `GEMINI_API_KEY` (required): Gemini API key
- `PORT` (optional, default `8787`): server port
- `GEMINI_DEFAULT_MODEL` (optional, default `gemini-2.5-flash`): default model when the request does not provide `model`

## Endpoints

### Health check

`GET /healthz`

```bash
curl http://localhost:8787/healthz
```

Response:

```json
{ "ok": true }
```

### List models (sample)

`GET /v1/models`

```bash
curl http://localhost:8787/v1/models
```

### Chat Completions (OpenAI/OpenRouter compatible)

`POST /v1/chat/completions`

Headers:

- `content-type: application/json`

Body (supported fields):

- `model` (string): can be `google/gemini-2.0-flash` or `gemini-2.0-flash` or `gemini-2.0-pro`...
- `messages` (array): `{ role: "system" | "user" | "assistant", content: string }`
- `temperature` (number, optional)
- `top_p` (number, optional)
- `max_tokens` (number, optional)
- `stream` (boolean, optional): `true` to stream via SSE

#### Non-stream example

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{
    "model":"google/gemini-2.5-flash",
    "messages":[
      {"role":"system","content":"Keep your answer short."},
      {"role":"user","content":"Explain what a JWT is."}
    ],
    "temperature":0.7
  }'
```

Response (OpenAI format):

```json
{
  "id": "chatcmpl_...",
  "object": "chat.completion",
  "created": 1710000000,
  "model": "gemini-2.0-flash",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "..." },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 0,
    "completion_tokens": 0,
    "total_tokens": 0
  }
}
```

#### Stream example (SSE)

```bash
curl -N http://localhost:8787/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{
    "model":"google/gemini-2.5-flash",
    "stream": true,
    "messages":[{"role":"user","content":"Write 5 bullet points about Node.js"}]
  }'
```

The output will be SSE events:

- `data: { ... "object":"chat.completion.chunk", "choices":[{"delta":{"role":"assistant"}}] }`
- `data: { ... "choices":[{"delta":{"content":"..."}}] }`
- `data: [DONE]`

## Integrate with the OpenAI SDK (example)

If your app supports configuring an “OpenAI-compatible base URL”, just point it to this server.

Example using the `openai` JS SDK (OpenAI-compatible):

```js
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:8787/v1",
  apiKey: "unused"
});

const result = await client.chat.completions.create({
  model: "google/gemini-2.5-flash",
  messages: [{ role: "user", content: "Hello" }]
});

console.log(result.choices[0].message.content);
```

Note: the server prefers the API key from env `GEMINI_API_KEY` on the backend, and can also accept `x-api-key` or `Authorization: Bearer ...` headers.

## Anthropic-style API (for testing with Claude Code proxy)

The server also provides an Anthropic Messages API-compatible endpoint:

`POST /v1/messages`

The server picks the API key in this order:

1) `GEMINI_API_KEY` (env, backend)
2) `x-api-key` header
3) `Authorization: Bearer <token>` header

### Non-stream example

```bash
curl http://localhost:8787/v1/messages \
  -H "content-type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model":"google/gemini-2.5-flash",
    "max_tokens":256,
    "system":"Keep your answer short.",
    "messages":[
      {"role":"user","content":"Summarize HTTP in 2 sentences"}
    ]
  }'
```

Response (Anthropic format):

```json
{
  "id": "msg_...",
  "type": "message",
  "role": "assistant",
  "model": "google/gemini-2.0-flash",
  "content": [{ "type": "text", "text": "..." }],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": { "input_tokens": 0, "output_tokens": 0 }
}
```

### Stream example (Anthropic-style SSE events)

```bash
curl -N http://localhost:8787/v1/messages \
  -H "content-type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model":"google/gemini-2.5-flash",
    "max_tokens":256,
    "stream": true,
    "messages":[{"role":"user","content":"Write 5 bullet points about Redis"}]
  }'
```

Output is SSE with events such as:

- `event: message_start`
- `event: content_block_start`
- `event: content_block_delta`
- `event: content_block_stop`
- `event: message_delta`
- `event: message_stop`

## Troubleshooting

- If you get `Missing GEMINI_API_KEY env var`: you didn’t set `GEMINI_API_KEY` when starting the server.
- If you get `Upstream error (4xx/5xx)`: check the model name and API key permissions.

