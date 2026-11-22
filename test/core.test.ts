import { describe, expect, it } from "vitest";
import { classify } from "../src/cli-core/classify";
import { extname, basename } from "../src/cli-core/shim";

describe("vendored fix-storage classify()", () => {
  const now = Date.parse("2026-11-22T00:00:00Z");
  it("node_modules rebuilds", () => {
    expect(classify({ path: "/Users/a/p/node_modules", size: 1, dir: true }, "documents", undefined, now).verdict).toBe("junk");
  });
  it("caches and trash are junk, system stays system", () => {
    expect(classify({ path: "/Users/a/Library/Caches/x", size: 1, dir: true }, "caches").verdict).toBe("junk");
    expect(classify({ path: "/Users/a/.Trash/x", size: 1 }, "trash").verdict).toBe("junk");
    expect(classify({ path: "/private/var/x", size: 1 }, "system").verdict).toBe("system");
  });
  it("installers are junk", () => {
    expect(classify({ path: "/Users/a/Downloads/Foo.dmg", size: 1 }, "documents").verdict).toBe("junk");
  });
  it("old files are unused", () => {
    const usage = { at: now - 400 * 24 * 3600 * 1000, kind: "opened" as const };
    expect(classify({ path: "/Users/a/Documents/x.psd", size: 1 }, "documents", usage, now).verdict).toBe("unused");
  });
});

describe("path shim matches Node semantics", () => {
  it("extname", () => {
    expect(extname("a.tar.gz")).toBe(".gz");
    expect(extname(".bashrc")).toBe("");
    expect(extname("noext")).toBe("");
    expect(extname("/x/y/Foo.DMG")).toBe(".DMG");
  });
  it("basename", () => {
    expect(basename("/a/b/c")).toBe("c");
    expect(basename("/a/b/c/")).toBe("c");
  });
});
