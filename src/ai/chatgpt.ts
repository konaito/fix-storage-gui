import { listen } from "@tauri-apps/api/event";
import { api } from "../lib/api";
import { parseJudgements } from "./parse";
import { buildInput, INSTRUCTIONS } from "./prompt";
import type { AiItemPayload, AiJudgement, JudgeOptions, JudgeProvider } from "./provider";

let counter = 0;

/** Sends metadata to the Responses API using the user's ChatGPT plan (tokens stay in Rust). */
export const chatGptProvider: JudgeProvider = {
  id: "chatgpt-plan",
  label: "ChatGPT プラン（Sign in with ChatGPT）",
  destination: "OpenAI（Responses API）",
  sendsOffDevice: true,
  async judge(items: AiItemPayload[], options: JudgeOptions): Promise<AiJudgement[]> {
    const requestId = `req-${Date.now()}-${counter++}`;
    const unlisten = await listen<{ requestId: string; chars: number }>("ai-progress", (e) => {
      if (e.payload.requestId === requestId) options.onProgress?.(e.payload.chars);
    });
    try {
      const text = await api.siwcRespond(requestId, options.model, INSTRUCTIONS, buildInput(items));
      return parseJudgements(text, new Set(items.map((i) => i.id)));
    } finally {
      unlisten();
    }
  },
};
