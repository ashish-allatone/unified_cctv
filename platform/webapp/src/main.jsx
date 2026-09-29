import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "leaflet/dist/leaflet.css";
import "./styles.css";
import App from "./App.jsx";
import { I18nProvider } from "./lib/i18n.jsx";
import { UIProvider } from "./lib/ui.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <I18nProvider>
      <UIProvider>
        <App />
      </UIProvider>
    </I18nProvider>
  </StrictMode>,
);
