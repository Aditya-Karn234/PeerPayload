import { useEffect, useState } from "react";

function getStoredTheme() {
  const stored = localStorage.getItem("theme");

  return stored === "light" || stored === "dark" ? stored : null;
}

// Dark mode is a selected state, not an automatic flip: this toggle sets
// [data-theme] on <html>, which the palette's CSS variables key off of —
// the OS preference still applies until the user picks one. Works
// unchanged inside an Electron renderer (it's still just a Chromium page
// with localStorage) as well as a browser tab.
export default function ThemeToggle() {
  const [theme, setTheme] = useState(getStoredTheme);

  useEffect(() => {
    if (theme) {
      document.documentElement.setAttribute("data-theme", theme);
      localStorage.setItem("theme", theme);
    } else {
      document.documentElement.removeAttribute("data-theme");
      localStorage.removeItem("theme");
    }
  }, [theme]);

  const systemPrefersDark =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;

  const isDark = theme ? theme === "dark" : systemPrefersDark;

  return (
    <button
      type="button"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      className="rounded-md border p-2"
      style={{ borderColor: "var(--color-border)", color: "var(--color-ink-secondary)" }}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
    >
      {isDark ? (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="8" cy="8" r="3.5" />
          <path d="M8 1v1.5M8 13.5V15M15 8h-1.5M2.5 8H1M12.7 3.3l-1 1M4.3 11.7l-1 1M12.7 12.7l-1-1M4.3 4.3l-1-1" strokeLinecap="round" />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M13.5 9.5A6 6 0 0 1 6.5 2.5a6 6 0 1 0 7 7Z" />
        </svg>
      )}
    </button>
  );
}
