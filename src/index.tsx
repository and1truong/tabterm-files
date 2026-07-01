import type { ClientHost } from "@tabterm/module-host/client";
import { shallowEqual } from "@tabterm/module-host/client";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  ChevronDown, ChevronRight, Code2, Eye, EyeOff, File as FileIcon,
  Folder, FolderOpen, FolderTree, Pencil, Pin, RefreshCw, Search, Trash2, X,
} from "lucide-react";
import hljs from "highlight.js/lib/common";
import makefile from "highlight.js/lib/languages/makefile";
import { marked } from "marked";

hljs.registerLanguage("makefile", makefile);

// ---------------------------------------------------------------------------
// API base — module routes. raw/cat URLs are also used directly in <img>/<iframe>.
// ---------------------------------------------------------------------------
const API = "/api/modules/files/r";
const rawUrl = (path: string) => `${API}/raw?path=${encodeURIComponent(path)}`;

// ---------------------------------------------------------------------------
// fileColor — inlined from the retired src/client/fileIcon.ts
// ---------------------------------------------------------------------------
const COLOR_BY_EXT: Record<string, string> = {
  ts: "text-[var(--accent)]", tsx: "text-[var(--accent)]",
  js: "text-[var(--orange)]", jsx: "text-[var(--orange)]", mjs: "text-[var(--orange)]", cjs: "text-[var(--orange)]",
  json: "text-[var(--green)]", yml: "text-[var(--green)]", yaml: "text-[var(--green)]",
  md: "text-[var(--muted)]", markdown: "text-[var(--muted)]",
  css: "text-[var(--accent-soft)]", scss: "text-[var(--accent-soft)]", html: "text-[var(--orange)]",
  png: "text-[var(--green)]", jpg: "text-[var(--green)]", jpeg: "text-[var(--green)]",
  gif: "text-[var(--green)]", svg: "text-[var(--green)]", webp: "text-[var(--green)]",
};
function fileColor(name: string): string {
  const ext = name.includes(".") ? (name.split(".").pop() as string).toLowerCase() : "";
  return COLOR_BY_EXT[ext] ?? "text-[var(--faint)]";
}

// ---------------------------------------------------------------------------
// File-tab reducer — inlined from the retired src/client/filesTabs.ts.
// Per-workspace state persisted in localStorage keyed by workspaceId.
// ---------------------------------------------------------------------------
interface FileTab { path: string; preview: boolean }
interface FilesTabsState { open: FileTab[]; activeIndex: number }
type FilesTabsAction =
  | { type: "openPreview"; path: string }
  | { type: "openPinned"; path: string }
  | { type: "activate"; index: number }
  | { type: "close"; index: number }
  | { type: "pin"; index: number };

const tabsKey = (wsId: string) => `tabterm-files-module-${wsId}`;
function loadTabs(wsId: string): FilesTabsState {
  try {
    const raw = localStorage.getItem(tabsKey(wsId));
    if (raw) {
      const p = JSON.parse(raw) as FilesTabsState;
      if (Array.isArray(p.open)) return { open: p.open, activeIndex: p.activeIndex ?? -1 };
    }
  } catch {}
  return { open: [], activeIndex: -1 };
}
function saveTabs(wsId: string, s: FilesTabsState) {
  try { localStorage.setItem(tabsKey(wsId), JSON.stringify(s)); } catch {}
}

function reduceTabs(state: FilesTabsState, action: FilesTabsAction): FilesTabsState {
  switch (action.type) {
    case "openPreview": {
      const existing = state.open.findIndex((t) => t.path === action.path);
      if (existing >= 0) return { ...state, activeIndex: existing };
      // Replace the current preview tab (if any) — only one preview tab at a time.
      const previewIdx = state.open.findIndex((t) => t.preview);
      const tab: FileTab = { path: action.path, preview: true };
      if (previewIdx >= 0) {
        const open = [...state.open];
        open[previewIdx] = tab;
        return { open, activeIndex: previewIdx };
      }
      return { open: [...state.open, tab], activeIndex: state.open.length };
    }
    case "openPinned": {
      const existing = state.open.findIndex((t) => t.path === action.path);
      if (existing >= 0) {
        const open = state.open.map((t, i) => (i === existing ? { ...t, preview: false } : t));
        return { open, activeIndex: existing };
      }
      return { open: [...state.open, { path: action.path, preview: false }], activeIndex: state.open.length };
    }
    case "activate":
      return { ...state, activeIndex: action.index };
    case "pin":
      return { ...state, open: state.open.map((t, i) => (i === action.index ? { ...t, preview: false } : t)) };
    case "close": {
      const open = state.open.filter((_, i) => i !== action.index);
      let activeIndex = state.activeIndex;
      if (action.index === state.activeIndex) activeIndex = Math.min(action.index, open.length - 1);
      else if (action.index < state.activeIndex) activeIndex -= 1;
      return { open, activeIndex };
    }
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Tree types + helpers (ported from WorkspaceFilesList.tsx)
// ---------------------------------------------------------------------------
interface LsEntry { name: string; isDir: boolean }
interface LsResponse { path: string; parent: string | null; home: string; entries: LsEntry[]; error?: string }
interface TreeNode { name: string; path: string; isDir: boolean; loaded: boolean; children: TreeNode[] }

function childPath(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}
// Mirror of the server's name rule — pre-flight UI validation.
export function validName(name: string): boolean {
  if (!name || name === "." || name === "..") return false;
  return !name.includes("/") && !name.includes("\\");
}

// The directory whose listing changed and must be refetched after a mutation.
export function affectedParent(op: "create" | "rename" | "delete", targetDir: string, path: string): string {
  if (op === "create") return targetDir;
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

function toNodes(dir: string, entries: LsEntry[]): TreeNode[] {
  return entries.map((e) => ({ name: e.name, path: childPath(dir, e.name), isDir: e.isDir, loaded: false, children: [] }));
}
function patchNode(node: TreeNode, path: string, fn: (n: TreeNode) => TreeNode): TreeNode {
  if (node.path === path) return fn(node);
  let changed = false;
  const children = node.children.map((c) => {
    if (path === c.path || path.startsWith(c.path + "/")) {
      const next = patchNode(c, path, fn);
      if (next !== c) { changed = true; return next; }
    }
    return c;
  });
  return changed ? { ...node, children } : node;
}
async function fetchDir(path: string, hidden: boolean): Promise<LsResponse> {
  const res = await fetch(`${API}/ls?path=${encodeURIComponent(path)}&files=1${hidden ? "&hidden=1" : ""}`);
  return (await res.json()) as LsResponse;
}

// ---------------------------------------------------------------------------
// FilesTree (ported WorkspaceFilesList — cwd now comes via prop, not store)
// ---------------------------------------------------------------------------
function FilesTree({ cwd, activePath, onOpen }: {
  cwd: string;
  activePath: string | null;
  onOpen: (path: string, mode: "preview" | "pin") => void;
}) {
  const [root, setRoot] = useState<TreeNode | null>(null);
  const [home, setHome] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // Right-click menu: anchored at (x,y), acting on `node` (null = tree root bg).
  const [menu, setMenu] = useState<{ x: number; y: number; node: TreeNode | null } | null>(null);
  // Inline editor: creating in `dir` (kind set) or renaming `node`. value = input text.
  const [editor, setEditor] = useState<
    | { mode: "create"; dir: string; kind: "file" | "dir"; value: string; error: string | null }
    | { mode: "rename"; node: TreeNode; value: string; error: string | null }
    | null
  >(null);
  // Delete confirm for a node.
  const [confirmDel, setConfirmDel] = useState<TreeNode | null>(null);

  useEffect(() => {
    let cancelled = false;
    setExpanded(new Set());
    setError(null);
    void (async () => {
      try {
        const data = await fetchDir(cwd || "~", showHidden);
        if (cancelled) return;
        setHome(data.home);
        if (data.error) { setError(data.error); setRoot(null); return; }
        setRoot({
          name: data.path === data.home ? "~" : data.path.split("/").pop() || data.path,
          path: data.path, isDir: true, loaded: true, children: toNodes(data.path, data.entries),
        });
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "request failed");
      }
    })();
    return () => { cancelled = true; };
  }, [cwd, showHidden, reloadKey]);

  const toggleExpand = useCallback(async (node: TreeNode) => {
    if (!node.isDir) return;
    const willOpen = !expanded.has(node.path);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (willOpen) next.add(node.path); else next.delete(node.path);
      return next;
    });
    if (willOpen && !node.loaded) {
      try {
        const data = await fetchDir(node.path, showHidden);
        if (data.error) return;
        setRoot((cur) => cur ? patchNode(cur, node.path, (n) => ({ ...n, loaded: true, children: toNodes(node.path, data.entries) })) : cur);
      } catch { /* leave unloaded */ }
    }
  }, [expanded, showHidden]);

  const refreshDir = useCallback(async (dirPath: string) => {
    try {
      const data = await fetchDir(dirPath, showHidden);
      if (data.error) return;
      setRoot((cur) => {
        if (!cur) return cur;
        if (cur.path === dirPath) return { ...cur, loaded: true, children: toNodes(dirPath, data.entries) };
        return patchNode(cur, dirPath, (n) => ({ ...n, loaded: true, children: toNodes(dirPath, data.entries) }));
      });
      setExpanded((prev) => { const next = new Set(prev); next.add(dirPath); return next; });
    } catch { /* leave tree as-is on refetch failure */ }
  }, [showHidden]);

  const mutate = useCallback(async (
    kind: "create" | "rename" | "delete",
    body: Record<string, unknown>,
  ): Promise<{ ok: true; path: string } | { ok: false; error: string }> => {
    try {
      const res = await fetch(`${API}/${kind}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { path?: string; error?: string };
      if (!res.ok) return { ok: false, error: data.error ?? `request failed (${res.status})` };
      return { ok: true, path: data.path ?? "" };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "request failed" };
    }
  }, []);

  // For New File/Folder: the dir to create in. Folder node → itself; file → parent; bg → root.
  const createDirFor = useCallback((node: TreeNode | null): string => {
    if (!node) return root?.path ?? cwd;
    if (node.isDir) return node.path;
    const i = node.path.lastIndexOf("/");
    return i <= 0 ? "/" : node.path.slice(0, i);
  }, [root, cwd]);

  const startCreate = useCallback((node: TreeNode | null, kind: "file" | "dir") => {
    setMenu(null);
    setEditor({ mode: "create", dir: createDirFor(node), kind, value: "", error: null });
  }, [createDirFor]);

  const startRename = useCallback((node: TreeNode) => {
    setMenu(null);
    setEditor({ mode: "rename", node, value: node.name, error: null });
  }, []);

  const commitEditor = useCallback(async () => {
    if (!editor) return;
    const name = editor.value.trim();
    if (!name) { setEditor(null); return; }
    if (!validName(name)) { setEditor((e) => (e ? { ...e, error: "invalid name" } : e)); return; }
    if (editor.mode === "create") {
      const r = await mutate("create", { path: editor.dir, name, kind: editor.kind });
      if (!r.ok) { setEditor((e) => (e ? { ...e, error: r.error } : e)); return; }
      setEditor(null);
      await refreshDir(affectedParent("create", editor.dir, ""));
    } else {
      const r = await mutate("rename", { path: editor.node.path, name });
      if (!r.ok) { setEditor((e) => (e ? { ...e, error: r.error } : e)); return; }
      setEditor(null);
      await refreshDir(affectedParent("rename", "", editor.node.path));
    }
  }, [editor, mutate, refreshDir]);

  const commitDelete = useCallback(async (node: TreeNode) => {
    setConfirmDel(null);
    const r = await mutate("delete", { path: node.path });
    if (r.ok) await refreshDir(affectedParent("delete", "", node.path));
  }, [mutate, refreshDir]);

  const onRowContext = useCallback((e: React.MouseEvent, node: TreeNode) => {
    e.preventDefault(); e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, node });
  }, []);

  const openPreview = useCallback((node: TreeNode) => { if (!node.isDir) onOpen(node.path, "preview"); }, [onOpen]);
  const openPinned = useCallback((node: TreeNode) => { if (!node.isDir) onOpen(node.path, "pin"); }, [onOpen]);

  const closeMenu = useCallback(() => setMenu(null), []);

  useEffect(() => {
    if (!confirmDel) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setConfirmDel(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmDel]);

  const q = query.trim().toLowerCase();
  const flatMatches = useMemo<TreeNode[]>(() => {
    if (!q || !root) return [];
    const out: TreeNode[] = [];
    const walk = (n: TreeNode) => { if (n.name.toLowerCase().includes(q)) out.push(n); n.children.forEach(walk); };
    root.children.forEach(walk);
    return out;
  }, [q, root]);

  const crumbs = useMemo<{ label: string }[]>(() => {
    if (!root) return [];
    if (home && (root.path === home || root.path.startsWith(home + "/"))) {
      const rel = root.path === home ? "" : root.path.slice(home.length + 1);
      return [{ label: "~" }, ...rel.split("/").filter(Boolean).map((s) => ({ label: s }))];
    }
    return root.path.split("/").filter(Boolean).map((s) => ({ label: s }));
  }, [root, home]);

  return (
    <aside className="w-[260px] shrink-0 flex flex-col float-card overflow-hidden min-h-0">
      <div className="flex items-center gap-2.5 px-3 py-2.5 border-b border-[var(--border)] shrink-0">
        <div className="flex items-center gap-1.5 text-[12.5px] text-[var(--muted)] min-w-0 flex-1">
          <Folder size={13} className="shrink-0" />
          <span className="flex items-center gap-1 min-w-0 truncate">
            {crumbs.length === 0 ? (
              <span className="font-semibold text-[var(--text)]">…</span>
            ) : crumbs.map((c, i) => (
              <span key={i} className="flex items-center gap-1 min-w-0">
                <span className={`truncate ${i === crumbs.length - 1 ? "font-semibold text-[var(--text)]" : "text-[var(--muted)]"}`}>{c.label}</span>
                {i < crumbs.length - 1 && <span className="text-[var(--faint)]">/</span>}
              </span>
            ))}
          </span>
        </div>
        <button onClick={() => setShowHidden((v) => !v)} title={showHidden ? "Hide dotfiles" : "Show dotfiles"}
          className={`w-7 h-7 grid place-items-center rounded-md border ${showHidden ? "bg-[var(--brand-bg)] text-[var(--brand-fg)] border-transparent" : "border-[var(--border)] text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"}`}>
          {showHidden ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
        <button onClick={() => setReloadKey((k) => k + 1)} title="Refresh tree"
          className="w-7 h-7 grid place-items-center rounded-md border border-[var(--border)] text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]">
          <RefreshCw size={14} />
        </button>
      </div>
      <div className="px-3 py-2 border-b border-[var(--border)] shrink-0">
        <div className="relative">
          <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--faint)]" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter"
            className="bg-[var(--bg)] border border-[var(--border)] text-[var(--text)] rounded-md text-[12.5px] pl-7 pr-2 h-7 w-full focus:outline-none focus:border-[var(--accent)]" />
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto"
        onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, node: null }); }}>
        {error ? (
          <div className="text-xs px-4 py-6 text-[var(--red)]">{error}</div>
        ) : !root ? (
          <div className="text-sm text-[var(--faint)] px-4 py-6">Loading…</div>
        ) : q ? (
          <div className="p-2">
            {flatMatches.length === 0 ? (
              <div className="text-[13px] text-[var(--faint)] px-3 py-4">No matches in loaded folders.</div>
            ) : flatMatches.map((n) => {
              const rel = n.path.slice(root.path.length).replace(/^\//, "");
              return (
                <div key={n.path} onClick={() => !n.isDir && openPreview(n)} onDoubleClick={() => !n.isDir && openPinned(n)} onContextMenu={(e) => onRowContext(e, n)}
                  className={`group flex items-center gap-1.5 px-2.5 h-7 rounded-md cursor-pointer text-[13px] ${activePath === n.path ? "bg-[var(--active)] text-[var(--text)]" : "text-[var(--text)] hover:bg-[var(--hover)]"}`}>
                  {n.isDir ? <Folder size={14} className="text-[var(--accent-soft)] shrink-0" /> : <FileIcon size={14} className={`shrink-0 ${fileColor(n.name)}`} />}
                  <span className="truncate font-medium">{n.name}</span>
                  <span className="mono text-[11px] text-[var(--faint)] truncate ml-auto pl-2">{rel === n.name ? "" : rel}</span>
                </div>
              );
            })}
          </div>
        ) : root.children.length === 0 ? (
          <div className="p-2">
            {editor && (
              <div className="flex items-center gap-1.5 px-2.5 h-8 mb-1 rounded-md bg-[var(--active)]">
                {editor.mode === "create"
                  ? (editor.kind === "dir" ? <Folder size={14} className="text-[var(--accent-soft)]" /> : <FileIcon size={14} />)
                  : <Pencil size={14} />}
                <input autoFocus value={editor.value}
                  onChange={(e) => setEditor((s) => (s ? { ...s, value: e.target.value, error: null } : s))}
                  onKeyDown={(e) => { if (e.key === "Enter") void commitEditor(); if (e.key === "Escape") setEditor(null); }}
                  placeholder={editor.mode === "create" ? (editor.kind === "dir" ? "New folder name" : "New file name") : "New name"}
                  className="flex-1 bg-[var(--bg)] border border-[var(--accent)] rounded-[5px] text-[13px] px-1.5 py-0.5 text-[var(--text)] focus:outline-none" />
                {editor.error && <span className="text-[11px] text-[var(--red)] shrink-0">{editor.error}</span>}
              </div>
            )}
            <div className="text-sm text-[var(--faint)] px-2 py-4">This folder is empty.</div>
          </div>
        ) : (
          <div className="p-2">
            {editor && (
              <div className="flex items-center gap-1.5 px-2.5 h-8 mb-1 rounded-md bg-[var(--active)]">
                {editor.mode === "create"
                  ? (editor.kind === "dir" ? <Folder size={14} className="text-[var(--accent-soft)]" /> : <FileIcon size={14} />)
                  : <Pencil size={14} />}
                <input autoFocus value={editor.value}
                  onChange={(e) => setEditor((s) => (s ? { ...s, value: e.target.value, error: null } : s))}
                  onKeyDown={(e) => { if (e.key === "Enter") void commitEditor(); if (e.key === "Escape") setEditor(null); }}
                  placeholder={editor.mode === "create" ? (editor.kind === "dir" ? "New folder name" : "New file name") : "New name"}
                  className="flex-1 bg-[var(--bg)] border border-[var(--accent)] rounded-[5px] text-[13px] px-1.5 py-0.5 text-[var(--text)] focus:outline-none" />
                {editor.error && <span className="text-[11px] text-[var(--red)] shrink-0">{editor.error}</span>}
              </div>
            )}
            {confirmDel && (
              <div className="flex items-center gap-2 px-2.5 h-8 mb-1 rounded-md bg-[color-mix(in_srgb,var(--red)_10%,transparent)] text-[13px]">
                <Trash2 size={14} className="text-[var(--red)] shrink-0" />
                <span className="truncate">Delete "{confirmDel.name}"?</span>
                <button onClick={() => void commitDelete(confirmDel)} className="ml-auto px-2 py-0.5 rounded-md bg-[var(--red)] text-white text-[12px] shrink-0">Delete</button>
                <button onClick={() => setConfirmDel(null)} className="px-2 py-0.5 rounded-md border border-[var(--border)] text-[12px] shrink-0">Cancel</button>
              </div>
            )}
            {root.children.map((c) => (
              <TreeRow key={c.path} node={c} depth={0} expanded={expanded} activePath={activePath}
                onToggle={toggleExpand} onOpenPreview={openPreview} onOpenPinned={openPinned} onContext={onRowContext} />
            ))}
          </div>
        )}
      </div>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} node={menu.node}
          onCreate={(kind) => startCreate(menu.node, kind)}
          onRename={() => menu.node && startRename(menu.node)}
          onDelete={() => { if (menu.node) { setConfirmDel(menu.node); setMenu(null); } }}
          onClose={closeMenu} />
      )}
    </aside>
  );
}

function TreeRow({ node, depth, expanded, activePath, onToggle, onOpenPreview, onOpenPinned, onContext }: {
  node: TreeNode; depth: number; expanded: Set<string>; activePath: string | null;
  onToggle: (n: TreeNode) => void; onOpenPreview: (n: TreeNode) => void; onOpenPinned: (n: TreeNode) => void;
  onContext: (e: React.MouseEvent, n: TreeNode) => void;
}) {
  const isOpen = expanded.has(node.path);
  return (
    <div>
      <div onClick={() => (node.isDir ? onToggle(node) : onOpenPreview(node))}
        onDoubleClick={() => (!node.isDir ? onOpenPinned(node) : undefined)}
        onContextMenu={(e) => { e.preventDefault(); onContext(e, node); }}
        className={`flex items-center gap-1.5 pr-2 h-7 rounded-md cursor-pointer text-[13px] ${activePath === node.path ? "bg-[var(--active)] text-[var(--text)]" : "text-[var(--text)] hover:bg-[var(--hover)]"}`}
        style={{ paddingLeft: 4 + depth * 14 }}>
        <span className="w-3.5 grid place-items-center text-[var(--faint)] shrink-0">
          {node.isDir ? (isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />) : null}
        </span>
        {node.isDir ? (isOpen ? <FolderOpen size={14} className="text-[var(--accent-soft)] shrink-0" /> : <Folder size={14} className="text-[var(--accent-soft)] shrink-0" />) : <FileIcon size={14} className={`shrink-0 ${fileColor(node.name)}`} />}
        <span className="truncate">{node.name}</span>
      </div>
      {node.isDir && isOpen && (
        <div>
          {!node.loaded ? (
            <div className="text-[12px] text-[var(--faint)] py-1" style={{ paddingLeft: 4 + (depth + 1) * 14 }}>…</div>
          ) : node.children.length === 0 ? (
            <div className="text-[12px] text-[var(--faint)] py-1" style={{ paddingLeft: 4 + (depth + 1) * 14 }}>empty</div>
          ) : node.children.map((c) => (
            <TreeRow key={c.path} node={c} depth={depth + 1} expanded={expanded} activePath={activePath}
              onToggle={onToggle} onOpenPreview={onOpenPreview} onOpenPinned={onOpenPinned} onContext={onContext} />
          ))}
        </div>
      )}
    </div>
  );
}

function ContextMenu({ x, y, node, onCreate, onRename, onDelete, onClose }: {
  x: number; y: number; node: TreeNode | null;
  onCreate: (kind: "file" | "dir") => void;
  onRename: () => void; onDelete: () => void; onClose: () => void;
}) {
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const left = Math.min(x, window.innerWidth - 190);
  const top = Math.min(y, window.innerHeight - 170);
  const item = "flex items-center gap-2 px-2.5 py-1.5 rounded-md text-[13px] cursor-pointer hover:bg-[var(--hover)] text-[var(--text)]";
  return (
    <div onClick={(e) => e.stopPropagation()} style={{ position: "fixed", left, top, zIndex: 50 }}
      className="min-w-[170px] p-1.5 rounded-[10px] bg-[var(--panel)] border border-[var(--border-2)] shadow-[0_8px_28px_rgba(0,0,0,0.18)]">
      <div className={item} onClick={() => onCreate("file")}><FileIcon size={14} /> New File…</div>
      <div className={item} onClick={() => onCreate("dir")}><Folder size={14} className="text-[var(--accent-soft)]" /> New Folder…</div>
      {node && (
        <>
          <div className="h-px bg-[var(--border)] my-1.5 mx-1.5" />
          <div className={item} onClick={onRename}><Pencil size={14} /> Rename…</div>
          <div className={`${item} text-[var(--red)] hover:bg-[color-mix(in_srgb,var(--red)_12%,transparent)]`} onClick={onDelete}><Trash2 size={14} /> Delete…</div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Preview pane (ported WorkspaceFilesMain) — cat via module route
// ---------------------------------------------------------------------------
interface CatResponse { path: string; content: string; size: number; error?: string }
interface Preview { name: string; path: string; content: string | null; note: string; image?: string }

function isImage(name: string): boolean { return /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i.test(name); }
function isMarkdown(name: string): boolean { return /\.(md|markdown|mdown|mkd)$/i.test(name); }
function isHtml(name: string): boolean { return /\.html?$/i.test(name); }
type HtmlViewMode = "preview" | "source";

const EXT_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", jsonc: "json", css: "css", scss: "scss", less: "less",
  html: "xml", htm: "xml", xml: "xml", svg: "xml",
  sh: "bash", bash: "bash", zsh: "bash", shell: "bash",
  yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", conf: "ini",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", sql: "sql", dockerfile: "dockerfile", mk: "makefile",
};
function langFor(name: string): string | null {
  const base = name.toLowerCase();
  if (base === "dockerfile") return "dockerfile";
  if (base === "makefile" || base === "gnumakefile") return "makefile";
  const ext = base.includes(".") ? (base.split(".").pop() as string) : base;
  return EXT_LANG[ext] ?? null;
}

function FilesMain({ label, tabs, activeIndex, onActivate, onClose, onPin }: {
  label: string; tabs: FileTab[]; activeIndex: number;
  onActivate: (i: number) => void; onClose: (i: number) => void; onPin: (i: number) => void;
}) {
  const activePath = activeIndex >= 0 && activeIndex < tabs.length ? tabs[activeIndex].path : null;
  return (
    <div className="flex-1 min-w-0 float-card flex flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-4 h-11 border-b border-[var(--border)] shrink-0">
        <span className="mono text-xs font-semibold tracking-wider uppercase text-[var(--accent-soft)] truncate">Files · {label}</span>
      </div>
      {tabs.length > 0 && <TabStrip tabs={tabs} activeIndex={activeIndex} onActivate={onActivate} onClose={onClose} onPin={onPin} />}
      <div className="flex-1 min-h-0">
        {tabs.length === 0 ? <PreviewPane preview={null} /> : tabs.map((t) => (
          <FileTabPreview key={t.path} path={t.path} active={t.path === activePath} />
        ))}
      </div>
    </div>
  );
}

function FileTabPreview({ path, active }: { path: string; active: boolean }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [htmlMode, setHtmlMode] = useState<HtmlViewMode>("preview");

  useEffect(() => {
    if (!path) { setPreview(null); return; }
    const name = path.split("/").pop() ?? path;
    if (isImage(name)) { setPreview({ name, path, content: null, note: "image", image: rawUrl(path) }); return; }
    setPreview({ name, path, content: null, note: "loading…" });
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`${API}/cat?path=${encodeURIComponent(path)}`);
        const data = (await res.json()) as CatResponse;
        if (cancelled) return;
        if (data.error) setPreview({ name, path, content: null, note: data.error });
        else setPreview({ name, path, content: data.content, note: `${data.size.toLocaleString()} bytes` });
      } catch (e) {
        if (!cancelled) setPreview({ name, path, content: null, note: e instanceof Error ? e.message : "request failed" });
      }
    })();
    return () => { cancelled = true; };
  }, [path, refreshKey]);

  return (
    <div className={active ? "flex flex-col h-full min-h-0" : "hidden"}>
      <PreviewPane preview={preview} onRefresh={() => setRefreshKey((k) => k + 1)} htmlMode={htmlMode} onHtmlModeChange={setHtmlMode} />
    </div>
  );
}

function TabStrip({ tabs, activeIndex, onActivate, onClose, onPin }: {
  tabs: FileTab[]; activeIndex: number; onActivate: (i: number) => void; onClose: (i: number) => void; onPin: (i: number) => void;
}) {
  return (
    <div className="flex items-stretch overflow-x-auto border-b border-[var(--border)] shrink-0">
      {tabs.map((t, i) => {
        const name = t.path.split("/").pop() ?? t.path;
        const isActive = i === activeIndex;
        return (
          <div key={t.path} onClick={() => onActivate(i)} onDoubleClick={() => t.preview && onPin(i)} title={t.path}
            className={`group flex items-center gap-1.5 px-3 h-8 cursor-pointer text-[12.5px] shrink-0 border-r border-[var(--border)] ${isActive ? "bg-[var(--panel)] text-[var(--text)] border-b-2 border-b-[var(--accent)] -mb-px" : "text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"}`}>
            <FileIcon size={12} className={`shrink-0 ${fileColor(name)}`} />
            <span className={`truncate max-w-[160px] ${t.preview ? "italic" : ""}`}>{name}</span>
            {t.preview && (
              <button type="button" onClick={(e) => { e.stopPropagation(); onPin(i); }} title="Pin tab"
                className="opacity-0 group-hover:opacity-100 w-4 h-4 grid place-items-center rounded text-[var(--faint)] hover:text-[var(--text)]"><Pin size={10} /></button>
            )}
            <button type="button" onClick={(e) => { e.stopPropagation(); onClose(i); }} title="Close tab"
              className={`${isActive ? "opacity-80" : "opacity-0 group-hover:opacity-80"} w-4 h-4 grid place-items-center rounded text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]`}><X size={11} /></button>
          </div>
        );
      })}
    </div>
  );
}

function PreviewPane({ preview, onRefresh, htmlMode, onHtmlModeChange }: {
  preview: Preview | null; onRefresh?: () => void; htmlMode?: HtmlViewMode; onHtmlModeChange?: (m: HtmlViewMode) => void;
}) {
  const highlighted = useMemo(() => {
    if (!preview || preview.content === null || isMarkdown(preview.name)) return null;
    const lang = langFor(preview.name);
    if (lang && hljs.getLanguage(lang)) {
      try { return hljs.highlight(preview.content, { language: lang }).value; } catch { return null; }
    }
    return null;
  }, [preview]);

  const mdHtml = useMemo(() => {
    if (!preview || preview.content === null || !isMarkdown(preview.name)) return null;
    try { return marked.parse(preview.content, { async: false }) as string; } catch { return null; }
  }, [preview]);

  const mdRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!mdHtml || !mdRef.current) return;
    mdRef.current.querySelectorAll<HTMLElement>("pre code").forEach((node) => {
      try { hljs.highlightElement(node); } catch { /* unknown lang */ }
    });
  }, [mdHtml]);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="h-9 px-4 flex items-center gap-2 border-b border-[var(--border)] text-[12px] text-[var(--muted)] shrink-0">
        {preview ? (
          <>
            <FileIcon size={13} className="shrink-0" />
            <span className="font-semibold text-[var(--text)] truncate">{preview.name}</span>
            <div className="ml-auto flex items-center gap-2 min-w-0">
              <span className="mono text-[11px] text-[var(--faint)] truncate">{preview.note}</span>
              {isHtml(preview.name) && htmlMode && onHtmlModeChange && (
                <div className="flex items-center rounded-md border border-[var(--border)] overflow-hidden shrink-0">
                  <button onClick={() => onHtmlModeChange("preview")} title="Rendered preview"
                    className={`w-6 h-6 grid place-items-center ${htmlMode === "preview" ? "bg-[var(--active)] text-[var(--text)]" : "text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"}`}><Eye size={12} /></button>
                  <button onClick={() => onHtmlModeChange("source")} title="HTML source"
                    className={`w-6 h-6 grid place-items-center ${htmlMode === "source" ? "bg-[var(--active)] text-[var(--text)]" : "text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"}`}><Code2 size={12} /></button>
                </div>
              )}
              {onRefresh && (
                <button onClick={onRefresh} title="Refresh preview"
                  className="w-6 h-6 grid place-items-center rounded-md border border-[var(--border)] text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--text)] shrink-0"><RefreshCw size={12} /></button>
              )}
            </div>
          </>
        ) : (
          <><FileIcon size={13} className="text-[var(--faint)] shrink-0" /><span className="text-[var(--faint)]">Select a file to preview</span></>
        )}
      </div>
      <div className="flex-1 min-h-0">
        {!preview ? (
          <div className="h-full grid place-items-center text-sm text-[var(--faint)]">No file selected</div>
        ) : preview.image ? (
          <div className="h-full grid place-items-center p-4 overflow-hidden">
            <img src={preview.image} alt={preview.name} className="max-w-full max-h-full object-contain" />
          </div>
        ) : isHtml(preview.name) && htmlMode === "preview" ? (
          <iframe src={rawUrl(preview.path)} title={preview.name} sandbox="allow-scripts" className="w-full h-full border-0 bg-white" />
        ) : preview.content === null ? (
          <div className="px-4 py-6 text-sm text-[var(--muted)]">{preview.note}</div>
        ) : mdHtml != null ? (
          <div ref={mdRef} className="md-body h-full overflow-auto px-5 py-4 text-[13px] text-[var(--text)]" dangerouslySetInnerHTML={{ __html: mdHtml }} />
        ) : highlighted ? (
          <CodeView text={preview.content} html={highlighted} className="hljs mono text-[12.5px] leading-relaxed" />
        ) : (
          <CodeView text={preview.content} className="mono text-[12px] leading-relaxed" />
        )}
      </div>
    </div>
  );
}

function CodeView({ text, html, className }: { text: string; html?: string; className?: string }) {
  const gutter = text.split("\n").map((_, i) => i + 1).join("\n");
  return (
    <pre className={`${className ?? ""} m-0 h-full overflow-auto`}>
      <div className="flex">
        <div aria-hidden className="shrink-0 select-none whitespace-pre text-right text-[var(--faint)] border-r border-[var(--border)] py-3 pl-4 pr-3">{gutter}</div>
        {html != null ? (
          <code className="mono block whitespace-pre py-3 px-4 flex-1" dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <code className="mono block whitespace-pre py-3 px-4 flex-1 text-[var(--text)]">{text}</code>
        )}
      </div>
    </pre>
  );
}

// ---------------------------------------------------------------------------
// FilesPage — top-level rail page. Tracks active workspace via host.context,
// owns per-workspace tab state, composes tree + main.
// ---------------------------------------------------------------------------
function FilesPage({ host }: { host: ClientHost }) {
  // Reactively track the active workspace's id/cwd/label as one slice; shallow eq
  // keeps the fresh object from re-rendering on unrelated context changes.
  const { wsId, cwd, label } = host.context.select((s) => {
    const ws = s.activeWorkspaceId ? s.workspaces[s.activeWorkspaceId] : null;
    return {
      wsId: s.activeWorkspaceId ?? "__none__",
      cwd: ws?.cwd ?? "~",
      label: ws?.label ?? "",
    };
  }, shallowEqual);

  // Re-init reducer per workspace via the `key` on this component (see activate).
  const [state, dispatch] = useReducer(reduceTabs, wsId, loadTabs);
  useEffect(() => { saveTabs(wsId, state); }, [wsId, state]);

  const activePath = state.activeIndex >= 0 && state.activeIndex < state.open.length ? state.open[state.activeIndex].path : null;

  return (
    <div className="flex-1 flex min-h-0 gap-2">
      <FilesTree cwd={cwd} activePath={activePath}
        onOpen={(path, mode) => dispatch(mode === "pin" ? { type: "openPinned", path } : { type: "openPreview", path })} />
      <FilesMain label={label} tabs={state.open} activeIndex={state.activeIndex}
        onActivate={(i) => dispatch({ type: "activate", index: i })}
        onClose={(i) => dispatch({ type: "close", index: i })}
        onPin={(i) => dispatch({ type: "pin", index: i })} />
    </div>
  );
}

export default function activate(host: ClientHost): () => void {
  // Key the page by workspaceId so switching workspace remounts with that
  // workspace's persisted tab state + freshly-rooted tree.
  const Page = () => {
    const wsId = host.context.select((s) => s.activeWorkspaceId ?? "__none__");
    return <FilesPage key={wsId} host={host} />;
  };
  return host.ui.registerUI({
    railPage: {
      id: "files",
      icon: <FolderTree size={16} />,
      label: "Files",
      component: Page,
    },
  });
}
