import { invoke } from "@tauri-apps/api/core";
import type { CategoryId } from "../cli-core/categories";

export interface ScanItem {
  path: string;
  name: string;
  size: number;
  dir: boolean;
  category: CategoryId;
  modifiedMs: number | null;
  lastUsedMs: number | null;
  /** Hard block reason from the Rust side. Such items can never be moved to the Trash. */
  blocked: string | null;
}

export interface ScanResult {
  items: ScanItem[];
  denied: string[];
  disk: { total: number; available: number } | null;
  cancelled: boolean;
}

export interface ScanProgress {
  /** Which part of the scan is running (see src-tauri/src/scan.rs). total is 0 while listing (unknown). */
  phase: "listing" | "measuring" | "dates";
  current: string;
  done: number;
  total: number;
}

/** Local-only preview for the detail panel (src-tauri/src/preview.rs). Never sent to the AI. */
export type Preview =
  | { kind: "blocked"; reason: string }
  | { kind: "image"; dataUrl: string }
  | { kind: "text"; snippet: string; truncated: boolean }
  | { kind: "folder"; count: number; more: boolean }
  | { kind: "none" }
  | { kind: "missing" }
  | { kind: "cancelled" };

export interface PreviewResult {
  path: string;
  preview: Preview;
  createdMs: number | null;
  modifiedMs: number | null;
  onDisk: number | null;
  apparent: number | null;
}

export interface TrashProgress {
  done: number;
  total: number;
  current: string;
}

export interface TrashOutcome {
  path: string;
  ok: boolean;
  error: string | null;
}

export interface EnvInfo {
  home: string;
  user: string;
  os: string;
  version: string;
}

export interface AccountView {
  clientId: string;
  label: string;
  email: string | null;
  planEnabled: boolean;
  signedIn: boolean;
  needsReauth: boolean;
}

export interface SiwcStatus {
  hostId: string;
  active: string | null;
  accounts: AccountView[];
  showWelcome: boolean;
}

export interface Model {
  slug: string;
  displayName: string;
}

/** Mirrors SiwcError in src-tauri/src/siwc/error.rs. */
export interface SiwcError {
  kind: string;
  code: string | null;
  param: string | null;
  status: number | null;
  requestId: string | null;
  message: string;
}

export function isSiwcError(e: unknown): e is SiwcError {
  return typeof e === "object" && e !== null && "kind" in e && "message" in e;
}

export const api = {
  envInfo: () => invoke<EnvInfo>("env_info"),
  scan: (folder: string | null, minSize: number) => invoke<ScanResult>("scan", { folder, minSize }),
  cancelScan: () => invoke<void>("cancel_scan"),
  previewItem: (path: string) => invoke<PreviewResult>("preview_item", { path }),
  cancelPreview: () => invoke<void>("cancel_preview"),
  moveToTrash: (paths: string[]) => invoke<TrashOutcome[]>("move_to_trash", { paths }),
  revealInFinder: (path: string) => invoke<void>("reveal_in_finder", { path }),
  openUsage: () => invoke<void>("open_usage"),
  /** Opens an official Sign in with ChatGPT doc page (allow-listed on the Rust side) in the system browser. */
  openSiwcDoc: (url: string) => invoke<void>("open_siwc_doc", { url }),
  siwcStatus: () => invoke<SiwcStatus>("siwc_status"),
  siwcSignIn: (clientId: string | null, promptConsent: boolean) => invoke<AccountView>("siwc_sign_in", { clientId, promptConsent }),
  siwcCancelSignIn: () => invoke<void>("siwc_cancel_sign_in"),
  siwcSwitch: (clientId: string) => invoke<void>("siwc_switch", { clientId }),
  siwcAckWelcome: () => invoke<void>("siwc_ack_welcome"),
  siwcSignOut: () => invoke<{ remoteRevoked: boolean }>("siwc_sign_out"),
  siwcModels: () => invoke<Model[]>("siwc_models"),
  siwcRespond: (requestId: string, clientId: string, model: string, instructions: string, input: string) =>
    invoke<string>("siwc_respond", { requestId, clientId, model, instructions, input }),
};
