import { useState } from "react";
import { store } from "../lib/api.js";
import { ICONS } from "../nav.jsx";

export function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  store.set("uvp-theme", t);
  window.dispatchEvent(new Event("uvp-theme"));   // Leaflet maps re-measure
}

export default function ThemeToggle() {
  const [theme, setTheme] = useState(document.documentElement.getAttribute("data-theme") || "dark");
  const toggle = () => { const t = theme === "light" ? "dark" : "light"; applyTheme(t); setTheme(t); };
  const title = theme === "dark" ? "Switch to light theme" : "Switch to dark theme";
  return <button className="btn ghost icon theme-toggle" type="button" title={title} aria-label="Switch theme" onClick={toggle}>
    <span className="ico-sun">{ICONS.sun}</span><span className="ico-moon">{ICONS.moon}</span>
  </button>;
}
