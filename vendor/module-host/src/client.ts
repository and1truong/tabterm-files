import type { ComponentType, ReactNode } from "react";
import type { JsonSchema } from "./server.ts";

// Registration payloads — module-author facing (the host injects moduleId).
// Shapes mirror src/client/modules/registries.ts exactly.
export interface RailPage { id: string; icon: ReactNode; label: string; component: ComponentType<any> }
export interface SidebarPanel { id: string; icon: ReactNode; label: string; component: ComponentType<any> }
// `visible` lets an action gate itself (e.g. show only on the session view).
// The host filters on it; omitted → always shown.
export interface TabBarAction { id: string; icon: ReactNode; tooltip: string; onClick: () => void; visible?: () => boolean }
export interface HeaderItem { id: string; component: ComponentType<any> }
export type FooterItem = HeaderItem;
export interface FloatingBox { id: string; component: ComponentType<any> }
// `visible` lets a panel declare when it has anything to show. The host gates the
// right column on it, so a panel that renders nothing (e.g. session notes with no
// active session) collapses the column instead of reserving empty width. Omitted →
// always visible.
export interface RightPanelSpec { id: string; component: ComponentType<any>; visible?: () => boolean }
export interface ToolsMenuItem { id: string; icon: ReactNode; label: string; onClick: () => void }
export interface ModalSpec { id: string; component: ComponentType<any> }
export interface PaletteAction { id: string; title: string; run: () => void }
// A global keyboard shortcut. The Cmd/Ctrl modifier is implied (all host
// shortcuts are mod-based); `key` is the lowercase `KeyboardEvent.key` (e.g.
// "p"), `shift` requires the Shift modifier. The host calls `run` and prevents
// default when the combo matches, before its own built-in shortcuts.
export interface ShortcutSpec { id: string; key: string; shift?: boolean; run: () => void }

export interface ThemeInfo {
  mode: "dark" | "light";
  accent: string;
  colors: Record<string, string>;
}

export interface ModuleContext {
  workspaceId: string | null;
  sessionId: string | null;
  cwd: string | null;
  label: string | null;
  focusEpoch: number;
  // The active module rail page (Files, Git, …), or null on the session view.
  // Non-null means the main area shows a rail page, not the session terminal —
  // session-scoped right panels (e.g. notes) gate on null so they only show on
  // the session view.
  activeModuleView: string | null;
}

// A curated, stable projection of core app state for modules to select from.
// NOT the raw store: only contract-worthy fields appear here, so the host can
// refactor internals (session buffers, transient UI flags) without breaking
// modules. Each select()/watch() runs a module-supplied selector against this.
export interface AppReadModel {
  activeWorkspaceId: string | null;
  activeSessionId: string | null;
  focusEpoch: number;
  theme: { mode: "dark" | "light" };
  // Open shape so modules read whatever fields they need without the contract
  // enumerating the full core Session/PrimaryTab/settings/serverConfig.
  workspaces: Record<string, { id: string; label: string; cwd: string; [k: string]: any }>;
  sessions: Record<string, { id: string; primaryTabId: string; label: string; [k: string]: any }>;
  settings: Record<string, any>;
  serverConfig: Record<string, any>;
}

// Compare two selected values; return true when equal (callback NOT fired).
// Defaults to Object.is. Pass a shallow-equal fn when a selector returns a fresh
// object/array each call, or it will fire on every store mutation.
export type EqualityFn<T> = (a: T, b: T) => boolean;

// Ready-made equality for select()/watch() when a selector returns a fresh
// object each call (the common multi-field case). Compares own enumerable keys
// one level deep with Object.is.
export function shallowEqual<T extends Record<string, unknown>>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (a == null || b == null) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.is(a[k], b[k]));
}

// A single value or an array of them. Each UI slot in UIElements accepts one
// spec, or several when a module mounts more than one thing in the same slot
// (e.g. the timer mounts a Timers box AND an Alarms box, two headerItem chips).
type OneOrMany<T> = T | T[];

// The visual surfaces a module can mount, keyed by slot. Pass any subset to
// registerUI(); omitted slots register nothing. Every value is a spec or an
// array of specs (OneOrMany) so one call can mount duplicates of a slot. These
// are the chrome surfaces only — command/keyboard bindings (paletteAction,
// shortcut) are NOT here; they have their own register* methods below because
// they're behaviours, not rendered elements.
export interface UIElements {
  // Left mode-rail page (⌘1–⌘5), the most common slot — most modules mount one.
  railPage?: OneOrMany<RailPage>;
  // A collapsible panel in the workspace sidebar.
  sidebarPanel?: OneOrMany<SidebarPanel>;
  // An icon button in the workspace tab bar.
  tabBarAction?: OneOrMany<TabBarAction>;
  // A widget pinned in the top chrome (e.g. the timer's pomodoro/alarm chips).
  headerItem?: OneOrMany<HeaderItem>;
  // Same shape as headerItem but rendered in the bottom chrome.
  footerItem?: OneOrMany<FooterItem>;
  // A draggable floating box toggled via toggleFloatingBox(id).
  floatingBox?: OneOrMany<FloatingBox>;
  // The right-hand panel column; `visible()` gates whether the column shows.
  rightPanel?: OneOrMany<RightPanelSpec>;
  // An entry in the Tools (…) menu.
  toolsMenuItem?: OneOrMany<ToolsMenuItem>;
  // A modal dialog, opened/closed imperatively via openModal/closeModal(id).
  modal?: OneOrMany<ModalSpec>;
}

export interface ClientHost {
  id: string;
  config: unknown;
  ui: {
    // Mount one or more UI elements in a single call and get ONE teardown back:
    // calling the returned fn unregisters everything this call registered, in
    // reverse order. Replaces the former per-slot register* methods so a module
    // declares its whole chrome footprint as one object and tracks one cleanup
    // instead of N. Pass an array for a slot to mount several (see OneOrMany).
    //   const off = host.ui.registerUI({
    //     railPage: { id, icon, label, component },
    //     headerItem: [chip, pomo],
    //   });
    //   return off; // in activate's cleanup
    registerUI(elements: UIElements): () => void;
    // Show/hide a registered floatingBox by id (imperative, not a registration).
    toggleFloatingBox(id: string): void;
    // Open/close a registered modal by id (imperative, not a registration).
    openModal(id: string): void;
    closeModal(id: string): void;
    // Command-palette action and global keyboard shortcut. These are behaviours,
    // not rendered chrome, so they stay as standalone registrars (each returns
    // its own teardown) rather than living under registerUI's element map.
    registerPaletteAction(p: PaletteAction): () => void;
    registerShortcut(p: ShortcutSpec): () => void;
  };
  // Subscribe to a server module:event (the matching host.broadcast on the
  // server). This is the live-update path: render from what arrives here, not
  // from an rpc.call return. Typical pattern — seed once with a getState rpc,
  // then keep the view in sync via events.on; never trust a mutator RPC's return
  // to update the UI (other devices wouldn't see it, and a server that forgets
  // to broadcast that transition leaves you stale until refresh).
  events: { on(event: string, cb: (payload: unknown) => void): () => void };
  theme: { current(): ThemeInfo; subscribe(cb: (t: ThemeInfo) => void): () => void };
  context: {
    active(): ModuleContext;
    subscribe(cb: (c: ModuleContext) => void): () => void;
    // Reactively select a slice of core app state (React-bound via
    // useSyncExternalStore). Re-renders only when the selected value changes
    // per `eq` (default Object.is) — a module selecting `s => s.settings.showSidebar`
    // ignores unrelated mutations (PTY frames, focus epochs, etc.).
    select<T>(selector: (s: AppReadModel) => T, eq?: EqualityFn<T>): T;
    // Imperative variant: invokes `cb` with the new value whenever the selected
    // slice changes per `eq`. Returns a deregister fn. Does NOT fire on subscribe.
    watch<T>(selector: (s: AppReadModel) => T, cb: (value: T) => void, eq?: EqualityFn<T>): () => void;
  };
  actions: {
    createSession(opts: { primaryTabId: string; label: string; kind?: string }): void;
    setActiveView(tabId: string, viewId: string): void;
    toast(message: string): void;
    openPalette(): void;
    playChime(soundId: string, volume: number): void;
    notify(opts: { title: string; body?: string }): void;
    attention(sessionId: string): void;
  };
  kv: {
    get(key: string): unknown;
    set(key: string, value: unknown): void;
    subscribe(key: string, cb: (v: unknown) => void): () => void;
  };
  // Schema-validated module config (server-side module_settings). Mirror of the
  // server's host.settings: get the current config, set a patch (server merges,
  // validates against the declared schema, persists, and broadcasts the result),
  // subscribe to changes, and read the declared JSON Schema (for rendering a
  // config UI). The config is available at mount (seeded from the init payload).
  settings: {
    get(): unknown;
    set(patch: unknown): void;
    subscribe(cb: (config: unknown) => void): () => void;
    schema(): JsonSchema | null;
  };
  store: {
    use<T>(selector: (s: Record<string, Record<string, any>>) => T): T;
    getState(): Record<string, Record<string, any>>;
    setState(fn: (s: Record<string, Record<string, any>>) => Record<string, Record<string, any>>): void;
    patch(p: { entity: string; op: "set" | "delete"; data?: any; id?: string }): void;
  };
  sessions: {
    // Mirrors core Session: { id, primaryTabId, label, ... }. Open shape so the
    // module reads whatever fields it needs without the type package enumerating
    // the full core Session.
    list(): Array<{ id: string; primaryTabId: string; label: string; [k: string]: any }>;
    get(id: string): { id: string; label: string; [k: string]: any } | null;
  };
  workspaces: {
    get(id: string): { id: string; label: string; cwd: string; [k: string]: any } | null;
    setCwd(id: string, path: string): void;
  };
  serverConfig: {
    get<T = unknown>(key: string): T;
  };
  // Call a server registerRpc handler. Best for one-off reads (e.g. getState on
  // mount). For state a mutation should update live, ignore the return and let
  // events.on deliver the new state — the server broadcasts it to every client.
  rpc: { call(method: string, params?: unknown): Promise<any> };
  // Send a message to the server over the shared WebSocket. Accepts any
  // module-defined message shape (e.g. NoteClientMessage). The server routes
  // by the message's `type` prefix via the module's onMessage handler.
  send(msg: Record<string, unknown>): void;
  // Offline send-queue control. While the socket is down, sent messages buffer
  // and flush on reconnect. registerCollapse lets a module drop superseded
  // queued messages of its own (e.g. collapse a burst of note:update edits to
  // one write per field). `fn(existing, incoming)` returns true when `existing`
  // is superseded by `incoming` and should be dropped. Returns a deregister fn.
  outbox: {
    registerCollapse(fn: (existing: any, incoming: any) => boolean): () => void;
  };
}

export type ClientModule = (host: ClientHost) => void | (() => void);
