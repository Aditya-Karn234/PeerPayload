// Theme preference: "system" (follow the OS), "light" or "dark". Stored
// per window in localStorage and applied as [data-theme] on <html>, which
// theme.css keys off. Call applyStoredTheme() before the first render to
// avoid a flash of the wrong theme.

const KEY = "theme";

export function getThemePreference() {
  try {
    const stored = localStorage.getItem(KEY);

    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

export function setThemePreference(preference) {
  try {
    if (preference === "light" || preference === "dark")
      localStorage.setItem(KEY, preference);
    else
      localStorage.removeItem(KEY);
  } catch {
    // storage unavailable: applies for this session only
  }

  applyTheme(preference);
}

export function applyTheme(preference) {
  if (preference === "light" || preference === "dark")
    document.documentElement.setAttribute("data-theme", preference);
  else
    document.documentElement.removeAttribute("data-theme");
}

export function applyStoredTheme() {
  applyTheme(getThemePreference());
}
