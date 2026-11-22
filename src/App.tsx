import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { AppIcon } from "./components/AppIcon";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { chatGptProvider } from "./ai/chatgpt";
import { chunk, toPayload } from "./ai/prompt";
import type { AiJudgement, JudgeProvider } from "./ai/provider";
import { DEFAULT_CONCURRENCY, runBatches } from "./ai/runBatches";
import { AccountPanel } from "./components/AccountPanel";
import { ActionBarSlot } from "./components/ActionBar";
import { AiSendDialog } from "./components/AiSendDialog";
import { Modal } from "./components/Modal";
import { Stepper } from "./components/Stepper";
import { AiStep, type AiOutcome, type AiRun } from "./components/steps/AiStep";
import { useGate } from "./components/GateContext";
import { DoneStep } from "./components/steps/DoneStep";
import { ReviewStep, type ReviewView } from "./components/steps/ReviewStep";
import { ScanningStep } from "./components/steps/ScanningStep";
import { MIN_SIZES, TargetStep, type Target } from "./components/steps/TargetStep";
import { TrashStep } from "./components/steps/TrashStep";
import { safePaths, summarize } from "./flow/progress";
import { effectiveSort, type SortMode } from "./flow/order";
import { canGo, flowReducer, initialFlow, type StepId } from "./flow/steps";
import { api, isSiwcError, type EnvInfo, type Model, type ScanProgress, type SiwcStatus, type TrashOutcome, type TrashProgress } from "./lib/api";
import { describeError } from "./lib/errors";
import { formatBytes } from "./lib/format";
import { forDisplay, toRow, withAi, type Row } from "./lib/rows";
import { selectable } from "./safety/merge";
import { UpdateCheckButton } from "./components/UpdateBanner";
import { getUpdateState, setUpdateBlocked, updateBlocksWork, useUpdateState } from "./lib/updater";

const PROVIDER: JudgeProvider = chatGptProvider;
const BATCH = 25;

export default function App() {
  const [env, setEnv] = useState<EnvInfo | null>(null);
  const [status, setStatus] = useState<SiwcStatus | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [model, setModel] = useState("");
  const [signingIn, setSigningIn] = useState(false);

  const [flow, dispatch] = useReducer(flowReducer, initialFlow);
  const [barSlot, setBarSlot] = useState<HTMLDivElement | null>(null);
  // アプリ内アップデートは、スキャン・AI 判定・ゴミ箱移動の最中は始めない（src/lib/updater.ts）。
  useEffect(() => setUpdateBlocked(flow.busy === "scan" ? "スキャン中" : flow.busy === "ai" ? "AI 判定中" : flow.busy === "trash" ? "ゴミ箱へ移動中" : null), [flow.busy]);
  // 逆に、更新のダウンロードから再起動までの間は、スキャン・AI 判定・ゴミ箱移動を始めない（#22）。
  const updateBusy = updateBlocksWork(useUpdateState().phase);
  function blockedByUpdate(): boolean {
    if (!updateBlocksWork(getUpdateState().phase)) return false;
    setNotice("アップデートのダウンロードとインストールが終わるまで、スキャン・AI 判定・ゴミ箱への移動は始められません。");
    return true;
  }

  const [target, setTarget] = useState<Target>({ kind: "mac" });
  const [lastFolder, setLastFolder] = useState<string | null>(null);
  const [scanned, setScanned] = useState<Target>({ kind: "mac" });
  const [minSize, setMinSize] = useState(MIN_SIZES[1].bytes);
  const [history, setHistory] = useState<Target[]>([]);
  const [scanStartedAt, setScanStartedAt] = useState(0);
  const [cancelling, setCancelling] = useState(false);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [denied, setDenied] = useState<string[]>([]);
  const [partial, setPartial] = useState(false);
  const [disk, setDisk] = useState<{ total: number; available: number } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reviewView, setReviewView] = useState<ReviewView>("map");
  const [sortChoice, setSortChoice] = useState<SortMode | null>(null);
  // After the AI has judged the list, go back to the default order (recommended: safe first).
  useEffect(() => {
    if (flow.aiDone) setSortChoice(null);
  }, [flow.aiDone]);

  const [aiDialog, setAiDialog] = useState(false);
  const [aiRun, setAiRun] = useState<AiRun | null>(null);
  const [aiOutcome, setAiOutcome] = useState<AiOutcome | null>(null);
  const aiStop = useRef(false);
  // Signed-in users with plan usage: open the AI send dialog once after each scan (#12). Cancelling does not reopen it.
  const [autoAi, setAutoAi] = useState(false);

  const [trashProgress, setTrashProgress] = useState<TrashProgress | null>(null);
  const [trashOutcomes, setTrashOutcomes] = useState<TrashOutcome[]>([]);
  const [movedBytes, setMovedBytes] = useState(0);
  const [trashError, setTrashError] = useState<string | null>(null);

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
  const signedIn = !!active?.signedIn;
  // AI judgement needs both this app's view of the account and the login gate's plan-use consent.
  const gate = useGate();
  const planReady = gate.planEnabled && signedIn && !!active?.planEnabled;
  useEffect(() => {
    if (gate.statusVersion > 0) void refreshStatus();
  }, [gate.statusVersion, refreshStatus]);

  // What every step shows and acts on: with plan usage, rows the AI has not judged are "未判定" and can't be selected (#12).
  const view = useMemo(() => rows.map((r) => forDisplay(r, planReady)), [rows, planReady]);
  // AI review targets: everything not locked by the hard block list or fix-storage's rules.
  const aiTargets = useMemo(() => view.filter((r) => !r.final.locked), [view]);
  useEffect(() => {
    dispatch({ type: "mode", aiFirst: planReady, aiTargets: aiTargets.length });
    if (!planReady) setAutoAi(false);
    // Only a change of mode matters here; aiTargets is read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planReady]);

  const loadModels = useCallback(async () => {
    setModelsLoading(true);
    try {
      const list = await api.siwcModels();
      setModels(list);
      setModel((cur) => (list.some((m) => m.slug === cur) ? cur : (list[0]?.slug ?? "")));
    } catch (e) {
      setModels([]);
      handleAiError(e);
    } finally {
      setModelsLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    api.envInfo().then(setEnv).catch((e) => setError(describeError(e)));
    void refreshStatus();
    const un1 = listen<ScanProgress>("scan-progress", (e) => setProgress(e.payload));
    const un2 = listen<TrashProgress>("trash-progress", (e) => setTrashProgress(e.payload));
    return () => {
      void un1.then((f) => f());
      void un2.then((f) => f());
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
    if (flow.busy || blockedByUpdate()) return;
    setError(null);
    setNotice(null);
    setProgress(null);
    setCancelling(false);
    setScanStartedAt(Date.now());
    dispatch({ type: "scanStart" });
    try {
      const res = await api.scan(t.kind === "folder" ? t.path : null, minSize);
      if (pushHistory) setHistory((h) => [...h, scanned]);
      setScanned(t);
      setTarget(t);
      const next = res.items.map((i) => toRow(i));
      const sendable = next.filter((r) => !r.final.locked).length;
      setRows(next);
      setDenied(res.denied);
      setDisk(res.disk);
      setPartial(res.cancelled);
      setSelected(new Set());
      setSortChoice(null);
      setAiOutcome(null);
      setAutoAi(planReady && sendable > 0);
      dispatch({ type: "scanEnd", ok: true, aiTargets: sendable });
    } catch (e) {
      setError(describeError(e));
      setTarget(scanned);
      dispatch({ type: "scanEnd", ok: false });
    } finally {
      setProgress(null);
      setCancelling(false);
    }
  }

  async function pickFolder() {
    const path = await openDialog({ directory: true, multiple: false, defaultPath: lastFolder ?? env?.home });
    if (typeof path === "string") {
      setLastFolder(path);
      setTarget({ kind: "folder", path });
    }
  }

  function goUp() {
    const prev = history[history.length - 1];
    if (!prev) return;
    setHistory((h) => h.slice(0, -1));
    void runScan(prev, false);
  }

  async function sendToAi(mask: boolean) {
    setAiDialog(false);
    if (!env || !model || flow.busy || !planReady || blockedByUpdate()) return;
    const maskOpts = { enabled: mask, home: env.home, user: env.user };
    const indexed = aiTargets.map((r, i) => ({ id: `i${i}`, row: r }));
    const batches = chunk(indexed, BATCH);
    aiStop.current = false;
    setAiOutcome(null);
    setAiRun({
      done: 0,
      total: indexed.length,
      batchesInFlight: 0,
      batchesCompleted: 0,
      batches: batches.length,
      chars: 0,
      startedAt: Date.now(),
      stopRequested: false,
    });
    setError(null);
    dispatch({ type: "aiStart" });
    const results = new Map<string, AiJudgement>();
    let missing = 0;
    let stopped = false;
    let err: string | null = null;
    try {
      const outcome = await runBatches({
        batches,
        concurrency: DEFAULT_CONCURRENCY,
        itemCount: (batch) => batch.length,
        shouldStop: () => aiStop.current,
        send: (batch, _index, onChars) => {
          const payload = batch.map(({ id, row }) => toPayload(id, row, maskOpts));
          return PROVIDER.judge(payload, { model, onProgress: onChars });
        },
        onBatchComplete: (_index, judged, batch) => {
          const byId = new Map(judged.map((j) => [j.id, j]));
          for (const { id, row } of batch) {
            const j = byId.get(id);
            if (j) results.set(row.path, j);
            else missing++;
          }
          setRows((cur) => cur.map((r) => (results.has(r.path) ? withAi(r, results.get(r.path)) : r)));
        },
        onProgress: (p) => {
          setAiRun((s) =>
            s
              ? {
                  ...s,
                  done: p.doneItems,
                  batchesInFlight: p.batchesInFlight,
                  batchesCompleted: p.batchesCompleted,
                  batches: p.batchesTotal,
                  chars: p.streamedChars,
                }
              : s,
          );
        },
      });
      stopped = outcome.stopped;
      if (outcome.error) {
        handleAiError(outcome.error);
        err = describeError(outcome.error);
      }
    } catch (e) {
      handleAiError(e);
      err = describeError(e);
    } finally {
      setAiRun(null);
      setAiOutcome({ judged: results.size, missing, stopped, error: err });
      dispatch({ type: "aiEnd", ok: !err && results.size > 0 });
    }
  }

  // Open the send dialog by itself once the AI step is up and a model is ready.
  useEffect(() => {
    if (autoAi && flow.step === "ai" && !flow.busy && !updateBusy && planReady && !!model && !!env && aiTargets.length > 0) {
      setAutoAi(false);
      setAiDialog(true);
    }
  }, [autoAi, flow.step, flow.busy, updateBusy, planReady, model, env, aiTargets.length]);

  // Drop selections that new verdicts (or a rescan) no longer allow.
  useEffect(() => {
    setSelected((sel) => {
      const ok = new Set(view.filter((r) => selectable(r.final)).map((r) => r.path));
      const next = new Set([...sel].filter((p) => ok.has(p)));
      return next.size === sel.size ? sel : next;
    });
  }, [view]);

  const chosen = view.filter((r) => selected.has(r.path) && selectable(r.final));

  async function doTrash() {
    if (chosen.length === 0 || blockedByUpdate()) return;
    const sizeOf = new Map(chosen.map((r) => [r.path, r.size]));
    setTrashProgress(null);
    setTrashError(null);
    dispatch({ type: "trashStart" });
    try {
      const out = await api.moveToTrash(chosen.map((r) => r.path));
      setTrashOutcomes(out);
      const moved = new Set(out.filter((o) => o.ok).map((o) => o.path));
      setMovedBytes([...moved].reduce((s, p) => s + (sizeOf.get(p) ?? 0), 0));
      setRows((cur) => cur.filter((r) => !moved.has(r.path)));
      setSelected(new Set());
    } catch (e) {
      setTrashOutcomes([]);
      setMovedBytes(0);
      setTrashError(describeError(e));
    } finally {
      setTrashProgress(null);
      dispatch({ type: "trashEnd" });
    }
  }

  /** Only selectable rows can ever be selected (hard block / "keep" stay out). */
  function selectPaths(paths: string[]) {
    const ok = new Set(view.filter((r) => selectable(r.final)).map((r) => r.path));
    setSelected(new Set(paths.filter((p) => ok.has(p))));
  }

  function toggle(path: string) {
    const next = new Set(selected);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    selectPaths([...next]);
  }

  const go = (to: StepId) => dispatch({ type: "go", to, selected: chosen.length });
  const aiSummary = useMemo(() => summarize(view.filter((r) => r.final.source === "ai")), [view]);
  const modelInfo = models.find((m) => m.slug === model);

  // The list / confirmation steps need the full width; the account panel matters on steps 1, 2 and 4.
  const wide = flow.step === "review" || flow.step === "trash" || flow.step === "done";
  let page;
  switch (flow.step) {
    case "target":
      page = (
        <TargetStep
          target={target}
          onTarget={setTarget}
          onPickFolder={() => void pickFolder()}
          lastFolder={lastFolder}
          minSize={minSize}
          onMinSize={setMinSize}
          onStart={() => {
            setHistory([]);
            void runScan(target, false);
          }}
          disk={disk}
          canResume={flow.hasScan}
          resumeLabel={canGo(flow, "review", 0) ? "前回の一覧に戻る" : "前回の AI 判定に戻る"}
          onResume={() => go(canGo(flow, "review", 0) ? "review" : "ai")}
        />
      );
      break;
    case "scanning":
      page = (
        <ScanningStep
          target={target}
          progress={progress}
          startedAt={scanStartedAt}
          cancelling={cancelling}
          onCancel={() => {
            setCancelling(true);
            void api.cancelScan();
          }}
        />
      );
      break;
    case "review":
      page = (
        <ReviewStep
          rows={view}
          target={scanned}
          denied={denied}
          partial={partial}
          aiDone={flow.aiDone}
          aiFirst={flow.aiFirst}
          selected={selected}
          onToggle={toggle}
          onSelectPaths={selectPaths}
          onSelectAllSafe={() => selectPaths(safePaths(view))}
          onClearSelection={() => setSelected(new Set())}
          canGoUp={history.length > 0}
          onGoUp={goUp}
          onDrill={(path) => {
            setTarget({ kind: "folder", path });
            void runScan({ kind: "folder", path }, true);
          }}
          onRescan={() => void runScan(scanned, false)}
          onChangeTarget={() => go("target")}
          aiTargets={aiTargets.length}
          onGoAi={() => go("ai")}
          onGoTrash={() => go("trash")}
          home={env?.home ?? null}
          view={reviewView}
          onView={setReviewView}
          sort={effectiveSort(sortChoice, flow.aiDone)}
          onSort={setSortChoice}
        />
      );
      break;
    case "ai":
      page = (
        <AiStep
          aiFirst={flow.aiFirst}
          canGoReview={canGo(flow, "review", chosen.length)}
          onBack={() => dispatch({ type: "back", selected: chosen.length })}
          planReady={planReady}
          signedIn={signedIn}
          modelName={modelInfo?.displayName ?? null}
          modelsLoading={modelsLoading}
          destination={PROVIDER.destination}
          targets={aiTargets.length}
          batchSize={BATCH}
          running={aiRun}
          outcome={aiOutcome}
          summary={aiSummary}
          selectedCount={chosen.length}
          onOpenSend={() => setAiDialog(true)}
          onStop={() => {
            aiStop.current = true;
            setAiRun((s) => (s ? { ...s, stopRequested: true } : s));
          }}
          onGoReview={() => go("review")}
          onGoTrash={() => go("trash")}
        />
      );
      break;
    case "trash":
      page = (
        <TrashStep
          rows={chosen}
          trashing={flow.busy === "trash"}
          progress={trashProgress}
          onBack={() => dispatch({ type: "back", selected: chosen.length })}
          onDeselect={toggle}
          onConfirm={() => void doTrash()}
        />
      );
      break;
    case "done":
      page = (
        <DoneStep
          outcomes={trashOutcomes}
          movedBytes={movedBytes}
          error={trashError}
          remaining={rows.length}
          onBackToList={() => go("review")}
          onRestart={() => dispatch({ type: "reset" })}
        />
      );
      break;
  }

  return (
    <div className="app">
      <header className="app-bar">
        <div className="brand">
          <AppIcon />
          <div>
            <h1>Fix Storage</h1>
            {env && <div className="version">v{env.version}</div>}
          </div>
        </div>
        <Stepper flow={flow} canGo={(to) => canGo(flow, to, chosen.length)} onGo={go} />
        <div className="app-bar-tools">
          <UpdateCheckButton />
        {disk && (
          <div className="disk-chip" title={`空き ${formatBytes(disk.available)} / 全体 ${formatBytes(disk.total)}`}>
            空き <strong>{formatBytes(disk.available)}</strong>
          </div>
        )}
        </div>
      </header>
      {/* Each step renders its title and actions here (StepBar), so the main action never scrolls away. */}
      <div className="topbar-slot" ref={setBarSlot} />

      <div className="scroll">
      <div className={`layout ${wide ? "wide" : ""}`}>
        <main className="main">
          {error && (
            <div className="error" role="alert">
              <span>{error}</span>
              <button type="button" className="link" onClick={() => setError(null)}>
                閉じる
              </button>
            </div>
          )}
          {notice && (
            <div className="notice">
              <span>{notice}</span>
              <button type="button" className="link" onClick={() => setNotice(null)}>
                閉じる
              </button>
            </div>
          )}
          <ActionBarSlot value={barSlot}>
            <div className="page" key={flow.step}>
              {page}
            </div>
          </ActionBarSlot>
        </main>

        <aside className="sidebar" hidden={wide}>
          <AccountPanel
            status={status}
            models={models}
            modelsLoading={modelsLoading}
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
          <div className="card safety">
            <h3>安全のしくみ</h3>
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
          </div>
        </aside>
      </div>
      </div>

      {aiDialog && env && planReady && (
        <AiSendDialog
          rows={aiTargets}
          provider={PROVIDER}
          model={modelInfo}
          home={env.home}
          user={env.user}
          onCancel={() => setAiDialog(false)}
          onSend={(mask) => void sendToAi(mask)}
        />
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
