# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## High-Level Architecture

This repository contains a Node.js/Express.js application that acts as a proxy for the Google Gemini API. It exposes two main API endpoints that mimic the OpenAI chat completions API and the Anthropic Messages API, translating requests to the appropriate Gemini API format.

- **Endpoints:**
  - `/v1/chat/completions`: Tương thích với OpenAI Chat Completions API, proxy các yêu cầu tới Gemini API.
  - `/v1/messages`: Tương thích với Anthropic Messages API, proxy các yêu cầu tới Gemini API.
  - `/v1/models`: Liệt kê các mô hình Gemini có sẵn.
  - `/healthz`: Endpoint kiểm tra tình trạng của ứng dụng.

- **API Key Handling:** Gemini API key được lấy từ biến môi trường `GEMINI_API_KEY`, header `x-api-key`, hoặc `Authorization` bearer token.

- **Streaming Support:** Ứng dụng hỗ trợ cả yêu cầu streaming và non-streaming.

## Common Development Tasks

- **Start Development Server:**
  ```bash
  npm run dev
  ```

- **Start Production Server:**
  ```bash
  npm start
  ```