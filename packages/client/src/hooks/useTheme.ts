import { useEffect, useState } from "react";

const STORAGE_KEY = "convyio:theme";

export type Theme = "light" | "dark";

function storedTheme(): Theme | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === "light" || raw === "dark" ? raw : null;
  } catch {
    return null;
  }
}

/** Stored choice wins; otherwise light, whatever the OS prefers. */
export function initialTheme(): Theme {
  return storedTheme() ?? "light";
}

/**
 * Paints the theme by flipping one class on <html>; index.css re-points the
 * palette tokens from there. `color-scheme` comes along so browser-drawn UI
 * (form controls, the default scrollbar before ours applies) matches.
 */
export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.style.colorScheme = theme;
}

/**
 * Theme state for the toggle. main.tsx applies the boot theme before the first
 * render (no light flash on the login screen), so the effect here is only about
 * repainting and persisting later choices.
 */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useEffect(() => {
    applyTheme(theme);
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Private-mode storage denial: the theme still applies for this session.
    }
  }, [theme]);

  return {
    theme,
    toggleTheme: () => setTheme((prev) => (prev === "dark" ? "light" : "dark")),
  };
}
