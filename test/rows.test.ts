import { describe, expect, it } from "vitest";
import { aiSendTargets, toRow, withAi } from "../src/lib/rows";
import type { ScanItem } from "../src/lib/api";

const item = (name: string): ScanItem => ({
  path: `/Users/u/Library/Caches/${name}`,
  name,
  size: 1024,
  dir: false,
  category: "caches",
  modifiedMs: null,
  lastUsedMs: null,
  blocked: null,
});

describe("AI send targets (#75)", () => {
  const rows = ["a.zip", "b.zip", "c.zip"].map((n) => toRow(item(n)));

  it("sends everything when nothing has been judged yet", () => {
    expect(aiSendTargets(rows).map((r) => r.name)).toEqual(["a.zip", "b.zip", "c.zip"]);
  });

  it("continues with only the rows the AI has not judged (e.g. after signing in again)", () => {
    const partly = [withAi(rows[0], { id: "i0", verdict: "safe", reason: "old installer" }), rows[1], rows[2]];
    expect(aiSendTargets(partly).map((r) => r.name)).toEqual(["b.zip", "c.zip"]);
  });

  it("judges everything again once every row has a verdict", () => {
    const all = rows.map((r, i) => withAi(r, { id: `i${i}`, verdict: "safe", reason: "x" }));
    expect(aiSendTargets(all)).toHaveLength(3);
  });
});
