import { describe, expect, it } from "vitest";
import { revealFailedJa } from "../src/lib/errors";

describe("revealFailedJa (#63)", () => {
  it("puts the reason from the Rust side after the heading, once", () => {
    expect(revealFailedJa("open -R が失敗しました（/Users/t/a.dmg）")).toBe("Finder で表示できませんでした: open -R が失敗しました（/Users/t/a.dmg）");
    expect(revealFailedJa("正しいパスではありません")).toBe("Finder で表示できませんでした: 正しいパスではありません");
  });

  it("handles Error objects", () => {
    expect(revealFailedJa(new Error("x"))).toBe("Finder で表示できませんでした: x");
  });
});
