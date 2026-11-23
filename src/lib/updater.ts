/**
 * アプリ内アップデート（Tauri 公式 updater プラグイン）の状態を持つ小さなストア。
 *
 * - 起動時に静かに確認し（失敗しても何も出さない）、メニューやボタンからの手動確認ではエラーや「最新です」も出す。
 * - 見つかったら UpdateBanner がバージョンとリリースノートを出し、「アップデートして再起動」でダウンロード → 置き換え → 再起動。
 * - スキャン・AI 判定・ゴミ箱移動の最中は、App から setUpdateBlocked() で知らせてもらい、インストールを始めない。
 *   ダウンロードの後、install の直前と relaunch の直前にもう一度見て、作業中なら waiting で止める（自動では再起動しない）。
 * - ダウンロードからインストールまでの間（updateBlocksWork）は、App の側がスキャン・AI 判定・ゴミ箱移動を始めない。
 *
 * 更新ファイルの検証（署名チェック）はプラグインが tauri.conf.json の公開鍵で行う。ここでは表示と順序だけを扱う。
 */
import { useSyncExternalStore } from "react";

export type UpdateInfo = {
  version: string;
  currentVersion: string;
  /** プレーンテキストとして表示するリリースノート（extractNotes 済み） */
  notes: string;
  date: string | null;
};

export type UpdatePhase =
  | { kind: "idle" }
  | { kind: "checking"; manual: boolean }
  | { kind: "upToDate"; currentVersion: string | null }
  | { kind: "available"; info: UpdateInfo }
  | { kind: "downloading"; info: UpdateInfo; downloaded: number; total: number | null }
  | { kind: "installing"; info: UpdateInfo }
  /** 作業中だったので、install（installed=false）か relaunch（installed=true）の手前で止めている。 */
  | { kind: "waiting"; info: UpdateInfo; installed: boolean }
  | { kind: "restarting"; info: UpdateInfo }
  | { kind: "error"; during: "check" | "install"; message: string; info: UpdateInfo | null };

export type UpdateState = {
  phase: UpdatePhase;
  /** 「あとで」を押したバージョン。このセッション中はバナーを出さない（手動確認では出す）。 */
  dismissedVersion: string | null;
  /** インストールを止めている理由（スキャン中など）。null なら止めていない。 */
  blockedBy: string | null;
  /** 手動確認やボタン操作で開いたか。起動時に自動で見つけたものは、作業中は表に出さない。 */
  revealed: boolean;
};

/** ダウンロード中のプラグインイベント（@tauri-apps/plugin-updater の DownloadEvent と同じ形）。 */
export type DownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

/** リリース本文のうち、アプリ内に出す部分。これより後ろは .dmg の開き方など新規インストール向けの説明。 */
export const NOTES_END_MARKER = "<!-- updater-notes-end -->";

export function extractNotes(body: string | null | undefined): string {
  if (!body) return "";
  const i = body.indexOf(NOTES_END_MARKER);
  const head = i >= 0 ? body.slice(0, i) : body;
  return head
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .map((l) => l.replace(/^#{1,6}\s+/, "").replace(/\*\*(.+?)\*\*/g, "$1"))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** ダウンロード進捗を 1 イベントぶん進める。contentLength が無ければ total は null（不確定表示）。 */
export function applyDownloadEvent(
  p: { downloaded: number; total: number | null },
  e: DownloadEvent,
): { downloaded: number; total: number | null } {
  switch (e.event) {
    case "Started":
      return { downloaded: 0, total: e.data.contentLength && e.data.contentLength > 0 ? e.data.contentLength : null };
    case "Progress":
      return { ...p, downloaded: p.downloaded + e.data.chunkLength };
    case "Finished":
      return p;
  }
}

/** 0..1 の進捗。total が分からないときは null。 */
export function downloadFraction(downloaded: number, total: number | null): number | null {
  if (!total) return null;
  return Math.max(0, Math.min(1, downloaded / total));
}

export function describeUpdateError(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e);
  const s = raw ?? "";
  if (/signature|minisign|public key|pubkey/i.test(s)) {
    return "更新ファイルの署名を確認できなかったため、インストールを中止しました。";
  }
  if (/valid release json|404|not found/i.test(s)) {
    return "アップデート情報を取得できませんでした（公開中のリリースに更新情報がまだ無い可能性があります）。";
  }
  if (/network|dns|connect|timed? ?out|offline|request/i.test(s)) {
    return "アップデートサーバーに接続できませんでした。ネットワークを確認して、もう一度お試しください。";
  }
  return s ? `アップデートに失敗しました: ${s}` : "アップデートに失敗しました。";
}

// ---------------- ストア ----------------

let state: UpdateState = { phase: { kind: "idle" }, dismissedVersion: null, blockedBy: null, revealed: false };
const listeners = new Set<() => void>();

function set(patch: Partial<UpdateState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}
function setPhase(phase: UpdatePhase) {
  set({ phase });
}

export function getUpdateState(): UpdateState {
  return state;
}
export function subscribeUpdate(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
export function useUpdateState(): UpdateState {
  return useSyncExternalStore(subscribeUpdate, getUpdateState, getUpdateState);
}

/** スキャン・AI 判定・ゴミ箱移動の最中は理由を、終わったら null を渡す。 */
export function setUpdateBlocked(reason: string | null) {
  if (state.blockedBy !== reason) set({ blockedBy: reason });
}

/** ダウンロードからインストール、再起動までの間は true。この間、App はスキャン・AI 判定・ゴミ箱移動を始めない。 */
export function updateBlocksWork(phase: UpdatePhase): boolean {
  return phase.kind === "downloading" || phase.kind === "installing" || phase.kind === "restarting";
}

export function dismissUpdate() {
  const p = state.phase;
  const info = p.kind === "available" || p.kind === "waiting" ? p.info : p.kind === "error" ? p.info : null;
  set({ dismissedVersion: info?.version ?? state.dismissedVersion, revealed: false, phase: { kind: "idle" } });
}

/** 作業中で隠れているバナーを、ユーザーの操作で表に出す。 */
export function revealUpdate() {
  set({ revealed: true });
}

export function clearUpdateMessage() {
  if (state.phase.kind === "upToDate" || (state.phase.kind === "error" && state.phase.during === "check")) setPhase({ kind: "idle" });
}

// プラグインの Update オブジェクト（Rust 側リソースへの参照）。表示用の状態とは分けて持つ。
type PluginUpdate = Awaited<ReturnType<typeof import("@tauri-apps/plugin-updater").check>>;
let pending: NonNullable<PluginUpdate> | null = null;

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** アップデートを確認する。manual=false（起動時）は失敗しても静かに idle に戻る。 */
export async function checkForUpdate(manual: boolean): Promise<void> {
  const k = state.phase.kind;
  // waiting 中に確認し直すと、ダウンロード済みの Update を close してしまうので確認しない。
  if (k === "checking" || k === "downloading" || k === "installing" || k === "waiting" || k === "restarting") return;
  if (!inTauri()) return;
  setPhase({ kind: "checking", manual });
  if (manual) set({ revealed: true });
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (pending && pending !== update) void pending.close().catch(() => {});
    pending = update;
    if (!update) {
      setPhase(manual ? { kind: "upToDate", currentVersion: null } : { kind: "idle" });
      return;
    }
    const info: UpdateInfo = {
      version: update.version,
      currentVersion: update.currentVersion,
      notes: extractNotes(update.body),
      date: update.date ?? null,
    };
    if (!manual && state.dismissedVersion === info.version) {
      setPhase({ kind: "idle" });
      return;
    }
    if (manual) set({ dismissedVersion: null, revealed: true });
    setPhase({ kind: "available", info });
  } catch (e) {
    console.warn("update check failed", e);
    setPhase(manual ? { kind: "error", during: "check", message: describeUpdateError(e), info: null } : { kind: "idle" });
  }
}

/**
 * ダウンロード → インストール → 再起動。作業中（blockedBy）なら始めない。
 * ダウンロード中に作業が始まったときは、install か relaunch の手前で waiting にして止める（#22）。
 */
export async function installUpdate(): Promise<void> {
  const p = state.phase;
  const info = p.kind === "available" ? p.info : p.kind === "error" ? p.info : null;
  if (!info || state.blockedBy) return;
  try {
    if (p.kind === "error" || !pending) {
      // 再試行: 前回の Update リソースは使い回さず、確認からやり直す。
      setPhase({ kind: "downloading", info, downloaded: 0, total: null });
      const { check } = await import("@tauri-apps/plugin-updater");
      if (pending) void pending.close().catch(() => {});
      pending = await check();
      if (!pending) {
        setPhase({ kind: "upToDate", currentVersion: null });
        return;
      }
    }
    const update = pending;
    let prog = { downloaded: 0, total: null as number | null };
    setPhase({ kind: "downloading", info, ...prog });
    await update.download((e) => {
      prog = applyDownloadEvent(prog, e as DownloadEvent);
      setPhase({ kind: "downloading", info, ...prog });
    });
    await installAndRelaunch(update, info, false);
  } catch (e) {
    console.warn("update install failed", e);
    setPhase({ kind: "error", during: "install", message: describeUpdateError(e), info });
  }
}

/** waiting で止めていた更新を、作業が終わったあとにユーザーの操作で続ける。 */
export async function resumeUpdate(): Promise<void> {
  const p = state.phase;
  if (p.kind !== "waiting" || state.blockedBy) return;
  if (!p.installed && !pending) return;
  // 二度押しで install が 2 回走らないよう、await の前にフェーズを変える。
  setPhase(p.installed ? { kind: "restarting", info: p.info } : { kind: "installing", info: p.info });
  try {
    await installAndRelaunch(pending, p.info, p.installed);
  } catch (e) {
    console.warn("update install failed", e);
    setPhase({ kind: "error", during: "install", message: describeUpdateError(e), info: p.info });
  }
}

/** blockedBy を見る直前に await を挟まない。App の setUpdateBlocked は描画の後に届くので、ここが最後の確認になる。 */
async function installAndRelaunch(update: NonNullable<PluginUpdate> | null, info: UpdateInfo, installed: boolean): Promise<void> {
  if (!installed) {
    if (state.blockedBy || !update) {
      setPhase({ kind: "waiting", info, installed: false });
      return;
    }
    setPhase({ kind: "installing", info });
    await update.install();
  }
  const { relaunch } = await import("@tauri-apps/plugin-process");
  if (state.blockedBy) {
    setPhase({ kind: "waiting", info, installed: true });
    return;
  }
  setPhase({ kind: "restarting", info });
  await relaunch();
}

/** テスト用: ストアを初期状態に戻す。 */
export function __resetUpdateStoreForTests() {
  pending = null;
  state = { phase: { kind: "idle" }, dismissedVersion: null, blockedBy: null, revealed: false };
  listeners.forEach((l) => l());
}
