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
import { api, isSiwcError, type EnvInfo, type Model, type ScanProgress, type TrashOutcome, type TrashProgress } from "./lib/api";
import { describeError, revealFailedJa } from "./lib/errors";
import { formatBytes } from "./lib/format";
import { aiSendTargets, forDisplay, toRow, withAi, type Row } from "./lib/rows";
import { selectable } from "./safety/merge";
import { UpdateCheckButton } from "./components/UpdateBanner";
import { setUpdateBlocked } from "./lib/updater";

const PROVIDER: JudgeProvider = chatGptProvider;
const BATCH = 25;

export default function App() {
  const [env, setEnv] = useState<EnvInfo | null>(null);
  // Sign-in state is owned by the login gate (#29, #30); the app only reads it.
  const gate = useGate();
  const { status, signingIn, refreshStatus, reportApp } = gate;
  const [models, setModels] = useState<Model[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  // Loading the model list failed or it came back empty: no AI run can start, so the list must not wait for one (#26).
  const [modelsFailed, setModelsFailed] = useState(false);
  const [model, setModel] = useState("");

  const [flow, dispatch] = useReducer(flowReducer, initialFlow);
  const [barSlot, setBarSlot] = useState<HTMLDivElement | null>(null);
  const busyLabel = flow.busy === "scan" ? "スキャン中" : flow.busy === "ai" ? "AI 判定中" : flow.busy === "trash" ? "ゴミ箱へ移動中" : null;
  // アプリ内アップデートは、スキャン・AI 判定・ゴミ箱移動の最中は始めない（src/lib/updater.ts）。
  useEffect(() => setUpdateBlocked(busyLabel), [busyLabel]);
  // With a scan result, a token that stops working keeps this screen under a sign-in-again bar (#75).
  useEffect(() => reportApp(flow.hasScan || !!flow.busy, busyLabel), [reportApp, flow.hasScan, flow.busy, busyLabel]);
  useEffect(() => () => reportApp(false, null), [reportApp]);

  const [target, setTarget] = useState<Target>({ kind: "mac" });
  const [lastFolder, setLastFolder] = useState<string | null>(null);
  const [scanned, setScanned] = useState<Target>({ kind: "mac" });
  const [minSize, setMinSize] = useState(MIN_SIZES[1].bytes);
  const [history, setHistory] = useState<Target[]>([]);
  const [scanStartedAt, setScanStartedAt] = useState(0);
  const [cancelling, setCancelling] = useState(false);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  /** Id of the latest scan. Progress events from any other scan are ignored. */
  const scanIdRef = useRef(0);
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
  // Stopping the AI run aborts this; runBatches returns without waiting for requests in flight (#21).
  const aiAbort = useRef<AbortController | null>(null);
  // Signed-in users with plan usage: open the AI send dialog once after each scan (#12). Cancelling does not reopen it.
  const [autoAi, setAutoAi] = useState(false);

  const [trashProgress, setTrashProgress] = useState<TrashProgress | null>(null);
  const [trashOutcomes, setTrashOutcomes] = useState<TrashOutcome[]>([]);
  const [movedBytes, setMovedBytes] = useState(0);
  const [trashError, setTrashError] = useState<string | null>(null);

  const [usageLimit, setUsageLimit] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const active = status?.accounts.find((a) => a.clientId === status.active);
  const signedIn = !!active?.signedIn;
  const planReady = gate.planEnabled && signedIn && !!active?.planEnabled;

  // What every step shows and acts on: with plan usage, rows the AI has not judged are "未判定" and can't be selected (#12),
  // unless this list fell back to the rules' verdict (no models, the AI ended in an error, or the user skipped it: #26).
  const requireAi = planReady && !flow.ruleOnly;
  const view = useMemo(() => rows.map((r) => forDisplay(r, requireAi)), [rows, requireAi]);
  // AI review targets: everything not locked by the hard block list or fix-storage's rules.
  const aiTargets = useMemo(() => view.filter((r) => !r.final.locked), [view]);
  // What the next run sends (and the send dialog shows): only the rows the AI has not judged yet (#75).
  const aiQueue = useMemo(() => aiSendTargets(aiTargets), [aiTargets]);
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
      setModelsFailed(list.length === 0);
      setModel((cur) => (list.some((m) => m.slug === cur) ? cur : (list[0]?.slug ?? "")));
    } catch (e) {
      setModels([]);
      setModelsFailed(true);
      handleAiError(e);
    } finally {
      setModelsLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    api.envInfo().then(setEnv).catch((e) => setError(describeError(e)));
    const un1 = listen<ScanProgress>("scan-progress", (e) => {
      if (e.payload.scanId === scanIdRef.current) setProgress(e.payload);
    });
    const un2 = listen<TrashProgress>("trash-progress", (e) => setTrashProgress(e.payload));
    return () => {
      void un1.then((f) => f());
      void un2.then((f) => f());
    };
  }, []);

  // Refresh the model list whenever the active account changes.
  useEffect(() => {
    if (planReady) void loadModels();
    else {
      setModels([]);
      setModelsFailed(false);
    }
  }, [planReady, status?.active, loadModels]);

  useEffect(() => dispatch({ type: "models", available: !modelsFailed }), [modelsFailed]);

  function handleAiError(e: unknown) {
    if (isSiwcError(e)) {
      if (e.kind === "usage_limit") setUsageLimit(true);
      // The gate also hears "reauth" from Rust (#29), but maybe after this status read: tell it first so
      // the results stay on screen (#75). Reading status here also covers plan_not_enabled.
      if (e.kind === "reauth_required") gate.signInLost("reauth");
      if (e.kind === "client_revoked") gate.signInLost("client_revoked");
      if (e.kind === "reauth_required" || e.kind === "client_revoked" || e.kind === "plan_not_enabled") void refreshStatus();
    }
    setError(describeError(e));
  }

  async function signIn(clientId: string | null, promptConsent: boolean) {
    if (flow.busy) return;
    setError(null);
    const r = await gate.signIn(clientId, promptConsent);
    if (!r.started) return;
    if (r.error) handleAiError(r.error);
    else if (r.account && !r.account.planEnabled) setNotice("サインインしました。ただし ChatGPT プランの利用は許可されていません。");
  }

  // After a successful sign-out the gate shows the login screen with its own notice.
  async function signOut() {
    if (flow.busy) return;
    const e = await gate.signOut();
    if (e) setError(describeError(e));
  }

  async function switchAccount(clientId: string) {
    if (flow.busy) return;
    const e = await gate.switchAccount(clientId);
    if (e) setError(describeError(e));
  }

  async function runScan(t: Target, pushHistory: boolean) {
    if (flow.busy) return;
    setError(null);
    setNotice(null);
    setProgress(null);
    setCancelling(false);
    setScanStartedAt(Date.now());
    dispatch({ type: "scanStart" });
    const scanId = ++scanIdRef.current;
    try {
      const res = await api.scan(t.kind === "folder" ? t.path : null, minSize, scanId);
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
    // Every batch of this run goes to the account it started with (#28).
    const clientId = status?.active;
    if (!env || !model || flow.busy || !planReady || !clientId) return;
    const maskOpts = { enabled: mask, home: env.home, user: env.user };
    const indexed = aiQueue.map((r, i) => ({ id: `i${i}`, row: r }));
    if (indexed.length === 0) return;
    const batches = chunk(indexed, BATCH);
    const abort = new AbortController();
    aiAbort.current = abort;
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
    let failed = 0;
    let failedReason: string | null = null;
    let stopped = false;
    let err: string | null = null;
    try {
      const outcome = await runBatches({
        batches,
        concurrency: DEFAULT_CONCURRENCY,
        itemCount: (batch) => batch.length,
        signal: abort.signal,
        send: (batch, _index, onChars, signal) => {
          const payload = batch.map(({ id, row }) => toPayload(id, row, maskOpts));
          return PROVIDER.judge(payload, { model, clientId, onProgress: onChars, signal });
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
      // Batches that failed twice stay unjudged; the rest of the run went on (#27).
      failed = outcome.failed.reduce((n, f) => n + batches[f.index].length, 0);
      failedReason = outcome.failed.length > 0 ? describeError(outcome.failed[outcome.failed.length - 1].error) : null;
      if (outcome.error) {
        handleAiError(outcome.error);
        err = describeError(outcome.error);
      }
    } catch (e) {
      handleAiError(e);
      err = describeError(e);
    } finally {
      if (aiAbort.current === abort) aiAbort.current = null;
      setAiRun(null);
      setAiOutcome({ judged: results.size, missing, failed, failedReason, stopped, error: err });
      // An error (usage limit, sign-in, every batch failed) opens the list with the rules' verdict for the rest (#26).
      dispatch({ type: "aiEnd", ok: !err && results.size > 0, error: !!err || (!stopped && results.size === 0 && failed > 0) });
    }
  }

  // Open the send dialog by itself once the AI step is up and a model is ready.
  useEffect(() => {
    if (autoAi && flow.step === "ai" && !flow.busy && !flow.ruleOnly && planReady && !!model && !!env && aiTargets.length > 0) {
      setAutoAi(false);
      setAiDialog(true);
    }
  }, [autoAi, flow.step, flow.busy, flow.ruleOnly, planReady, model, env, aiTargets.length]);

  /** "AI なしで一覧へ": this list only shows the rules' verdict for items the AI has not judged (#26). */
  function skipAi() {
    setAutoAi(false);
    dispatch({ type: "skipAi" });
  }

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
    if (chosen.length === 0) return;
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
          ruleOnly={flow.ruleOnly}
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
          aiTargets={flow.aiDone ? aiTargets.length : aiQueue.length}
          onGoAi={() => go("ai")}
          onGoTrash={() => go("trash")}
          onReveal={(path) => void api.revealInFinder(path).catch((e) => setError(revealFailedJa(e)))}
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
          ruleOnly={flow.ruleOnly}
          onSkipAi={skipAi}
          canGoReview={canGo(flow, "review", chosen.length)}
          onBack={() => dispatch({ type: "back", selected: chosen.length })}
          planReady={planReady}
          signedIn={signedIn}
          modelName={modelInfo?.displayName ?? null}
          modelsLoading={modelsLoading}
          destination={PROVIDER.destination}
          targets={aiQueue.length}
          alreadyJudged={aiTargets.length - aiQueue.length}
          batchSize={BATCH}
          running={aiRun}
          outcome={aiOutcome}
          summary={aiSummary}
          selectedCount={chosen.length}
          onOpenSend={() => setAiDialog(true)}
          onStop={() => {
            aiAbort.current?.abort();
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
            locked={flow.busy === "ai" ? "AI 判定中" : flow.busy === "scan" ? "スキャン中" : flow.busy === "trash" ? "ゴミ箱へ移動中" : null}
            onSignIn={(id, consent) => void signIn(id, consent)}
            onCancelSignIn={gate.cancelSignIn}
            onSwitch={(id) => void switchAccount(id)}
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
          rows={aiQueue}
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
