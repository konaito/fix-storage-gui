import type { CategoryId } from "../cli-core/categories";
import { extname } from "../cli-core/shim";
import type { Label } from "../cli-core/classify";
import { isoDate } from "../lib/format";
import type { AiItemPayload } from "./provider";

export interface MaskOptions {
  enabled: boolean;
  home: string;
  user: string;
}

/** Replaces the home folder with "~" and any other occurrence of the account name with "<user>". */
export function maskText(text: string, m: MaskOptions): string {
  if (!m.enabled) return text;
  let out = text;
  const home = m.home.replace(/\/+$/, "");
  if (home && (out === home || out.startsWith(home + "/"))) out = "~" + out.slice(home.length);
  if (m.user.length >= 2) out = out.split(m.user).join("<user>");
  return out;
}

export interface PayloadSource {
  path: string;
  name: string;
  size: number;
  dir: boolean;
  category: CategoryId;
  modifiedMs: number | null;
  lastUsedMs: number | null;
  cli: Label;
}

export function toPayload(id: string, item: PayloadSource, mask: MaskOptions): AiItemPayload {
  return {
    id,
    path: maskText(item.path, mask),
    name: maskText(item.name, mask),
    ext: item.dir ? "" : extname(item.name.toLowerCase()),
    kind: item.dir ? "folder" : "file",
    size_bytes: Math.round(item.size),
    last_used: isoDate(item.lastUsedMs),
    modified: isoDate(item.modifiedMs),
    category: item.category,
    rule_verdict: item.cli.verdict,
    rule_reason: maskText(item.cli.reason, mask),
  };
}

export const PAYLOAD_FIELDS: Array<{ key: keyof AiItemPayload; ja: string }> = [
  { key: "path", ja: "パス" },
  { key: "name", ja: "名前" },
  { key: "ext", ja: "拡張子" },
  { key: "kind", ja: "ファイル/フォルダ" },
  { key: "size_bytes", ja: "サイズ" },
  { key: "last_used", ja: "最終使用日（Spotlight）" },
  { key: "modified", ja: "更新日" },
  { key: "category", ja: "元CLIのカテゴリ" },
  { key: "rule_verdict", ja: "元CLIの判定" },
  { key: "rule_reason", ja: "元CLIの判定理由" },
];

export const INSTRUCTIONS = `あなたは macOS のストレージ整理を手伝うアシスタントです。
ファイルの中身は見られません。与えられるのは、パス・名前・拡張子・サイズ・日付・ルールベースの分類といったメタデータだけです。
各項目について、ゴミ箱に移してよいかを判定してください。

verdict は次のどれか:
- "safe": キャッシュ、node_modules、ビルドキャッシュ、インストーラー、ゴミ箱の中身など、再生成できるか不要だと強く推定できる
- "caution": 持ち主の判断が必要、または判断材料が足りない
- "keep": 消すと困る可能性が高い（OS やアプリの動作に必要、個人の写真・書類、認証情報や鍵、作業中のプロジェクトなど）
迷ったら "caution" か "keep" を選んでください。名前だけで中身を推測しすぎないでください。
"safe" を付けてよいのは rule_verdict が "junk" の項目だけです。"junk" でも、上の条件に当てはまらなければ "caution" か "keep" にしてください。
rule_verdict が "unused" の項目（ビルド成果物、python 環境、シミュレータのデバイス、ダウンロードしたアーカイブ、1年以上開いていないファイルなど）は、"caution" と "keep" のどちらかを判断してください。

reason は日本語で 60 文字以内。何のファイルか、消すとどうなるか、再生成の方法があればそれを書いてください。

出力は次の JSON だけにしてください。説明文やコードブロックは付けないでください。
{"items":[{"id":"<入力の id>","verdict":"safe|caution|keep","reason":"..."}]}`;

export function buildInput(items: AiItemPayload[]): string {
  return JSON.stringify({ items });
}

export function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
