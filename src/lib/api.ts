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
  current: string;
  done: number;
  total: number;
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
  moveToTrash: (paths: string[]) => invoke<TrashOutcome[]>("move_to_trash", { paths }),
  revealInFinder: (path: string) => invoke<void>("reveal_in_finder", { path }),
  openUsage: () => invoke<void>("open_usage"),
  siwcStatus: () => invoke<SiwcStatus>("siwc_status"),
  siwcSignIn: (clientId: string | null, promptConsent: boolean) => invoke<AccountView>("siwc_sign_in", { clientId, promptConsent }),
  siwcCancelSignIn: () => invoke<void>("siwc_cancel_sign_in"),
  siwcSwitch: (clientId: string) => invoke<void>("siwc_switch", { clientId }),
  siwcAckWelcome: () => invoke<void>("siwc_ack_welcome"),
  siwcSignOut: () => invoke<{ remoteRevoked: boolean }>("siwc_sign_out"),
  siwcModels: () => invoke<Model[]>("siwc_models"),
  siwcRespond: (requestId: string, model: string, instructions: string, input: string) =>
    invoke<string>("siwc_respond", { requestId, model, instructions, input }),
};
