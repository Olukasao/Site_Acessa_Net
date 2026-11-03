import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "@fontsource-variable/sora";
import "@fontsource-variable/manrope";
import "./styles/tokens.css";
import "./styles/base.css";
import App from "./App.jsx";
import RouteErrorBoundary from "./components/RouteErrorBoundary.jsx";
import { installErrorReporter } from "./lib/errorReporter.js";

// Só no site publicado: em desenvolvimento os erros ficam no console.
if (import.meta.env.PROD) installErrorReporter();

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <BrowserRouter>
      <RouteErrorBoundary>
        <App />
      </RouteErrorBoundary>
    </BrowserRouter>
  </StrictMode>
);
