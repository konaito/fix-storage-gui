/** Finder-like "種類" label from the name only (no file is opened). */
const BY_EXT: Record<string, string> = {
  dmg: "ディスクイメージ",
  iso: "ディスクイメージ",
  pkg: "インストーラパッケージ",
  zip: "ZIP アーカイブ",
  gz: "gzip アーカイブ",
  tgz: "gzip アーカイブ",
  xz: "xz アーカイブ",
  rar: "RAR アーカイブ",
  "7z": "7-Zip アーカイブ",
  mov: "QuickTime ムービー",
  mp4: "MPEG-4 ムービー",
  m4v: "MPEG-4 ムービー",
  mkv: "Matroska ムービー",
  avi: "AVI ムービー",
  mp3: "MP3 オーディオ",
  m4a: "Apple MPEG-4 オーディオ",
  wav: "WAV オーディオ",
  aiff: "AIFF オーディオ",
  jpg: "JPEG イメージ",
  jpeg: "JPEG イメージ",
  png: "PNG イメージ",
  heic: "HEIF イメージ",
  gif: "GIF イメージ",
  psd: "Photoshop 書類",
  pdf: "PDF 書類",
  txt: "テキスト",
  md: "Markdown テキスト",
  log: "ログファイル",
  json: "JSON",
  csv: "CSV",
  ipa: "iOS アプリ",
  xip: "XIP アーカイブ",
  sqlite: "SQLite データベース",
  db: "データベース",
  vmdk: "仮想ディスク",
  qcow2: "仮想ディスク",
  img: "ディスクイメージ",
};

const BUNDLES: Record<string, string> = {
  app: "アプリケーション",
  photoslibrary: "写真ライブラリ",
  framework: "フレームワーク",
  bundle: "バンドル",
  xcarchive: "Xcode アーカイブ",
  pvm: "Parallels 仮想マシン",
  utm: "UTM 仮想マシン",
};

export function kindLabel(name: string, dir: boolean): string {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (dir) return BUNDLES[ext] ?? "フォルダ";
  if (!ext) return "書類";
  return BY_EXT[ext] ?? `${ext.toUpperCase()} ファイル`;
}

/** Breadcrumb segments for the parent folder, with the home folder shown as "ホーム". */
export function locationParts(path: string, home: string | null): string[] {
  const parent = path.slice(0, Math.max(0, path.lastIndexOf("/")));
  const h = home?.replace(/\/+$/, "") ?? "";
  if (h && (parent === h || parent.startsWith(h + "/"))) {
    return ["ホーム", ...parent.slice(h.length).split("/").filter(Boolean)];
  }
  return ["Macintosh HD", ...parent.split("/").filter(Boolean)];
}
