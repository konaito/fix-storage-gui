import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  relaunch: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: mocks.check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: mocks.relaunch }));

import {
  __resetUpdateStoreForTests,
  applyDownloadEvent,
  checkForUpdate,
  describeUpdateError,
  dismissUpdate,
  downloadFraction,
  extractNotes,
  getUpdateState,
  installUpdate,
  NOTES_END_MARKER,
  resumeUpdate,
  setUpdateBlocked,
  updateBlocksWork,
  type DownloadEvent,
} from "../src/lib/updater";

function fakeUpdate(events: DownloadEvent[], fail?: Error) {
  return {
    version: "0.3.0",
    currentVersion: "0.2.0",
    date: "2026-12-01T00:00:00Z",
    body: `## 変更点\n- **新機能** を追加\n${NOTES_END_MARKER}\n### 開き方\n.dmg を開いて…`,
    close: vi.fn(async () => {}),
    download: vi.fn(async (cb?: (e: DownloadEvent) => void) => {
      for (const e of events) cb?.(e);
      if (fail) throw fail;
    }),
    install: vi.fn(async () => {}),
  };
}

describe("updater helpers", () => {
  it("extractNotes keeps only the part before the marker and strips markdown noise", () => {
    expect(extractNotes(`## 変更点\n- **A** を修正\n\n\n\n- B\n${NOTES_END_MARKER}\n## 開き方\nドラッグ`)).toBe("変更点\n- A を修正\n\n- B");
    expect(extractNotes("本文だけ")).toBe("本文だけ");
    expect(extractNotes(undefined)).toBe("");
  });

  it("applyDownloadEvent accumulates real byte counts; unknown length stays indeterminate", () => {
    let p = { downloaded: 0, total: null as number | null };
    p = applyDownloadEvent(p, { event: "Started", data: { contentLength: 1000 } });
    p = applyDownloadEvent(p, { event: "Progress", data: { chunkLength: 300 } });
    p = applyDownloadEvent(p, { event: "Progress", data: { chunkLength: 200 } });
    expect(p).toEqual({ downloaded: 500, total: 1000 });
    expect(downloadFraction(p.downloaded, p.total)).toBe(0.5);
    const q = applyDownloadEvent({ downloaded: 0, total: null }, { event: "Started", data: {} });
    expect(q.total).toBeNull();
    expect(downloadFraction(10, null)).toBeNull();
  });

  it("describeUpdateError maps common failures to Japanese", () => {
    expect(describeUpdateError(new Error("signature verification failed"))).toMatch(/署名/);
    expect(describeUpdateError("Could not fetch a valid release JSON from the remote")).toMatch(/取得できません/);
    expect(describeUpdateError("error sending request: dns error")).toMatch(/接続できません/);
  });
});

describe("updater store", () => {
  beforeEach(() => {
    (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
    __resetUpdateStoreForTests();
    mocks.check.mockReset();
    mocks.relaunch.mockClear();
  });
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("quiet launch check: no update and errors stay silent", async () => {
    mocks.check.mockResolvedValueOnce(null);
    await checkForUpdate(false);
    expect(getUpdateState().phase.kind).toBe("idle");
    mocks.check.mockRejectedValueOnce(new Error("network down"));
    await checkForUpdate(false);
    expect(getUpdateState().phase.kind).toBe("idle");
  });

  it("manual check reports up-to-date and errors", async () => {
    mocks.check.mockResolvedValueOnce(null);
    await checkForUpdate(true);
    expect(getUpdateState().phase.kind).toBe("upToDate");
    mocks.check.mockRejectedValueOnce(new Error("network down"));
    await checkForUpdate(true);
    expect(getUpdateState().phase).toMatchObject({ kind: "error", during: "check" });
  });

  it("found update -> download with progress -> relaunch", async () => {
    const u = fakeUpdate([
      { event: "Started", data: { contentLength: 100 } },
      { event: "Progress", data: { chunkLength: 60 } },
      { event: "Progress", data: { chunkLength: 40 } },
      { event: "Finished" },
    ]);
    mocks.check.mockResolvedValue(u);
    await checkForUpdate(false);
    const ph = getUpdateState().phase;
    expect(ph).toMatchObject({ kind: "available", info: { version: "0.3.0", currentVersion: "0.2.0", notes: "変更点\n- 新機能 を追加" } });
    await installUpdate();
    expect(u.download).toHaveBeenCalledTimes(1);
    expect(u.install).toHaveBeenCalledTimes(1);
    expect(mocks.relaunch).toHaveBeenCalledTimes(1);
    expect(getUpdateState().phase.kind).toBe("restarting");
  });

  it("does not install while a scan / trash is running", async () => {
    const u = fakeUpdate([]);
    mocks.check.mockResolvedValue(u);
    await checkForUpdate(true);
    setUpdateBlocked("スキャン中");
    await installUpdate();
    expect(u.download).not.toHaveBeenCalled();
    expect(getUpdateState().phase.kind).toBe("available");
    setUpdateBlocked(null);
    await installUpdate();
    expect(u.download).toHaveBeenCalledTimes(1);
    expect(u.install).toHaveBeenCalledTimes(1);
  });

  it("install failure shows error and retry re-checks then installs", async () => {
    const bad = fakeUpdate([{ event: "Started", data: { contentLength: 10 } }], new Error("connection reset"));
    const good = fakeUpdate([{ event: "Finished" }]);
    mocks.check.mockResolvedValueOnce(bad).mockResolvedValueOnce(good);
    await checkForUpdate(true);
    await installUpdate();
    expect(getUpdateState().phase).toMatchObject({ kind: "error", during: "install" });
    expect(mocks.relaunch).not.toHaveBeenCalled();
    await installUpdate();
    expect(mocks.check).toHaveBeenCalledTimes(2);
    expect(good.download).toHaveBeenCalledTimes(1);
    expect(good.install).toHaveBeenCalledTimes(1);
    expect(mocks.relaunch).toHaveBeenCalledTimes(1);
  });

  it("does not relaunch when work starts while the update is downloading (#22)", async () => {
    // download / install / downloadAndInstall のどれで呼ばれても、ダウンロードの途中でスキャンが始まる。
    const events: DownloadEvent[] = [
      { event: "Started", data: { contentLength: 100 } },
      { event: "Progress", data: { chunkLength: 50 } },
      { event: "Progress", data: { chunkLength: 50 } },
      { event: "Finished" },
    ];
    const run = async (cb?: (e: DownloadEvent) => void) => {
      for (const e of events) {
        cb?.(e);
        if (e.event === "Progress") setUpdateBlocked("スキャン中");
      }
    };
    const u = {
      ...fakeUpdate([]),
      download: vi.fn(run),
      install: vi.fn(async () => {}),
      downloadAndInstall: vi.fn(run),
    };
    mocks.check.mockResolvedValue(u);
    await checkForUpdate(true);
    await installUpdate();
    expect(mocks.relaunch).not.toHaveBeenCalled();
    expect(getUpdateState().phase.kind).not.toBe("restarting");
    // 作業が終わるまで install もしない。終わっても自動では再起動せず、ユーザーが押してから進む。
    expect(u.install).not.toHaveBeenCalled();
    expect(getUpdateState().phase).toMatchObject({ kind: "waiting", installed: false });
    await resumeUpdate();
    expect(u.install).not.toHaveBeenCalled();
    setUpdateBlocked(null);
    expect(mocks.relaunch).not.toHaveBeenCalled();
    await resumeUpdate();
    expect(u.install).toHaveBeenCalledTimes(1);
    expect(mocks.relaunch).toHaveBeenCalledTimes(1);
    expect(getUpdateState().phase.kind).toBe("restarting");
  });

  it("does not relaunch when work starts while installing; restarts after the user resumes", async () => {
    const u = fakeUpdate([{ event: "Finished" }]);
    u.install.mockImplementation(async () => setUpdateBlocked("ゴミ箱へ移動中"));
    mocks.check.mockResolvedValue(u);
    await checkForUpdate(true);
    await installUpdate();
    expect(u.install).toHaveBeenCalledTimes(1);
    expect(mocks.relaunch).not.toHaveBeenCalled();
    expect(getUpdateState().phase).toMatchObject({ kind: "waiting", installed: true });
    setUpdateBlocked(null);
    await resumeUpdate();
    expect(u.install).toHaveBeenCalledTimes(1);
    expect(mocks.relaunch).toHaveBeenCalledTimes(1);
  });

  it("a manual check while waiting keeps the downloaded update", async () => {
    const u = fakeUpdate([{ event: "Progress", data: { chunkLength: 1 } }]);
    u.download.mockImplementation(async () => setUpdateBlocked("スキャン中"));
    mocks.check.mockResolvedValue(u);
    await checkForUpdate(true);
    await installUpdate();
    expect(getUpdateState().phase.kind).toBe("waiting");
    await checkForUpdate(true);
    expect(mocks.check).toHaveBeenCalledTimes(1);
    expect(u.close).not.toHaveBeenCalled();
    expect(getUpdateState().phase.kind).toBe("waiting");
  });

  it("updateBlocksWork is true only from download to restart", () => {
    const info = { version: "0.3.0", currentVersion: "0.2.0", notes: "", date: null };
    expect(updateBlocksWork({ kind: "downloading", info, downloaded: 0, total: null })).toBe(true);
    expect(updateBlocksWork({ kind: "installing", info })).toBe(true);
    expect(updateBlocksWork({ kind: "restarting", info })).toBe(true);
    expect(updateBlocksWork({ kind: "available", info })).toBe(false);
    expect(updateBlocksWork({ kind: "waiting", info, installed: false })).toBe(false);
    expect(updateBlocksWork({ kind: "error", during: "install", message: "", info })).toBe(false);
    expect(updateBlocksWork({ kind: "idle" })).toBe(false);
  });

  it("'あとで' hides that version for the rest of the session's automatic checks", async () => {
    mocks.check.mockResolvedValue(fakeUpdate([]));
    await checkForUpdate(false);
    dismissUpdate();
    expect(getUpdateState().phase.kind).toBe("idle");
    await checkForUpdate(false);
    expect(getUpdateState().phase.kind).toBe("idle");
    await checkForUpdate(true);
    expect(getUpdateState().phase.kind).toBe("available");
  });
});
