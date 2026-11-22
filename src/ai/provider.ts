/**
 * AI review providers are pluggable. Today there is one (ChatGPT plan via Sign in with ChatGPT);
 * a local model (MLX / llama.cpp) can be added later by implementing JudgeProvider.
 */

export type AiVerdict = "safe" | "caution" | "keep";

/** Exactly what is sent to a provider for one item: metadata only, never file contents. */
export interface AiItemPayload {
  id: string;
  path: string;
  name: string;
  ext: string;
  kind: "file" | "folder";
  size_bytes: number;
  last_used: string | null;
  modified: string | null;
  category: string;
  rule_verdict: string;
  rule_reason: string;
}

export interface AiJudgement {
  id: string;
  verdict: AiVerdict;
  reason: string;
}

export interface JudgeOptions {
  model: string;
  /** Account the run started with; every request of the run uses it (#28). */
  clientId: string;
  /** Called with the number of characters received so far. */
  onProgress?: (chars: number) => void;
}

export interface JudgeProvider {
  readonly id: string;
  readonly label: string;
  /** Shown in the consent dialog: who receives the metadata. */
  readonly destination: string;
  /** True when the data leaves this Mac. A future local provider returns false. */
  readonly sendsOffDevice: boolean;
  judge(items: AiItemPayload[], options: JudgeOptions): Promise<AiJudgement[]>;
}
