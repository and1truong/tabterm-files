# vendor/

Third-party / cross-repo code vendored into this repository so it has no external
registry or sibling-checkout dependency.

## module-host

`@tabterm/module-host` — the type-only host contract every tabterm module compiles
against. Copied from tabterm's `packages/module-host/` and pinned here as `0.8.0`.
Resolved via `file:./vendor/module-host` in the root `package.json`.

To update: re-copy `packages/module-host/{src,package.json}` from tabterm into
`vendor/module-host/` (or run `make vendor TABTERM=<path-to-tabterm>` for `src/`),
bump the version, and re-run `bun install`.
