import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { applyStoredTheme } from "@peerpayload/ui";

// Bundled, so they work offline and within the page's security policy.
import "@fontsource-variable/inter";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "./index.css";
import App from "./App.jsx";

// Before the first render, so the saved theme shows from the start.
applyStoredTheme();

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
