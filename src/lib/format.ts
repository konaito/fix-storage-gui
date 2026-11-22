export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** YYYY-MM-DD in local time, or null. */
export function isoDate(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const two = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

const DAY = 24 * 3600 * 1000;

/** "今日", "3日前", "5か月前", "2年前". */
export function agoJa(ms: number | null | undefined, now = Date.now()): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const days = Math.max(0, Math.floor((now - ms) / DAY));
  if (days < 1) return "今日";
  if (days < 30) return `${days}日前`;
  if (days < 365) return `${Math.floor(days / 30.4)}か月前`;
  return `${Math.floor(days / 365)}年前`;
}
