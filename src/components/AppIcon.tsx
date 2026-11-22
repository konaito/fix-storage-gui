import appIcon from "../../app-icon.png";

/** The app's real icon (same artwork as src-tauri/icons and the Dock), for the header and the login screen. */
export function AppIcon({ className = "app-icon", size }: { className?: string; size?: number }) {
  return <img className={className} src={appIcon} alt="" aria-hidden="true" width={size} height={size} draggable={false} />;
}
