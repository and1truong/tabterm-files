// Runtime helpers for module client halves (React-bound). The rest of this
// package is type-only; this file is the one runtime export, so modules that
// don't render UI never pull React in. `react` is externalized at module-build
// time (host import map provides it), exactly like any module component import.
import { createContext, useContext } from "react";
import type { Context } from "react";
import type { ClientHost } from "./client.ts";

export interface HostContext {
  HostCtx: Context<ClientHost | null>;
  useHost(): ClientHost;
}

// Build a module's host React context + hook. Replaces the per-module
// useHost.ts boilerplate (identical across modules bar the error label).
// `moduleId` is used only in the not-provided error so a missing
// <HostCtx.Provider> names the offending module.
export function createHostContext(moduleId: string): HostContext {
  const HostCtx = createContext<ClientHost | null>(null);
  function useHost(): ClientHost {
    const h = useContext(HostCtx);
    if (!h) throw new Error(`${moduleId}: HostCtx not provided`);
    return h;
  }
  return { HostCtx, useHost };
}
