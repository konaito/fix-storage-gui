import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { chatGptProvider } from "./ai/chatgpt";
import { chunk, toPayload } from "./ai/prompt";
import type { AiJudgement, JudgeProvider } from "./ai/provider";
import { AccountPanel } from "./components/AccountPanel";
import { AiSendDialog } from "./components/AiSendDialog";
import { Modal } from "./components/Modal";
import { TrashDialog } from "./components/TrashDialog";
import { api, isSiwcError, type EnvInfo, type Model, type ScanProgress, type SiwcStatus, type TrashOutcome } from "./lib/api";
import { describeError } from "./lib/errors";
import { agoJa, formatBytes, isoDate } from "./lib/format";
import { AI_VERDICT_JA, CATEGORY_JA, CLI_VERDICT_JA } from "./lib/labels";
import { toRow, withAi, type Row } from "./lib/rows";
import { selectable } from "./safety/merge";

const PROVIDER: JudgeProvider = chatGptProvider;
const BATCH = 25;
const MIN_SIZES = [
  { label: "10 MB 以上", bytes: 10e6 },
  { label: "100 MB 以上", bytes: 100e6 },
  { label: "500 MB 以上", bytes: 500e6 },
  { label: "1 GB 以上", bytes: 1e9 },
];

type Target = { kind: "mac" } | { kind: "folder"; path: string };

export default function App() {
  const [env, setEnv] = useState<EnvInfo | null>(null);
  const [status, setStatus] = useState<SiwcStatus | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [model, setModel] = useState("");
  const [signingIn, setSigningIn] = useState(false);

  const [target, setTarget] = useState<Target>({ kind: "mac" });
  const [minSize, setMinSize] = useState(MIN_SIZES[1].bytes);
  const [history, setHistory] = useState<Target[]>([]);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [denied, setDenied] = useState<string[]>([]);
  const [disk, setDisk] = useState<{ total: number; available: number } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [aiDialog, setAiDialog] = useState(false);
  const [aiRunning, setAiRunning] = useState<{ done: number; total: number; chars: number } | null>(null);
  const [trashDialog, setTrashDialog] = useState(false);
  const [trashResult, setTrashResult] = useState<TrashOutcome[] | null>(null);
  const [usageLimit, setUsageLimit] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await api.siwcStatus());
    } catch (e) {
      setError(describeError(e));
    }
  }, []);

  const active = status?.accounts.find((a) => a.clientId === status.active);
  const planReady = !!active?.signedIn && !!active.planEnabled;

  const loadModels = useCallback(async () => {
    try {
      const list = await api.siwcModels();
      setModels(list);
      setModel((cur) => (list.some((m) => m.slug === cur) ? cur : (list[0]?.slug ?? "")));
    } catch (e) {
      setModels([]);
      handleAiError(e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    api.envInfo().then(setEnv).catch((e) => setError(describeError(e)));
    void refreshStatus();
    const un = listen<ScanProgress>("scan-progress", (e) => setProgress(e.payload));
    return () => {
      void un.then((f) => f());
    };
  }, [refreshStatus]);

  // Refresh the model list whenever the active account changes.
  useEffect(() => {
    if (planReady) void loadModels();
    else setModels([]);
  }, [planReady, status?.active, loadModels]);

  function handleAiError(e: unknown) {
    if (isSiwcError(e)) {
      if (e.kind === "usage_limit") setUsageLimit(true);
      if (e.kind === "reauth_required" || e.kind === "plan_not_enabled") void refreshStatus();
    }
    setError(describeError(e));
  }

  async function signIn(clientId: string | null, promptConsent: boolean) {
    setError(null);
    setSigningIn(true);
    try {
      const acc = await api.siwcSignIn(clientId, promptConsent);
      if (!acc.planEnabled) setNotice("サインインしました。ただし ChatGPT プランの利用は許可されていません。");
    } catch (e) {
      handleAiError(e);
    } finally {
      setSigningIn(false);
      await refreshStatus();
    }
  }

  async function signOut() {
    try {
      const r = await api.siwcSignOut();
      setNotice(
        r.remoteRevoked
          ? "サインアウトしました。"
          : "このMacのトークンは消しましたが、ChatGPT 側での接続解除を確認できませんでした。必要なら ChatGPT の設定からこのアプリの接続を解除してください。",
      );
    } catch (e) {
      setError(describeError(e));
    }
    await refreshStatus();
  }

  async function runScan(t: Target, pushHistory: boolean) {
    setError(null);
    setScanning(true);
    setProgress(null);
    setSelected(new Set());
    if (pushHistory) setHistory((h) => [...h, target]);
    setTarget(t);
    try {
      const res = await api.scan(t.kind === "folder" ? t.path : null, minSize);
      setRows(res.items.map((i) => toRow(i)));
      setDenied(res.denied);
      setDisk(res.disk);
      if (res.cancelled) setNotice("スキャンを中止しました（途中までの結果を表示しています）。");
    } catch (e) {
      setError(describeError(e));
    } finally {
      setScanning(false);
      setProgress(null);
    }
  }

  async function pickFolder() {
    const path = await openDialog({ directory: true, multiple: false, defaultPath: env?.home });
    if (typeof path === "string") setTarget({ kind: "folder", path });
  }

  function back() {
    const prev = history[history.length - 1];
    if (!prev) return;
    setHistory((h) => h.slice(0, -1));
    void runScan(prev, false);
  }

  // AI review targets: everything not locked by the hard block list or fix-storage's rules.
  const aiTargets = useMemo(() => rows.filter((r) => !r.final.locked), [rows]);

  async function sendToAi(mask: boolean) {
    setAiDialog(false);
    if (!env || !model) return;
    const maskOpts = { enabled: mask, home: env.home, user: env.user };
    const indexed = aiTargets.map((r, i) => ({ id: `i${i}`, row: r }));
    const batches = chunk(indexed, BATCH);
    setAiRunning({ done: 0, total: indexed.length, chars: 0 });
    setError(null);
    const results = new Map<string, AiJudgement>();
    let missing = 0;
    try {
      for (const batch of batches) {
        const payload = batch.map(({ id, row }) => toPayload(id, row, maskOpts));
        const judged = await PROVIDER.judge(payload, {
          model,
          onProgress: (chars) => setAiRunning((s) => (s ? { ...s, chars } : s)),
        });
        const byId = new Map(judged.map((j) => [j.id, j]));
        for (const { id, row } of batch) {
          const j = byId.get(id);
          if (j) results.set(row.path, j);
          else missing++;
        }
        setRows((cur) => cur.map((r) => (results.has(r.path) ? withAi(r, results.get(r.path)) : r)));
        setAiRunning((s) => (s ? { ...s, done: s.done + batch.length, chars: 0 } : s));
      }
      if (missing > 0) setNotice(`${missing} 件は AI の応答に含まれていなかったため、元 CLI の判定のままです。`);
    } catch (e) {
      handleAiError(e);
    } finally {
      setAiRunning(null);
    }
  }

  // Drop selections that new verdicts (or a rescan) no longer allow.
  useEffect(() => {
    setSelected((sel) => {
      const ok = new Set(rows.filter((r) => selectable(r.final)).map((r) => r.path));
      const next = new Set([...sel].filter((p) => ok.has(p)));
      return next.size === sel.size ? sel : next;
    });
  }, [rows]);

  const chosen = rows.filter((r) => selected.has(r.path) && selectable(r.final));
  const chosenSize = chosen.reduce((s, r) => s + r.size, 0);

  async function doTrash() {
    setTrashDialog(false);
    try {
      const out = await api.moveToTrash(chosen.map((r) => r.path));
      setTrashResult(out);
      const moved = new Set(out.filter((o) => o.ok).map((o) => o.path));
      setRows((cur) => cur.filter((r) => !moved.has(r.path)));
      setSelected(new Set());
    } catch (e) {
      setError(describeError(e));
    }
  }

  function toggle(path: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(path)) n.delete(path);
      else n.add(path);
      return n;
    });
  }

  function selectAllSafe() {
    setSelected(new Set(rows.filter((r) => selectable(r.final) && r.final.verdict === "safe").map((r) => r.path)));
  }

  return (
    <div className="app">
      <header>
        <div>
          <h1>Fix Storage GUI</h1>
          <div className="muted small">
            fix-storage のコアを使ったストレージ整理 {env && `v${env.version}`}
            {disk && ` ・ 空き ${formatBytes(disk.available)} / ${formatBytes(disk.total)}`}
          </div>
        </div>
      </header>

      {error && (
        <div className="error" role="alert">
          {error} <button className="link" onClick={() => setError(null)}>閉じる</button>
        </div>
      )}
      {notice && (
        <div className="notice">
          {notice} <button className="link" onClick={() => setNotice(null)}>閉じる</button>
        </div>
      )}

      <section className="grid2">
        <div className="card">
          <h3>1. スキャン対象</h3>
          <label className="row">
            <input type="radio" checked={target.kind === "mac"} onChange={() => setTarget({ kind: "mac" })} disabled={scanning} />
            Mac 全体（元 CLI と同じフォルダ群）
          </label>
          <label className="row">
            <input type="radio" checked={target.kind === "folder"} onChange={() => void pickFolder()} disabled={scanning} />
            フォルダを選ぶ {target.kind === "folder" && <code>{target.path}</code>}
            <button onClick={() => void pickFolder()} disabled={scanning}>
              選択…
            </button>
          </label>
          <div className="row">
            <select value={minSize} onChange={(e) => setMinSize(Number(e.target.value))} disabled={scanning}>
              {MIN_SIZES.map((m) => (
                <option key={m.bytes} value={m.bytes}>
                  {m.label}
                </option>
              ))}
            </select>
            {scanning ? (
              <button onClick={() => void api.cancelScan()}>中止</button>
            ) : (
              <button className="primary" onClick={() => void runScan(target, false)}>
                スキャン開始
              </button>
            )}
          </div>
          {scanning && (
            <p className="muted small">
              計測中… {progress ? `${progress.done}/${progress.total} ${progress.current}` : "フォルダを一覧しています"}
            </p>
          )}
          <p className="muted small">スキャンと計測はすべてこの Mac の中で行います。</p>
        </div>

        <AccountPanel
          status={status}
          models={models}
          model={model}
          onModel={setModel}
          signingIn={signingIn}
          onSignIn={(id, consent) => void signIn(id, consent)}
          onCancelSignIn={() => void api.siwcCancelSignIn()}
          onSwitch={(id) => void api.siwcSwitch(id).then(refreshStatus)}
          onSignOut={() => void signOut()}
          onManageUsage={() => void api.openUsage()}
          onReloadModels={() => void loadModels()}
        />
      </section>

      {denied.length > 0 && (
        <details className="card warn-box">
          <summary>読めなかったフォルダが {denied.length} 件あります（システム設定 → プライバシーとセキュリティ → フルディスクアクセス で許可すると計測できます）</summary>
          <ul className="small">
            {denied.slice(0, 50).map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        </details>
      )}

      <section className="card">
        <div className="row space">
          <h3>2. 重いファイル/フォルダ {rows.length > 0 && <span className="muted small">（{rows.length} 件）</span>}</h3>
          <div className="row">
            {history.length > 0 && <button onClick={back} disabled={scanning}>← 戻る</button>}
            <button onClick={selectAllSafe} disabled={rows.length === 0}>
              「削除していい」をすべて選択
            </button>
            <button
              className="primary"
              disabled={!planReady || aiTargets.length === 0 || !!aiRunning || !model}
              title={planReady ? "" : "ChatGPT にサインインすると使えます"}
              onClick={() => setAiDialog(true)}
            >
              3. AI で判定（{aiTargets.length} 件）
            </button>
          </div>
        </div>
        {aiRunning && (
          <p className="muted small">
            AI 判定中… {aiRunning.done}/{aiRunning.total} 件 {aiRunning.chars > 0 && `（受信 ${aiRunning.chars} 文字）`}
          </p>
        )}
        {rows.length === 0 ? (
          <p className="muted">{scanning ? "計測しています…" : "スキャンするとここに大きい順で表示されます。"}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th></th>
                <th>名前</th>
                <th className="num">サイズ</th>
                <th>最終使用</th>
                <th>更新日</th>
                <th>カテゴリ</th>
                <th>元 CLI の判定</th>
                <th>判定（AI＋ルール）</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const can = selectable(r.final);
                return (
                  <tr key={r.path} className={r.final.locked ? "locked" : ""}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`${r.name} を選択`}
                        checked={selected.has(r.path) && can}
                        disabled={!can}
                        onChange={() => toggle(r.path)}
                      />
                    </td>
                    <td className="name">
                      <div>
                        {r.dir ? "📁 " : "📄 "}
                        {r.name}
                      </div>
                      <div className="muted tiny">{r.path}</div>
                    </td>
                    <td className="num">{formatBytes(r.size)}</td>
                    <td title={isoDate(r.lastUsedMs) ?? "Spotlight に記録なし"}>{agoJa(r.lastUsedMs)}</td>
                    <td title={isoDate(r.modifiedMs) ?? ""}>{agoJa(r.modifiedMs)}</td>
                    <td>{CATEGORY_JA[r.category]}</td>
                    <td className="small">
                      <div>{CLI_VERDICT_JA[r.cli.verdict]}</div>
                      {r.cli.reason && <div className="muted tiny">{r.cli.reason}</div>}
                    </td>
                    <td className="small">
                      <span className={`badge ${r.final.verdict}`}>{AI_VERDICT_JA[r.final.verdict]}</span>
                      <span className="muted tiny">
                        {" "}
                        {r.final.source === "hard-block" ? "保護リスト" : r.final.source === "cli" ? (r.final.locked ? "元CLI" : "元CLIのみ") : "AI"}
                      </span>
                      {r.final.reason && <div className="tiny">{r.final.reason}</div>}
                    </td>
                    <td className="actions">
                      <button className="link" onClick={() => void api.revealInFinder(r.path)}>
                        Finder
                      </button>
                      {r.dir && (
                        <button className="link" disabled={scanning} onClick={() => void runScan({ kind: "folder", path: r.path }, true)}>
                          中を見る
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <footer className="bar">
        <span>
          選択中 {chosen.length} 件・約 {formatBytes(chosenSize)}
        </span>
        <button className="danger" disabled={chosen.length === 0} onClick={() => setTrashDialog(true)}>
          4. ゴミ箱へ移動…
        </button>
      </footer>

      {aiDialog && env && (
        <AiSendDialog
          rows={aiTargets}
          provider={PROVIDER}
          model={models.find((m) => m.slug === model)}
          home={env.home}
          user={env.user}
          onCancel={() => setAiDialog(false)}
          onSend={(mask) => void sendToAi(mask)}
        />
      )}
      {trashDialog && <TrashDialog rows={chosen} onCancel={() => setTrashDialog(false)} onConfirm={() => void doTrash()} />}
      {trashResult && (
        <Modal title="結果" onClose={() => setTrashResult(null)}>
          <p>
            {trashResult.filter((o) => o.ok).length} 件をゴミ箱へ移動しました。
            {trashResult.some((o) => !o.ok) && ` ${trashResult.filter((o) => !o.ok).length} 件は移動できませんでした。`}
          </p>
          <ul className="small">
            {trashResult
              .filter((o) => !o.ok)
              .map((o) => (
                <li key={o.path}>
                  {o.path}: {o.error}
                </li>
              ))}
          </ul>
          <div className="row end">
            <button className="primary" onClick={() => setTrashResult(null)}>
              OK
            </button>
          </div>
        </Modal>
      )}
      {status?.showWelcome && (
        <Modal title="ChatGPT プランを使用しています">
          <p>このアプリの AI 判定は、あなたの ChatGPT プランの使用量を使います。使用量は ChatGPT の設定で管理できます。</p>
          <div className="row end">
            <button className="link" onClick={() => void api.openUsage()}>
              使用量を管理
            </button>
            <button className="primary" onClick={() => void api.siwcAckWelcome().then(refreshStatus)}>
              OK
            </button>
          </div>
        </Modal>
      )}
      {usageLimit && (
        <Modal title="使用量の上限に達しました" onClose={() => setUsageLimit(false)}>
          <p>ChatGPT の設定で、プランかこのアプリの上限を確認してください。</p>
          <div className="row end">
            <button onClick={() => setUsageLimit(false)}>閉じる</button>
            <button
              className="primary"
              onClick={() => {
                void api.openUsage();
                setUsageLimit(false);
              }}
            >
              使用量を管理
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
