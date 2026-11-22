import { useState } from "react";
import { AI_VERDICT_JA } from "../lib/labels";
import { formatBytes } from "../lib/format";
import type { Row } from "../lib/rows";
import { Modal } from "./Modal";

/** Final confirmation. Items go to the Trash (restorable with "Put Back"); nothing is deleted for good. */
export function TrashDialog({ rows, onCancel, onConfirm }: { rows: Row[]; onCancel: () => void; onConfirm: () => void }) {
  const [checked, setChecked] = useState(false);
  const total = rows.reduce((s, r) => s + r.size, 0);
  const caution = rows.filter((r) => r.final.verdict !== "safe");
  return (
    <Modal title="ゴミ箱へ移動しますか？" wide onClose={onCancel}>
      <p>
        {rows.length} 件・合計 約 {formatBytes(total)} をゴミ箱へ移動します。完全には削除しません。Finder のゴミ箱から「戻す」で元に戻せます。
      </p>
      {caution.length > 0 && <p className="warn">「{AI_VERDICT_JA.caution}」の項目が {caution.length} 件含まれています。内容をよく確認してください。</p>}
      <ul className="confirm-list">
        {rows.map((r) => (
          <li key={r.path} className={r.final.verdict}>
            <span className={`badge ${r.final.verdict}`}>{AI_VERDICT_JA[r.final.verdict]}</span> {r.path} <span className="muted">（{formatBytes(r.size)}）</span>
          </li>
        ))}
      </ul>
      <label className="row">
        <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
        上のリストを確認しました
      </label>
      <div className="row end">
        <button onClick={onCancel}>やめる</button>
        <button className="danger" disabled={!checked} onClick={onConfirm}>
          ゴミ箱へ移動
        </button>
      </div>
    </Modal>
  );
}
