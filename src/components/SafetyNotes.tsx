/** "安全のしくみ" as a closed-by-default disclosure on step 1 (#13 proposal); it used to be a sidebar card. */
export function SafetyNotes() {
  return (
    <details className="safety-notes">
      <summary>安全のしくみ</summary>
      <ul>
        <li>
          <strong>ゴミ箱へ移すだけ。</strong>完全には削除しません。
        </li>
        <li>
          <strong>保護リストが最優先。</strong>システム領域・鍵・.git・キーチェーンなどは選べません。
        </li>
        <li>
          <strong>AI に送るのはメタデータだけ。</strong>送る前に内容をすべて確認できます。
        </li>
        <li>
          <strong>移動の直前にもう一度チェック。</strong>
        </li>
      </ul>
    </details>
  );
}
