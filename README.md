# Gemini OpenRouter-like API (Node server)

Server này cung cấp API kiểu OpenAI/OpenRouter để bạn gọi chat completions, nhưng phía dưới dùng Gemini API (Google Generative Language API).

## Yêu cầu

- Node.js >= 18
- 1 Gemini API key (env: `GEMINI_API_KEY`)

## Model mẫu

Các model phổ biến bạn có thể thử:

- `google/gemini-2.5-flash` (mặc định)
- `google/gemini-2.5-pro`
- `google/gemini-2.5-flash-lite`
- `google/gemini-2.0-flash-001`

## Cài đặt

```bash
cd /Users/nguyenduythinh/Desktop/myapp/chat-bot
npm install
```

## Chạy server

```bash
GEMINI_API_KEY="YOUR_KEY" npm run dev
```

Biến môi trường hỗ trợ:

- `GEMINI_API_KEY` (bắt buộc): API key Gemini
- `PORT` (tuỳ chọn, mặc định `8787`): cổng server
- `GEMINI_DEFAULT_MODEL` (tuỳ chọn, mặc định `gemini-2.5-flash`): model mặc định khi request không truyền `model`

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

### List models (mẫu)

`GET /v1/models`

```bash
curl http://localhost:8787/v1/models
```

### Chat Completions (tương thích OpenAI/OpenRouter)

`POST /v1/chat/completions`

Headers:

- `content-type: application/json`

Body (các field hỗ trợ):

- `model` (string): có thể dùng `google/gemini-2.0-flash` hoặc `gemini-2.0-flash` hoặc `gemini-2.0-pro`...
- `messages` (array): `{ role: "system" | "user" | "assistant", content: string }`
- `temperature` (number, tuỳ chọn)
- `top_p` (number, tuỳ chọn)
- `max_tokens` (number, tuỳ chọn)
- `stream` (boolean, tuỳ chọn): `true` để stream theo SSE

#### Ví dụ non-stream

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{
    "model":"google/gemini-2.5-flash",
    "messages":[
      {"role":"system","content":"Bạn trả lời ngắn gọn."},
      {"role":"user","content":"Giải thích JWT là gì?"}
    ],
    "temperature":0.7
  }'
```

Response (dạng OpenAI):

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

#### Ví dụ stream (SSE)

```bash
curl -N http://localhost:8787/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{
    "model":"google/gemini-2.5-flash",
    "stream": true,
    "messages":[{"role":"user","content":"Viết 5 gạch đầu dòng về Node.js"}]
  }'
```

Output sẽ là các SSE event:

- `data: { ... "object":"chat.completion.chunk", "choices":[{"delta":{"role":"assistant"}}] }`
- `data: { ... "choices":[{"delta":{"content":"..."}}] }`
- `data: [DONE]`

## Tích hợp vào SDK OpenAI (ví dụ)

Nếu app của bạn hỗ trợ cấu hình “OpenAI-compatible base URL”, chỉ cần trỏ về server này.

Ví dụ với `openai` JS SDK (OpenAI-compatible):

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

Lưu ý: server ưu tiên lấy API key từ env `GEMINI_API_KEY` ở backend, và có thể nhận thêm từ `x-api-key` hoặc `Authorization: Bearer ...` header.

## API kiểu Anthropic (để test với Claude Code proxy)

Server có thêm endpoint tương thích Anthropic Messages API:

`POST /v1/messages`

Server ưu tiên API key theo thứ tự:

1) `GEMINI_API_KEY` (env, backend)
2) `x-api-key` header
3) `Authorization: Bearer <token>` header

### Ví dụ non-stream

```bash
curl http://localhost:8787/v1/messages \
  -H "content-type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model":"google/gemini-2.5-flash",
    "max_tokens":256,
    "system":"Bạn trả lời ngắn gọn.",
    "messages":[
      {"role":"user","content":"Tóm tắt HTTP trong 2 câu"}
    ]
  }'
```

Response (dạng Anthropic):

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

### Ví dụ stream (SSE theo event kiểu Anthropic)

```bash
curl -N http://localhost:8787/v1/messages \
  -H "content-type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model":"google/gemini-2.5-flash",
    "max_tokens":256,
    "stream": true,
    "messages":[{"role":"user","content":"Viết 5 gạch đầu dòng về Redis"}]
  }'
```

Output là SSE với các event như:

- `event: message_start`
- `event: content_block_start`
- `event: content_block_delta`
- `event: content_block_stop`
- `event: message_delta`
- `event: message_stop`

## Troubleshooting

- Nếu trả về lỗi `Missing GEMINI_API_KEY env var`: bạn chưa set `GEMINI_API_KEY` khi chạy server.
- Nếu bị `Upstream error (4xx/5xx)`: kiểm tra model name và quyền API key.
