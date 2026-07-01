# tabterm-files

The **files** module for [tabterm](https://github.com/and1truong/tabterm), extracted into
its own repository — a file explorer (`id: files`): a lazy directory tree, a multi-tab
preview pane (syntax-highlighted code, rendered markdown, inline images, sandboxed HTML),
and right-click create / rename / delete. A tabterm *module*, not a standalone app: it has
no server/SPA of its own; it activates inside a tabterm host through the
`@tabterm/module-host` contract.

## Toolchain

- **Runtime + package manager: [Bun](https://bun.sh)** (required ≥1.3.5, see `package.json` engines).
  Use `bun` for everything. Do **not** use `npm`, `yarn`, or `pnpm`. Lockfile is `bun.lock`.
- **Typecheck:** `bun run typecheck` (`tsc --noEmit`) — or `make typecheck`.
- **Test:** `bun test` (client-logic + server-endpoint tests) — or `make test`.
- **Full local gate:** `make check` (typecheck + test).
- **Build:** `make build` → `dist/modules/files/{client.js,server.js}`.
- `make help` lists every target.

## Architecture

The module talks to the host **only** through `@tabterm/module-host` plus its own files —
no deep imports into a host's `src/`. It is a flat two-file module:

- `server.ts` — server entry: `activate(host)` registers read-only filesystem routes
  (`GET /ls`, `/cat`, `/raw`) plus mutations (`POST /create`, `/rename`, `/delete`),
  dispatched by the host at `/api/modules/files/r/*`. Each handler is pure (URL/Request in,
  Response out) so it is testable without the host. Path resolution expands `~`, requires
  absolute paths, and guards names against separators and `.`/`..`.
- `src/index.tsx` — client entry: `activate(host)` registers the **Files** rail page — a
  two-pane layout with a lazy directory tree (left) and a tabbed preview pane (right).
  It roots the tree at the active workspace's cwd via `host.context`; open-file tabs
  persist per workspace in localStorage. Preview uses `highlight.js` for code and `marked`
  for markdown; images and sandboxed HTML load straight from the `/raw` route.

## Host contract (`@tabterm/module-host`)

- **Vendored** under `vendor/module-host/`, resolved via `file:./vendor/module-host` — no
  registry dependency. Pinned to a tagged snapshot (see `vendor/README.md`).
- Refresh it with `make vendor TABTERM=<path-to-tabterm>` when the contract changes, then
  bump `vendor/module-host/package.json` and re-tag.
- `react` / `react-dom` are **host-provided** at runtime (externalized in the module
  build) — declared here as peer/dev deps for typecheck + tests only. `lucide-react`,
  `highlight.js`, and `marked` are real dependencies and are bundled into `client.js`.

## Building / consuming this module

This repo ships **source** and builds its own **self-contained** artifacts. `make build`
(`scripts/build-modules.ts`) compiles:
- `src/index.tsx` → `dist/modules/files/client.js` (ESM, react/react-dom external,
  no code-splitting, no CSS — Tailwind classes only; highlight.js/marked/lucide-react inlined);
- `server.ts` → `dist/modules/files/server.js` (`--target bun`).

A tabterm host loads these two files via its `modules:` config. See `README.md`.

## Conventions

- Surgical changes; match existing style. The module's clean host-only boundary is the
  whole point of the extraction — never reach back into a host's internals.
- Tests are colocated (`*.test.ts`): `client.logic.test.ts` (name/parent helpers),
  `server.test.ts` (the filesystem endpoints), `build.test.ts` (bundle smoke test).
- **Note for the host side:** the host's `CwdPickerModal` calls this module's `/ls` route
  by URL (`/api/modules/files/r/ls`), not by code import — so removing this module from the
  host tree leaves no dangling host import, but the picker's directory listing depends on
  the module being loaded via the host's `modules:` config.
