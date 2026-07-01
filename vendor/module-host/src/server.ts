// Server-side host contract. No React — server halves never touch the DOM.
import type { Database } from "bun:sqlite";

export type RouteHandler = (req: Request, params: Record<string, string>) => Response | Promise<Response>;
export type RpcHandler = (params: unknown) => unknown | Promise<unknown>;

export interface Migration { v: number; up: (db: Database) => void }

// The subset of JSON Schema the host's built-in validator understands. Modules
// declare their config shape with this via host.settings.define(). Supported
// keywords: type, properties, required, enum, items, default, and the numeric
// (minimum/maximum) + string (minLength/maxLength) + array (minItems/maxItems)
// bounds. On validation, a field that fails is replaced by its schema `default`
// (or the current value); unknown keywords are ignored. Not full JSON Schema.
export interface JsonSchema {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean";
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
}

// An Effect is produced by host.sync.* and returned from an onMessage handler.
// Its internals are core-private; modules treat it as an opaque token.
export type Effect = unknown;

export interface ModuleCallContext { moduleId: string }
export type ModuleMessageHandler = (msg: any, ctx: ModuleCallContext) => Effect[];

// A connected client socket, opaque to the module. Stable identity for the
// life of the connection; the module never touches the raw socket.
export interface Peer {
  id: string;                 // stable per-connection key
  send(msg: unknown): void;   // emits a module:event to THIS socket only
}

// Passed into a room's poll/onJoin/onRequest, scoped to one key.
export interface RoomContext {
  key: string;
  push(msg: unknown): void;   // fan out a module:event to this key's subscribers
}

export interface RoomSpec {
  prefixes: string[];                 // message types this room owns, e.g. ["git"]
  keyOf(msg: any): string | null;     // extract the room key from a message
  subscribeType: string;              // e.g. "git:subscribe"
  unsubscribeType: string;            // e.g. "git:unsubscribe"
  // Host-owned poll loop. Runs while the key has >=1 subscriber; starts on
  // first join, stops on last leave. A non-undefined return is pushed verbatim
  // to the key's subscribers (the module shapes its own message, e.g. one with
  // a `type` field). Returning undefined means "nothing to push this tick".
  poll?: (ctx: RoomContext) => unknown | Promise<unknown>;
  pollMs?: number;                    // required iff poll is set
  onJoin?: (ctx: RoomContext, peer: Peer) => void | Promise<void>;
  onRequest?: (ctx: RoomContext, msg: any, peer: Peer) => void | Promise<void>;
  onIdle?: (key: string) => void;     // fires when a key's last subscriber leaves
}

export interface ServerHost {
  id: string;
  // Absolute path to the host's data/config directory. Modules store files
  // under it (e.g. join(dataDir, "uploads")). Same dir core uses.
  dataDir: string;
  registerRoute(method: string, path: string, handler: RouteHandler): void;
  // An RPC that MUTATES shared state must broadcast the new state before
  // returning — don't rely on the return value to update the UI. The client's
  // host.rpc.call return is for one-off reads; live UI reflects state from
  // host.events.on(event), which only fires from broadcast(). A mutator that
  // returns the new state but skips broadcast() leaves every client (including
  // the caller) stale until it re-reads — e.g. on refresh. See broadcast below.
  registerRpc(method: string, handler: RpcHandler): void;
  // Fan a `module:event` out to ALL clients (including the action's originator;
  // see ws.ts broadcast()). This is the ONLY live-update path: the client mirror
  // is host.events.on(event, …). So every state change a client should see live
  // — RPC mutations, scheduled/timer-driven changes — must broadcast() the new
  // state. Broadcasting only on some transitions (e.g. an auto-advance but not a
  // manual start/stop) is the classic bug: those untriggered changes appear only
  // after a refresh re-reads via a getState RPC.
  broadcast(event: string, payload: unknown): void;
  kv: {
    get(key: string): unknown;
    set(key: string, value: unknown): void;
  };
  // Schema-validated, single-object config for this module (module_settings
  // table). One config blob per module, versioned (OCC). Prefer this over kv
  // for a module's user-facing settings: the host validates every write against
  // the declared schema and exposes the schema to clients for rendering a UI.
  settings: {
    // Declare the config's JSON Schema and its default. Seeds the stored config
    // with `def` on first boot (never clobbers an existing row). The schema is
    // retained for write-validation and client exposure. Call once in activate().
    define(schema: JsonSchema, def: unknown): void;
    // The current stored config (validated/coerced against the schema).
    get(): unknown;
    // Merge+validate a patch onto the current config, persist, broadcast the new
    // config to all clients, and return it. Invalid fields fall back per-field.
    set(patch: unknown): unknown;
    // The declared schema (null until define() runs).
    schema(): JsonSchema | null;
  };
  // Shared SQLite handle. The module owns its own tables via migrate().
  db: Database;
  migrate(migrations: Migration[]): void;
  // Receive client messages whose type begins with one of `prefixes`. The
  // handler returns sync effects (host.sync.*) the core router plays.
  onMessage(prefixes: string[], handler: ModuleMessageHandler): () => void;
  // Sender-aware sync. set/del broadcast a module:patch to all clients;
  // toSender unicasts to the originating socket only (OCC conflict replies).
  sync: {
    set(entity: string, data: unknown): Effect;
    del(entity: string, id: string): Effect;
    toSender(msg: unknown): Effect;
  };
  log(...args: unknown[]): void;
  schedule(delayMs: number, cb: () => void): () => void;
  interval(ms: number, cb: () => void): () => void;
  now(): number;
  workspaces: { get(id: string): { id: string; cwd: string } | null };
  room(id: string, spec: RoomSpec): () => void;
}

export type ServerModule = (host: ServerHost) => void | (() => void);
