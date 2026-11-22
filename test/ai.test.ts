import { describe, expect, it } from "vitest";
import { parseJudgements } from "../src/ai/parse";
import { buildInput, maskText, toPayload } from "../src/ai/prompt";

const mask = { enabled: true, home: "/Users/naito", user: "naito" };

describe("masking", () => {
  it("replaces home and user name", () => {
    expect(maskText("/Users/naito/Downloads/x.dmg", mask)).toBe("~/Downloads/x.dmg");
    expect(maskText("/Users/naito", mask)).toBe("~");
    expect(maskText("/Volumes/naito-backup/a", mask)).toBe("/Volumes/<user>-backup/a");
    expect(maskText("/Users/naitoX/a", mask)).toBe("/Users/<user>X/a");
  });
  it("can be turned off", () => {
    expect(maskText("/Users/naito/a", { ...mask, enabled: false })).toBe("/Users/naito/a");
  });
});

describe("payload", () => {
  it("contains metadata only, with exact keys", () => {
    const p = toPayload(
      "i0",
      {
        path: "/Users/naito/Downloads/Setup.dmg",
        name: "Setup.dmg",
        size: 123.4,
        dir: false,
        category: "documents",
        modifiedMs: Date.UTC(2025, 0, 2, 12),
        lastUsedMs: null,
        cli: { verdict: "junk", reason: "installer" },
      },
      mask,
    );
    expect(Object.keys(p).sort()).toEqual(
      ["category", "ext", "id", "kind", "last_used", "modified", "name", "path", "rule_reason", "rule_verdict", "size_bytes"].sort(),
    );
    expect(p.path).toBe("~/Downloads/Setup.dmg");
    expect(p.ext).toBe(".dmg");
    expect(p.size_bytes).toBe(123);
    expect(p.last_used).toBeNull();
    expect(buildInput([p])).not.toContain("/Users/naito");
  });
});

describe("parseJudgements", () => {
  const ids = new Set(["i0", "i1", "i2"]);
  it("parses plain and fenced JSON", () => {
    const text = '```json\n{"items":[{"id":"i0","verdict":"safe","reason":"キャッシュ"}]}\n```';
    expect(parseJudgements(text, ids)).toEqual([{ id: "i0", verdict: "safe", reason: "キャッシュ" }]);
  });
  it("drops unknown ids, bad verdicts and duplicates", () => {
    const text = JSON.stringify({
      items: [
        { id: "i0", verdict: "safe", reason: "a" },
        { id: "i0", verdict: "keep", reason: "dup" },
        { id: "zzz", verdict: "safe", reason: "x" },
        { id: "i1", verdict: "delete", reason: "x" },
        { id: "i2", verdict: "keep" },
      ],
    });
    expect(parseJudgements(text, ids)).toEqual([
      { id: "i0", verdict: "safe", reason: "a" },
      { id: "i2", verdict: "keep", reason: "" },
    ]);
  });
  it("throws when there is no JSON", () => {
    expect(() => parseJudgements("sorry", ids)).toThrow();
  });
});
