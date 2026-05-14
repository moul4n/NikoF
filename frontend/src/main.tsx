import React from "react";
import { createRoot } from "react-dom/client";
import { App, type SurfaceMode } from "./app/App";
import "./styles.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root mount element '#root' was not found.");
}

function resolveSurfaceModeFromPath(pathname: string): SurfaceMode {
  const normalizedPath = pathname.replace(/\/+$/, "");

  return normalizedPath.endsWith("/display") ? "display" : "control";
}

function resolveSurfaceMode(): SurfaceMode {
  const declaredSurfaceMode = document.body.dataset.surfaceMode;

  if (declaredSurfaceMode === "control" || declaredSurfaceMode === "display") {
    return declaredSurfaceMode;
  }

  return resolveSurfaceModeFromPath(window.location.pathname);
}

const surfaceMode = resolveSurfaceMode();

document.body.dataset.surfaceMode = surfaceMode;
rootElement.dataset.surfaceMode = surfaceMode;

createRoot(rootElement).render(<App surfaceMode={surfaceMode} />);