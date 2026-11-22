/** macOS-like folder / document icons drawn in SVG (no image assets needed). */
export function FolderIcon({ size = 28, muted = false }: { size?: number; muted?: boolean }) {
  const top = muted ? "#9aa3ad" : "#6cc4ff";
  const body = muted ? "#b8c0c8" : "#3ba7f5";
  const shade = muted ? "#a6aeb6" : "#2b96e6";
  return (
    <svg width={size} height={size * 0.82} viewBox="0 0 64 52" aria-hidden="true" className="ico">
      <path d="M4 8a5 5 0 0 1 5-5h14l6 6h26a5 5 0 0 1 5 5v4H4z" fill={top} />
      <rect x="2" y="13" width="60" height="37" rx="5" fill={body} />
      <rect x="2" y="13" width="60" height="4" rx="2" fill={shade} opacity="0.6" />
    </svg>
  );
}

export function FileIcon({ size = 28, label, muted = false }: { size?: number; label?: string; muted?: boolean }) {
  return (
    <svg width={size * 0.8} height={size} viewBox="0 0 48 60" aria-hidden="true" className="ico">
      <path d="M4 4a4 4 0 0 1 4-4h24l12 12v44a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z" fill={muted ? "#c9cdd2" : "#f4f6f8"} />
      <path d="M32 0v8a4 4 0 0 0 4 4h8z" fill={muted ? "#aab0b6" : "#cfd6dd"} />
      {label && (
        <text x="24" y="44" textAnchor="middle" fontSize="11" fontWeight="700" fill={muted ? "#7a8087" : "#5b6b7a"} fontFamily="-apple-system, sans-serif">
          {label.slice(0, 4).toUpperCase()}
        </text>
      )}
    </svg>
  );
}

export function ItemIcon({ name, dir, size = 28, muted = false }: { name: string; dir: boolean; size?: number; muted?: boolean }) {
  if (dir) return <FolderIcon size={size} muted={muted} />;
  const dot = name.lastIndexOf(".");
  return <FileIcon size={size} muted={muted} label={dot > 0 ? name.slice(dot + 1) : undefined} />;
}
