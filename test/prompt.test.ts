import { describe, expect, it } from "vitest";
import type { CategoryId } from "../src/cli-core/categories";
import { classify, type Usage, type Verdict } from "../src/cli-core/classify";
import type { Item } from "../src/cli-core/shim";
import { INSTRUCTIONS } from "../src/ai/prompt";
import { mergeVerdict } from "../src/safety/merge";

const DAY = 24 * 3600 * 1000;
const now = Date.UTC(2026, 0, 1);

interface Sample {
  item: Item;
  category: CategoryId;
  usage?: Usage;
}

/** One concrete item for each example word the prompt may name, as the scan would hand it to classify. */
const SAMPLES: Record<string, Sample> = {
  // Words the prompt may give as "safe" examples.
  キャッシュ: { item: { path: "/Users/a/Library/Caches/com.example.app", size: 1, dir: true }, category: "caches" },
  node_modules: { item: { path: "/Users/a/dev/web/node_modules", size: 1, dir: true }, category: "developer" },
  ビルドキャッシュ: { item: { path: "/Users/a/dev/web/.next", size: 1, dir: true }, category: "developer" },
  インストーラー: { item: { path: "/Users/a/Downloads/Setup.dmg", size: 1 }, category: "documents" },
  ゴミ箱の中身: { item: { path: "/Users/a/.Trash/old.txt", size: 1 }, category: "trash" },
  // Words the prompt may give as examples the rules only call "unused".
  ビルド成果物: { item: { path: "/Users/a/dev/web/dist", size: 1, dir: true }, category: "developer" },
  "python 環境": { item: { path: "/Users/a/dev/tool/.venv", size: 1, dir: true }, category: "developer" },
  シミュレータのデバイス: {
    item: { path: "/Users/a/Library/Developer/CoreSimulator/Devices/1234-ABCD", size: 1, dir: true },
    category: "developer",
  },
  ダウンロードしたアーカイブ: { item: { path: "/Users/a/Downloads/photos.zip", size: 1 }, category: "documents" },
  "1年以上開いていないファイル": {
    item: { path: "/Users/a/Documents/draft.psd", size: 1 },
    category: "documents",
    usage: { at: now - 400 * DAY, kind: "opened" },
  },
};

/** The words listed between `start` and the next "など" in the prompt, split on "、" and "や". */
function examples(start: string): string[] {
  const from = INSTRUCTIONS.indexOf(start);
  expect(from, `prompt has no "${start}"`).toBeGreaterThanOrEqual(0);
  const rest = INSTRUCTIONS.slice(from + start.length);
  const end = rest.indexOf("など");
  expect(end, `no "など" after "${start}"`).toBeGreaterThan(0);
  const words = rest
    .slice(0, end)
    .split(/[、や]/)
    .map((w) => w.trim())
    .filter(Boolean);
  expect(words.length).toBeGreaterThan(0);
  return words;
}

function verdictOf(word: string): Verdict {
  const sample = SAMPLES[word];
  expect(sample, `no sample item for "${word}"; add one to SAMPLES`).toBeDefined();
  return classify(sample.item, sample.category, sample.usage, now).verdict;
}

describe("AI prompt examples match the rules (#54)", () => {
  it('names only things the rules call junk as "safe" examples', () => {
    const words = examples('- "safe": ');
    const got = Object.fromEntries(words.map((w) => [w, verdictOf(w)]));
    expect(got).toEqual(Object.fromEntries(words.map((w) => [w, "junk"])));
  });

  it('keeps the AI\'s "safe" for its "safe" examples after merging', () => {
    for (const w of examples('- "safe": ')) {
      const s = SAMPLES[w];
      const cli = classify(s.item, s.category, s.usage, now);
      const final = mergeVerdict({ blocked: null, category: s.category, cli, ai: { id: "i0", verdict: "safe", reason: "x" } });
      expect(final.verdict, w).toBe("safe");
    }
  });

  it('asks the AI to choose "caution" or "keep" for examples the rules call unused', () => {
    const words = examples('"unused" の項目（');
    const got = Object.fromEntries(words.map((w) => [w, verdictOf(w)]));
    expect(got).toEqual(Object.fromEntries(words.map((w) => [w, "unused"])));
  });
});
