# @tabterm/module-files

The **files** module for [tabterm](https://github.com/and1truong/tabterm) — a file explorer
(`id: files`), extracted from the monorepo (`modules/files/`) into its own repository.

- **Tree** — a lazy directory tree rooted at the active workspace's cwd; expand folders on
  demand, toggle hidden files, search, and right-click to create / rename / delete.
- **Preview** — a multi-tab preview pane: syntax-highlighted code (`highlight.js`), rendered
  markdown (`marked`), inline images, and sandboxed HTML. Open-file tabs persist per
  workspace in localStorage.

The server half registers read-only filesystem routes (`GET /ls`, `/cat`, `/raw`) plus
mutations (`POST /create`, `/rename`, `/delete`), dispatched by the host at
`/api/modules/files/r/*`. Each handler is pure (URL/Request in, Response out).

## Layout

```
server.ts            Server entry — activate(host): registers the /ls, /cat, /raw read
                     routes and /create, /rename, /delete mutations (pure handlers)
src/index.tsx        Client entry — activate(host): the Files rail page (lazy tree +
                     tabbed preview pane); inlines file-icon colors and the tab reducer
scripts/build-modules.ts   Builds the two self-contained dist artifacts
```

The module talks to the host **only** through `@tabterm/module-host` (the type-only
contract) plus its own files — no deep imports into tabterm's `src/`. It owns its routes
(`host.registerRoute`) and its UI (`host.ui.registerUI`). See `docs/modules.md` in tabterm
for the full host API.

## Development

```sh
bun install        # resolves highlight.js/lucide-react/marked + links @tabterm/module-host
bun run typecheck  # tsc --noEmit
bun test           # client-logic + server-endpoint tests
make build         # -> dist/modules/files/{client.js,server.js}
```

`@tabterm/module-host` (the type-only host contract) is **vendored** under
`vendor/module-host/` and resolved via `file:./vendor/module-host` (see `package.json`
devDependencies) — no npm/registry dependency. To update it, run
`make vendor TABTERM=<path-to-tabterm>`.

## Consuming this module in tabterm

Unlike a monorepo module, this repo builds its own artifacts. `make build` emits two
self-contained files under `dist/modules/files/`:

- **`client.js`** — ESM client bundle. `react`/`react-dom` stay external (host-provided at
  runtime); `lucide-react`, `highlight.js`, and `marked` are inlined. No CSS (Tailwind
  classes only). Default export is `activate(host)`.
- **`server.js`** — server half (`--target bun` ESM). Default export is `activate(host)`.

Point tabterm's config at them:

```yaml
modules:
  - { id: files, enabled: true,
      client: ~/dirs/tabterm-modules/tabterm-files/dist/modules/files/client.js,
      server: ~/dirs/tabterm-modules/tabterm-files/dist/modules/files/server.js }
```

Rebuild here (`make build`) whenever the module changes; tabterm picks up the new bundles
on its next load.
