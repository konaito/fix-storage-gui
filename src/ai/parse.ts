import type { AiJudgement, AiVerdict } from "./provider";

const VERDICTS: AiVerdict[] = ["safe", "caution", "keep"];

/**
 * Parses the model's JSON reply. Tolerates code fences and stray text around the object.
 * Unknown ids and malformed entries are dropped; invalid verdicts are dropped (never guessed).
 */
export function parseJudgements(text: string, allowedIds: Set<string>): AiJudgement[] {
  let s = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("AI の応答に JSON が見つかりませんでした");
  s = s.slice(start, end + 1);
  let data: unknown;
  try {
    data = JSON.parse(s);
  } catch {
    throw new Error("AI の応答を JSON として読めませんでした");
  }
  const items = (data as { items?: unknown }).items;
  if (!Array.isArray(items)) throw new Error("AI の応答に items がありません");
  const seen = new Set<string>();
  const out: AiJudgement[] = [];
  for (const raw of items) {
    if (typeof raw !== "object" || raw === null) continue;
    const { id, verdict, reason } = raw as Record<string, unknown>;
    if (typeof id !== "string" || !allowedIds.has(id) || seen.has(id)) continue;
    if (typeof verdict !== "string" || !VERDICTS.includes(verdict as AiVerdict)) continue;
    seen.add(id);
    out.push({ id, verdict: verdict as AiVerdict, reason: typeof reason === "string" ? reason.slice(0, 200) : "" });
  }
  return out;
}
