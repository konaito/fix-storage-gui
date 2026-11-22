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
  setUpdateBlocked,
  type DownloadEvent,
} from "../src/lib/updater";

function fakeUpdate(events: DownloadEvent[], fail?: Error) {
  return {
    version: "0.3.0",
    currentVersion: "0.2.0",
    date: "2026-12-01T00:00:00Z",
    body: `## 変更点\n- **新機能** を追加\n${NOTES_END_MARKER}\n### 開き方\n.dmg を開いて…`,
    close: vi.fn(async () => {}),
    downloadAndInstall: vi.fn(async (cb: (e: DownloadEvent) => void) => {
      for (const e of events) cb(e);
      if (fail) throw fail;
    }),
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
    expect(u.downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(mocks.relaunch).toHaveBeenCalledTimes(1);
    expect(getUpdateState().phase.kind).toBe("restarting");
  });

  it("does not install while a scan / trash is running", async () => {
    const u = fakeUpdate([]);
    mocks.check.mockResolvedValue(u);
    await checkForUpdate(true);
    setUpdateBlocked("スキャン中");
    await installUpdate();
    expect(u.downloadAndInstall).not.toHaveBeenCalled();
    expect(getUpdateState().phase.kind).toBe("available");
    setUpdateBlocked(null);
    await installUpdate();
    expect(u.downloadAndInstall).toHaveBeenCalledTimes(1);
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
    expect(good.downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(mocks.relaunch).toHaveBeenCalledTimes(1);
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
