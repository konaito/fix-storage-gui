// Browser stand-ins for the few Node APIs the vendored fix-storage core uses.
// fix-storage-gui is macOS-only, so IS_MAC is fixed to true.
export const IS_MAC = true;

/** Same shape as fix-storage's src/core/scan.ts Item. */
export interface Item {
  path: string;
  size: number;
  dir?: boolean;
}

/** Not used in the GUI (roots are computed in Rust); kept so categories.ts compiles unchanged. */
export function homedir(): string {
  return "/";
}

export function join(...parts: string[]): string {
  return parts
    .filter((p) => p !== "")
    .join("/")
    .replace(/\/{2,}/g, "/");
}

export function basename(path: string): string {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
  const i = trimmed.lastIndexOf("/");
  return i < 0 ? trimmed : trimmed.slice(i + 1);
}

/** Node's path.extname semantics: ".bashrc" -> "", "a.tar.gz" -> ".gz", "a." -> ".". */
export function extname(path: string): string {
  const base = basename(path);
  const i = base.lastIndexOf(".");
  if (i <= 0) return "";
  return base.slice(i);
}
