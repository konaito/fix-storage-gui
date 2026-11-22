import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// #44: マップの凡例とタイルの色をそろえ、11〜14px の文字が WCAG の 4.5:1 に届くかを styles.css から計算して確かめる。

const css = readFileSync(join(__dirname, "..", "src", "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** `:root { ... }` の中の `--name: value;` を読む。dark なら prefers-color-scheme: dark の中の :root を上に重ねる。 */
function tokens(theme: "light" | "dark"): Map<string, string> {
  const out = new Map<string, string>();
  const take = (body: string) => {
    for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out.set(name, value.trim());
  };
  const darkBodies: string[] = [];
  for (const m of css.matchAll(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]*)\}/g)) darkBodies.push(m[1]);
  // ライトの :root は、直前の空白以外の文字が `{` でないもの（メディアクエリの中ではないもの）。
  for (const m of css.matchAll(/(^|[^{\s])\s*:root\s*\{([^}]*)\}/g)) take(m[2]);
  if (theme === "dark") darkBodies.forEach(take);
  return out;
}

/** セレクタがそのまま一致するルールの、プロパティの値を返す（無ければ undefined）。 */
function decl(selector: string, prop: string): string | undefined {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const values: string[] = [];
  for (const m of css.matchAll(new RegExp(`(^|[}\\n])\\s*${esc}\\s*\\{([^}]*)\\}`, "g"))) {
    for (const [, v] of m[2].matchAll(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, "g"))) values.push(v.trim());
  }
  return values.at(-1);
}

function resolve(value: string, t: Map<string, string>): string {
  let v = value;
  for (let i = 0; i < 10 && v.includes("var("); i++) {
    v = v.replace(/var\((--[\w-]+)\)/g, (_, name: string) => {
      const got = t.get(name);
      if (got == null) throw new Error(`token ${name} が無い`);
      return got;
    });
  }
  return v;
}

function rgb(color: string): [number, number, number] {
  const c = color.trim().toLowerCase();
  if (c === "#fff" || c === "white") return [255, 255, 255];
  const hex = /^#([0-9a-f]{6})$/.exec(c);
  if (!hex) throw new Error(`hex でない色: ${color}`);
  return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)) as [number, number, number];
}

const lum = ([r, g, b]: [number, number, number]) => {
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
};

/** 前景を alpha で背景に重ねたときのコントラスト比。 */
function contrast(fg: [number, number, number], bg: [number, number, number], alpha = 1): number {
  const mixed = fg.map((v, i) => Math.round(v * alpha + bg[i] * (1 - alpha))) as [number, number, number];
  const [a, b] = [lum(mixed), lum(bg)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const MIN = 4.5;
const round = (n: number) => Math.round(n * 100) / 100;

for (const theme of ["light", "dark"] as const) {
  describe(`${theme}: コントラスト`, () => {
    const t = tokens(theme);
    const col = (selector: string, prop: string) => {
      const v = decl(selector, prop);
      if (v == null) throw new Error(`${selector} の ${prop} が無い`);
      return rgb(resolve(v, t));
    };
    const white = rgb(resolve("var(--tile-text)", t));
    const sizeAlpha = Number(decl(".tile-size", "opacity") ?? "1");

    for (const sel of [".tile.safe", ".tile.safe:hover", ".tile.caution", ".tile.caution:hover"]) {
      it(`${sel} の白い名前（12px）`, () => expect(round(contrast(white, col(sel, "background")))).toBeGreaterThanOrEqual(MIN));
      it(`${sel} の白いサイズ（11px、opacity 込み）`, () =>
        expect(round(contrast(white, col(sel, "background"), sizeAlpha))).toBeGreaterThanOrEqual(MIN));
    }

    it("--text-3 と白い面（--bg-elev）", () =>
      expect(round(contrast(rgb(resolve("var(--text-3)", t)), rgb(resolve("var(--bg-elev)", t))))).toBeGreaterThanOrEqual(MIN));

    it("主ボタンの白い文字", () =>
      expect(round(contrast(col("button.primary", "color"), col("button.primary", "background")))).toBeGreaterThanOrEqual(MIN));
    it("主ボタンの hover の白い文字", () =>
      expect(round(contrast(col("button.primary", "color"), col("button.primary:hover:not(:disabled)", "background")))).toBeGreaterThanOrEqual(MIN));
  });
}

describe("凡例とタイルの色", () => {
  for (const bucket of ["safe", "caution", "keep"]) {
    it(`${bucket} の凡例はタイルと同じ塗り`, () => expect(decl(`.dot-mark.${bucket}`, "background")).toBe(decl(`.tile.${bucket}`, "background")));
  }
  it("選んだタイルは背景色を変えない", () => {
    expect(decl(".tile.on", "background")).toBeUndefined();
    expect(decl(".tile.on:hover", "background")).toBeUndefined();
  });
});
