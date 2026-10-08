export type Theme = "dark" | "light";
export function getTheme(): Theme { return (document.documentElement.getAttribute("data-theme") as Theme) || "dark"; }
export function setTheme(t: Theme) { document.documentElement.setAttribute("data-theme", t); try { localStorage.setItem("uvp-theme", t); } catch { /* */ } }
export function toggleTheme(): Theme { const t: Theme = getTheme() === "dark" ? "light" : "dark"; setTheme(t); return t; }
