import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { fetchServerRuntimeProfile } from "@selftune/dashboard-core/host";
import "@fontsource-variable/geist";
import { App } from "./App";

import "./styles.css";

document.documentElement.dataset.brand =
  new URLSearchParams(window.location.search).get("brand") === "loom" ? "loom" : "growth";

if (window.selftuneDesktop && navigator.platform.includes("Mac")) {
  document.documentElement.classList.add("selftune-desktop-macos");
}

const runtime = await fetchServerRuntimeProfile(window.fetch.bind(window), window.location.origin);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App runtime={runtime} />
  </StrictMode>,
);
