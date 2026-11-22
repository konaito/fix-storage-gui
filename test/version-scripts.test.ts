import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// scripts/check-version.mjs と scripts/bump-version.mjs を、版ファイルの一時コピーに対して走らせる。
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  "package.json",
  "package-lock.json",
  "src-tauri/tauri.conf.json",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
];

// 1か所だけ版をずらす置換。scripts/version-files.mjs の LOCATIONS と同じ6か所。
const drifts: Array<[string, string, (t: string) => string]> = [
  ["package.json", "version", (t) => t.replace(/^( {2}"version": ")[^"]*/m, "$19.9.9")],
  ["package-lock.json", "version", (t) => t.replace(/^( {2}"version": ")[^"]*/m, "$19.9.9")],
  [
    "package-lock.json",
    'packages[""].version',
    (t) => t.replace(/^( {4}"": \{\n(?: {6}.*\n)*? {6}"version": ")[^"]*/m, "$19.9.9"),
  ],
  ["src-tauri/tauri.conf.json", "version", (t) => t.replace(/^( {2}"version": ")[^"]*/m, "$19.9.9")],
  ["src-tauri/Cargo.toml", "[package] version", (t) => t.replace(/^(version = ")[^"]*/m, "$19.9.9")],
  [
    "src-tauri/Cargo.lock",
    "fix-storage-gui",
    (t) => t.replace(/^(name = "fix-storage-gui"\nversion = ")[^"]*/m, "$19.9.9"),
  ],
];

let root: string;

function run(script: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [join(repo, "scripts", script), "--root", root, ...args], {
    encoding: "utf8",
  });
  return { code: r.status, out: r.stdout + r.stderr };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fsg-version-"));
  for (const f of files) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    cpSync(join(repo, f), join(root, f));
  }
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("check-version", () => {
  it("いまのリポジトリの版はそろっている", () => {
    const r = run("check-version.mjs");
    expect(r.out).toContain("OK");
    expect(r.code).toBe(0);
  });

  it.each(drifts)("%s の %s だけずらすと落ちる", (file, _label, drift) => {
    const p = join(root, file);
    const before = readFileSync(p, "utf8");
    const after = drift(before);
    expect(after).not.toBe(before);
    writeFileSync(p, after);
    const r = run("check-version.mjs");
    expect(r.out).toContain("9.9.9");
    expect(r.code).toBe(1);
  });

  it("版の行が見つからないファイルでは落ちる", () => {
    const p = join(root, "src-tauri/Cargo.lock");
    writeFileSync(p, readFileSync(p, "utf8").replace('name = "fix-storage-gui"', 'name = "renamed"'));
    const r = run("check-version.mjs");
    expect(r.out).toContain("0 か所");
    expect(r.code).toBe(1);
  });
});

describe("bump-version", () => {
  it("6か所を書き換え、元の版に戻すと元のバイト列に戻る", () => {
    const original = files.map((f) => readFileSync(join(root, f), "utf8"));
    const current = (JSON.parse(original[0]) as { version: string }).version;

    const up = run("bump-version.mjs", "9.9.9");
    expect(up.code).toBe(0);
    expect(up.out.match(/^9\.9\.9\t/gm)).toHaveLength(6);
    expect(run("check-version.mjs").code).toBe(0);
    // 版以外の行は変わらない
    files.forEach((f, i) => {
      const a = original[i].split("\n");
      const b = readFileSync(join(root, f), "utf8").split("\n");
      expect(b.length).toBe(a.length);
      const changed = a.filter((line, k) => line !== b[k]);
      expect(changed.every((line) => line.includes(current))).toBe(true);
    });

    expect(run("bump-version.mjs", current).code).toBe(0);
    files.forEach((f, i) => expect(readFileSync(join(root, f), "utf8")).toBe(original[i]));
  });

  it.each(["v1.2.3", "1.2", "latest"])("%s は受け付けず、何も書かない", (bad) => {
    const original = files.map((f) => readFileSync(join(root, f), "utf8"));
    const r = run("bump-version.mjs", bad);
    expect(r.code).toBe(1);
    files.forEach((f, i) => expect(readFileSync(join(root, f), "utf8")).toBe(original[i]));
  });
});
