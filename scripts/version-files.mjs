// アプリの版番号が書かれている場所の一覧と、その読み書き。
// bump-version.mjs と check-version.mjs の両方がここを使う。
// 依存パッケージを使わないので、npm ci の前でも node だけで動く。
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// 各場所は「ちょうど1回一致する正規表現」で表す。2番目のキャプチャが版番号。
// 一致が0回や2回以上なら、ファイルの形が想定と違うので処理を止める。
export const LOCATIONS = [
  { file: 'package.json', label: 'version', re: /^(  "version": ")([^"]*)(")/m },
  { file: 'package-lock.json', label: 'version', re: /^(  "version": ")([^"]*)(")/m },
  {
    file: 'package-lock.json',
    label: 'packages[""].version',
    re: /^(    "": \{\n(?: {6}.*\n)*? {6}"version": ")([^"]*)(")/m,
  },
  { file: 'src-tauri/tauri.conf.json', label: 'version', re: /^(  "version": ")([^"]*)(")/m },
  {
    file: 'src-tauri/Cargo.toml',
    label: '[package] version',
    re: /^(\[package\]\n(?:(?!\[).*\n)*?version = ")([^"]*)(")/m,
  },
  {
    file: 'src-tauri/Cargo.lock',
    label: '[[package]] fix-storage-gui',
    re: /^(\[\[package\]\]\nname = "fix-storage-gui"\nversion = ")([^"]*)(")/m,
  },
];

export const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function matchOnce(text, loc) {
  const global = new RegExp(loc.re.source, loc.re.flags.includes('g') ? loc.re.flags : loc.re.flags + 'g');
  const all = [...text.matchAll(global)];
  if (all.length !== 1) {
    throw new Error(`${loc.file} の ${loc.label} が ${all.length} か所で見つかった（1か所のはず）。ファイルの形を確かめてほしい`);
  }
  return all[0];
}

// JSON のファイルは、正規表現で拾った値と JSON として読んだ値が同じかも確かめる。
function jsonValue(text, loc) {
  const j = JSON.parse(text);
  if (loc.label === 'packages[""].version') return j.packages?.['']?.version;
  return j.version;
}

export function readVersions(root = DEFAULT_ROOT) {
  const cache = new Map();
  return LOCATIONS.map((loc) => {
    if (!cache.has(loc.file)) cache.set(loc.file, readFileSync(join(root, loc.file), 'utf8'));
    const text = cache.get(loc.file);
    const version = matchOnce(text, loc)[2];
    if (loc.file.endsWith('.json')) {
      const parsed = jsonValue(text, loc);
      if (parsed !== version) {
        throw new Error(`${loc.file} の ${loc.label} を正規表現では ${version}、JSON では ${parsed} と読んだ。ファイルの形を確かめてほしい`);
      }
    }
    return { file: loc.file, label: loc.label, version };
  });
}

// すべての置換を先に計算し、全部成功してから書く。途中で止まったときに一部のファイルだけ変わることはない。
export function setVersion(next, root = DEFAULT_ROOT) {
  if (!VERSION_RE.test(next)) {
    throw new Error(`版番号は X.Y.Z の形で渡してほしい（先頭の v は付けない）: ${next}`);
  }
  const texts = new Map();
  for (const loc of LOCATIONS) {
    if (!texts.has(loc.file)) texts.set(loc.file, readFileSync(join(root, loc.file), 'utf8'));
    const text = texts.get(loc.file);
    const m = matchOnce(text, loc);
    const start = m.index + m[1].length;
    texts.set(loc.file, text.slice(0, start) + next + text.slice(start + m[2].length));
  }
  for (const [file, text] of texts) writeFileSync(join(root, file), text);
  const after = readVersions(root);
  const wrong = after.filter((v) => v.version !== next);
  if (wrong.length > 0) {
    throw new Error(`書いた後に読み直すと ${next} になっていない場所がある: ${wrong.map((v) => `${v.file} ${v.label}=${v.version}`).join(', ')}`);
  }
  return after;
}

// `--root <dir>` だけを受け付ける（テストで一時ディレクトリを渡すため）。残りの引数を返す。
export function parseArgs(argv) {
  const rest = [];
  let root = DEFAULT_ROOT;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') {
      root = resolve(argv[++i] ?? '');
    } else {
      rest.push(argv[i]);
    }
  }
  return { root, rest };
}
