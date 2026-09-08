import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { boot } from "@ergatai/boot";
import { loadPlugins } from "./plugins";

const container = document.getElementById("root");

if (!container) {
  throw new Error("Missing #root element");
}

void loadPlugins()
  .then(plugins => boot(container, { plugins }))
  .catch((error: unknown) => {
    createRoot(container).render(
      <StrictMode>
        <pre>{error instanceof Error ? error.stack ?? error.message : String(error)}</pre>
      </StrictMode>,
    );
  });
