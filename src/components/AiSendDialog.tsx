import { useMemo, useState } from "react";
import { buildInput, PAYLOAD_FIELDS, toPayload, type MaskOptions } from "../ai/prompt";
import type { JudgeProvider } from "../ai/provider";
import type { Model } from "../lib/api";
import type { Row } from "../lib/rows";
import { Modal } from "./Modal";

interface Props {
  rows: Row[];
  provider: JudgeProvider;
  model: Model | undefined;
  home: string;
  user: string;
  onCancel: () => void;
  onSend: (mask: boolean) => void;
}

/** Shows exactly what will leave the Mac before anything is sent. */
export function AiSendDialog({ rows, provider, model, home, user, onCancel, onSend }: Props) {
  const [mask, setMask] = useState(true);
  const opts: MaskOptions = { enabled: mask, home, user };
  const preview = useMemo(() => buildInput(rows.map((r, i) => toPayload(`i${i}`, r, opts))), [rows, mask, home, user]);
  const pretty = useMemo(() => JSON.stringify(JSON.parse(preview), null, 2), [preview]);
  return (
    <Modal title={`この情報を ${provider.destination} に送ります`} wide onClose={onCancel}>
      <p>
        {rows.length} 件のメタデータを {provider.label} で判定します。<strong>ファイルの中身は送りません。</strong>
        {model && <> モデル: <strong>{model.displayName}</strong></>}
      </p>
      <p className="muted small">送る項目: {PAYLOAD_FIELDS.map((f) => f.ja).join("・")}</p>
      <label className="row">
        <input type="checkbox" checked={mask} onChange={(e) => setMask(e.target.checked)} />
        ホームフォルダとユーザー名を隠す（{home} → ~、ユーザー名 → &lt;user&gt;）
      </label>
      <details>
        <summary>実際に送る内容を見る（{preview.length.toLocaleString()} 文字）</summary>
        <pre className="preview">{pretty}</pre>
      </details>
      <p className="muted small">
        AI の判定は参考です。元 CLI の保護ルールとこのアプリのハードブロック（システム領域・鍵・.git・キーチェーンなど）が常に優先されます。
      </p>
      <div className="row end">
        <button onClick={onCancel}>やめる</button>
        <button className="primary" onClick={() => onSend(mask)} disabled={!model}>
          送信して判定する
        </button>
      </div>
    </Modal>
  );
}
