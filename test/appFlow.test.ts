import { describe, expect, it } from "vitest";
import type { Target } from "../src/components/steps/TargetStep";
import { afterScan, type ScanNav } from "../src/flow/scanNav";
import { withAllSafe } from "../src/flow/selection";

describe("「削除していい」をすべて選択 (#35)", () => {
  it("keeps items picked by hand, including 注意 ones", () => {
    const picked = new Set(["/Users/demo/Movies/holiday.mov", "/Users/demo/Downloads/installer.dmg"]);
    const safe = ["/Users/demo/Downloads/installer.dmg", "/Users/demo/Library/Caches/Homebrew"];
    const out = withAllSafe(picked, safe);
    expect(new Set(out)).toEqual(new Set([...picked, ...safe]));
    expect(out.length).toBe(3);
  });

  it("with nothing picked it is just the safe items", () => {
    expect(withAllSafe([], ["/a", "/b"])).toEqual(["/a", "/b"]);
  });
});

describe("target and 上のフォルダへ history after a scan (#37)", () => {
  const mac: Target = { kind: "mac" };
  const child: Target = { kind: "folder", path: "/Users/demo/Library/Caches/x" };
  const picked: Target = { kind: "folder", path: "/Users/demo/Downloads" };
  const inChild: ScanNav = { target: child, scanned: child, history: [mac] };

  it("a failed first scan of a picked folder keeps that folder chosen", () => {
    const nav: ScanNav = { target: picked, scanned: mac, history: [] };
    expect(afterScan(nav, picked, "reset", false, false).target).toEqual(picked);
  });

  it("a failed scan with a list on screen goes back to that list's target", () => {
    const nav: ScanNav = { ...inChild, target: picked };
    expect(afterScan(nav, picked, "reset", false, true)).toEqual(inChild);
  });

  it("a failed 上のフォルダへ keeps the history so the button stays", () => {
    expect(afterScan(inChild, mac, "pop", false, true)).toEqual(inChild);
  });

  it("a failed drill keeps the history and the current list", () => {
    const deeper: Target = { kind: "folder", path: "/Users/demo/Library/Caches/x/y" };
    expect(afterScan(inChild, deeper, "push", false, true)).toEqual(inChild);
  });

  it("successful scans apply the history change", () => {
    const deeper: Target = { kind: "folder", path: "/Users/demo/Library/Caches/x/y" };
    expect(afterScan(inChild, deeper, "push", true, true)).toEqual({ target: deeper, scanned: deeper, history: [mac, child] });
    expect(afterScan(inChild, mac, "pop", true, true)).toEqual({ target: mac, scanned: mac, history: [] });
    expect(afterScan(inChild, picked, "reset", true, true)).toEqual({ target: picked, scanned: picked, history: [] });
    expect(afterScan(inChild, child, "keep", true, true)).toEqual(inChild);
  });
});
