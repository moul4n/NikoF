import React from "react";
import { createRoot } from "react-dom/client";
import { App, type SurfaceMode } from "./app/App";
import "./styles.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root mount element '#root' was not found.");
}

function resolveSurfaceModeFromPath(pathname: string): SurfaceMode | null {
  const normalizedPath = pathname.replace(/\/+$/, "");

  if (normalizedPath.endsWith("/display")) {
    return "display";
  }

  if (normalizedPath.endsWith("/control")) {
    return "control";
  }

  return null;
}

function resolveCanonicalSurfacePath(pathname: string): string | null {
  const surfaceMode = resolveSurfaceModeFromPath(pathname);

  if (!surfaceMode) {
    return null;
  }

  const normalizedPath = pathname.replace(/\/+$/, "");
  const canonicalPath = `${normalizedPath}/`;

  return pathname === canonicalPath ? null : canonicalPath;
}

function resolveSurfaceMode(): SurfaceMode {
  const surfaceModeFromPath = resolveSurfaceModeFromPath(window.location.pathname);

  if (surfaceModeFromPath) {
    return surfaceModeFromPath;
  }

  const declaredSurfaceMode = document.body.dataset.surfaceMode;

  if (declaredSurfaceMode === "control" || declaredSurfaceMode === "display") {
    return declaredSurfaceMode;
  }

  return "control";
}

const canonicalSurfacePath = resolveCanonicalSurfacePath(window.location.pathname);

if (canonicalSurfacePath) {
  window.location.replace(`${canonicalSurfacePath}${window.location.search}${window.location.hash}`);
} else {
  const surfaceMode = resolveSurfaceMode();

  document.body.dataset.surfaceMode = surfaceMode;
  rootElement.dataset.surfaceMode = surfaceMode;

  createRoot(rootElement).render(<App surfaceMode={surfaceMode} />);
}