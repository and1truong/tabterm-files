// Files explorer module — server half. Ports the read-only filesystem
// endpoints (ls/cat/raw) from the retired core /api/fs/* routes. Each helper
// is pure (URL in, Response out) so it is testable without the module host.

import type { ServerHost } from "@tabterm/module-host/server";
import { readdirSync, readFileSync, statSync, mkdirSync, renameSync, rmSync, existsSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { homedir } from "node:os";

// Resolve a `path` query param: ~ / ~/ expand to $HOME; must end absolute.
// Returns the normalized absolute path, or an error Response.
function resolvePath(url: URL): string | Response {
  const raw = (url.searchParams.get("path") ?? "").trim();
  let path = raw;
  if (!path || path === "~") path = homedir();
  else if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
  if (!isAbsolute(path)) return Response.json({ error: "path must be absolute" }, { status: 400 });
  return normalize(path);
}

// A safe single path segment: non-empty, no separators, not . or ..
export function validName(name: string): boolean {
  if (!name || name === "." || name === "..") return false;
  return !name.includes("/") && !name.includes("\\");
}

// Parse a JSON request body; null on malformed input.
async function parseMutationBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// Resolve a raw path string the same way resolvePath resolves the query param.
function resolvePathStr(raw0: string): string | null {
  const raw = (raw0 ?? "").trim();
  let path = raw;
  if (!path || path === "~") path = homedir();
  else if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
  if (!isAbsolute(path)) return null;
  return normalize(path);
}

// Create an empty file or a directory inside an existing parent directory.
// Body: { path: parentDir, name: basename, kind: "file" | "dir" }.
export async function fsCreate(req: Request): Promise<Response> {
  const body = await parseMutationBody(req);
  if (!body) return Response.json({ error: "bad request" }, { status: 400 });
  const parent = resolvePathStr(String(body.path ?? ""));
  if (!parent) return Response.json({ error: "path must be absolute" }, { status: 400 });
  const name = String(body.name ?? "");
  if (!validName(name)) return Response.json({ error: "invalid name" }, { status: 400 });
  const kind = body.kind === "dir" ? "dir" : "file";

  let stat;
  try { stat = statSync(parent); } catch { return Response.json({ error: "not found" }, { status: 404 }); }
  if (!stat.isDirectory()) return Response.json({ error: "not a directory" }, { status: 400 });

  const target = join(parent, name);
  if (existsSync(target)) return Response.json({ error: "already exists" }, { status: 409 });

  try {
    if (kind === "dir") mkdirSync(target);
    else await Bun.write(target, "");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "EACCES") return Response.json({ error: "permission denied" }, { status: 403 });
    return Response.json({ error: "create failed" }, { status: 400 });
  }
  return Response.json({ path: target });
}

// Rename an entry in place (same parent dir). Body: { path, name }.
export async function fsRename(req: Request): Promise<Response> {
  const body = await parseMutationBody(req);
  if (!body) return Response.json({ error: "bad request" }, { status: 400 });
  const src = resolvePathStr(String(body.path ?? ""));
  if (!src) return Response.json({ error: "path must be absolute" }, { status: 400 });
  const name = String(body.name ?? "");
  if (!validName(name)) return Response.json({ error: "invalid name" }, { status: 400 });

  try { statSync(src); } catch { return Response.json({ error: "not found" }, { status: 404 }); }

  const target = join(dirname(src), name);
  if (target === src) return Response.json({ path: src });
  if (existsSync(target)) return Response.json({ error: "already exists" }, { status: 409 });

  try {
    renameSync(src, target);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "EACCES") return Response.json({ error: "permission denied" }, { status: 403 });
    return Response.json({ error: "rename failed" }, { status: 400 });
  }
  return Response.json({ path: target });
}

// Move an entry to the OS Trash via the system `trash` binary; fall back to a
// hard recursive delete where the binary is unavailable. Body: { path }.
export async function fsDelete(req: Request): Promise<Response> {
  const body = await parseMutationBody(req);
  if (!body) return Response.json({ error: "bad request" }, { status: 400 });
  const path = resolvePathStr(String(body.path ?? ""));
  if (!path) return Response.json({ error: "path must be absolute" }, { status: 400 });
  if (path === "/" || path === homedir()) return Response.json({ error: "refusing to delete root" }, { status: 400 });

  try { statSync(path); } catch { return Response.json({ error: "not found" }, { status: 404 }); }

  let trashed = false;
  try {
    const proc = Bun.spawn(["trash", path], { stdout: "ignore", stderr: "ignore" });
    const code = await proc.exited;
    trashed = code === 0;
  } catch { /* binary missing — fall through to hard delete */ }

  if (!trashed) {
    try {
      rmSync(path, { recursive: true });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code === "EACCES") return Response.json({ error: "permission denied" }, { status: 403 });
      return Response.json({ error: "delete failed" }, { status: 400 });
    }
  }
  return Response.json({ path });
}

// List immediate children. Dirs before files, each alphabetical. Dotfiles
// hidden unless ?hidden=1; files included only with ?files=1.
export function fsLs(url: URL): Response {
  const path = resolvePath(url);
  if (path instanceof Response) return path;
  const showHidden = url.searchParams.get("hidden") === "1";
  const includeFiles = url.searchParams.get("files") === "1";

  let stat;
  try { stat = statSync(path); } catch { return Response.json({ error: "not found" }, { status: 404 }); }
  if (!stat.isDirectory()) return Response.json({ error: "not a directory" }, { status: 400 });

  let entries: { name: string; isDir: boolean }[] = [];
  try {
    const dirents = readdirSync(path, { withFileTypes: true })
      .filter((e) => (showHidden ? true : !e.name.startsWith(".")))
      .filter((e) => e.isDirectory() || (includeFiles && e.isFile()));
    const dirs = dirents.filter((e) => e.isDirectory())
      .map((e) => ({ name: e.name, isDir: true }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const files = dirents.filter((e) => !e.isDirectory())
      .map((e) => ({ name: e.name, isDir: false }))
      .sort((a, b) => a.name.localeCompare(b.name));
    entries = [...dirs, ...files];
  } catch {
    return Response.json({ error: "permission denied" }, { status: 403 });
  }

  const parent = path === "/" ? null : dirname(path);
  return Response.json({ path, parent, home: homedir(), entries });
}

// Read one text file for the preview pane. Caps at 256 KiB; rejects binary
// (NUL byte in the first 8 KiB) so the client can render it as plain text.
export function fsCat(url: URL): Response {
  const MAX = 256 * 1024;
  const path = resolvePath(url);
  if (path instanceof Response) return path;

  let stat;
  try { stat = statSync(path); } catch { return Response.json({ error: "not found" }, { status: 404 }); }
  if (!stat.isFile()) return Response.json({ error: "not a file" }, { status: 400 });
  if (stat.size > MAX) return Response.json({ error: `file is too large to preview (${stat.size} bytes)` }, { status: 413 });

  let buf: Buffer;
  try { buf = readFileSync(path); } catch { return Response.json({ error: "permission denied" }, { status: 403 }); }
  const sniff = buf.subarray(0, Math.min(buf.length, 8192));
  if (sniff.includes(0)) return Response.json({ error: "binary file" }, { status: 415 });
  return Response.json({ path, content: buf.toString("utf8"), size: stat.size });
}

// Stream raw bytes with a sniffed content-type, for image + HTML previews.
// Caps at 20 MiB.
export function fsRaw(url: URL): Response {
  const MAX = 20 * 1024 * 1024;
  const path = resolvePath(url);
  if (path instanceof Response) return path;

  let stat;
  try { stat = statSync(path); } catch { return Response.json({ error: "not found" }, { status: 404 }); }
  if (!stat.isFile()) return Response.json({ error: "not a file" }, { status: 400 });
  if (stat.size > MAX) return Response.json({ error: "file too large" }, { status: 413 });

  const file = Bun.file(path);
  return new Response(file, {
    headers: { "content-type": file.type || "application/octet-stream", "cache-control": "no-cache" },
  });
}

export default function activate(host: ServerHost): () => void {
  host.registerRoute("GET", "/ls", (req: Request) => fsLs(new URL(req.url)));
  host.registerRoute("GET", "/cat", (req: Request) => fsCat(new URL(req.url)));
  host.registerRoute("GET", "/raw", (req: Request) => fsRaw(new URL(req.url)));
  host.registerRoute("POST", "/create", (req: Request) => fsCreate(req));
  host.registerRoute("POST", "/rename", (req: Request) => fsRename(req));
  host.registerRoute("POST", "/delete", (req: Request) => fsDelete(req));
  return () => {};
}
