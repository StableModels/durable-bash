# durable-bash

Cloudflare Durable Object-backed `IFileSystem` adapter for `just-bash`.

## Architecture

Two core classes, one adapter pattern:

- **`FsObject`** (`src/fs-object.ts`) — Durable Object with SQLite storage. Single `files` table stores paths, content (BLOB), metadata, and optional symlink targets. All methods are **synchronous** and exposed via RPC. This is where all filesystem logic lives.
- **`DurableFs`** (`src/durable-fs.ts`) — Thin adapter implementing `IFileSystem` from `just-bash`. Every method delegates to `FsObject` via a DO stub. Maintains a `Set<string>` cache for the synchronous `getAllPaths()` method. Use the static `DurableFs.create(namespace, name)` factory for construction — it handles stub creation and initial cache sync.
- **`src/utils.ts`** — Shared utilities. `normalizePath` lives here (resolves `.`/`..`, ensures leading `/`, strips trailing `/`). Imported by both `FsObject` and `DurableFs`.
- **`src/errors.ts`** — `FsError` class and factory functions: `ENOENT`, `EEXIST`, `EISDIR`, `ENOTDIR`, `ENOTEMPTY`.
- **`src/types.ts`** — Wire-format types for RPC: `FsStatData`, `DirentData`.
- **`src/index.ts`** — Public API re-exports. Two entry points: `durable-bash` (adapter + errors + types + utils) and `durable-bash/object` (DO class).

## Important Points

- **`IFileSystem` uses boolean properties**, not methods: `stat.isFile`, not `stat.isFile()`. `FsStat` and `DirentEntry` in `durable-fs.ts` define these shapes.
- **`getAllPaths()` is synchronous** but the DO is async. Solved with eager cache sync (handled by `DurableFs.create()`) + `Set` cache. `addToCache` walks ancestor dirs so auto-created parents are included.
- **Auto-parent creation**: `writeFile("/a/b/c.txt", ...)` auto-creates `/a` and `/a/b` via `ensureParentDirs` using `INSERT OR IGNORE`.
- **Symlinks**: stored as rows with `symlink_target` set. `resolveSymlinks()` follows chains up to 20 levels. `readFile`/`stat` follow symlinks; `lstat` does not.
- **`link()` copies content** at call time (not POSIX shared-inode semantics). This is by design per `IFileSystem` contract.
- **Content stored as BLOB** — `toBytes()` encodes strings to UTF-8 `Uint8Array`; binary is stored as-is.
- Mode constants: `DIR_MODE = 0o755`, `FILE_MODE = 0o644`, `SYMLINK_MODE = 0o777`.

## Commands

```bash
bun run test             # all tests: bun + CloudFlare (161 tests)
bun run test:unit        # unit tests only (fs-object + durable-fs)
bun run test:integration # integration + smoke tests
bun run test:cf          # CloudFlare runtime tests (vitest + workerd)
bun run build            # tsc → dist/
bun run check            # biome lint
bun run format           # biome format (tabs, write)
```

## Testing

Two-tier test suite: fast bun tests for development, CloudFlare runtime tests for production confidence.

### Bun tests (`tests/*.test.ts`)

Use `bun:test` with `bun:sqlite` to simulate DO SQLite storage. The `cloudflare:workers` module is mocked via `tests/setup.ts` (preloaded in `bunfig.toml`). Fast (~100ms).

- `tests/helpers.ts` — shared `createMockState()`, `createTestFsObject()`, `createDirectStub()` (Proxy wrapping sync methods as Promises for RPC simulation)
- `tests/fs-object.test.ts` — Unit tests for FsObject
- `tests/durable-fs.test.ts` — Unit tests for DurableFs with mock stub
- `tests/integration.test.ts` — DurableFs + FsObject wired together
- `tests/just-bash.test.ts` — Bash commands through DurableFs

### CloudFlare runtime tests (`tests/cf/*.ts`)

Use `@cloudflare/vitest-pool-workers` to run tests inside the actual **workerd** runtime (same binary as production). Tests real DO RPC, real SQLite, real `cloudflare:workers` module. Configured via `vitest.config.ts` + `wrangler.toml`.

Files intentionally omit the `.test.ts` suffix so bun's test runner doesn't auto-discover them (they require workerd, not bun).

- `tests/cf/fs-object.ts` — FsObject via real DO RPC stubs: BLOB round-trips, stat shapes, error propagation, UTF-8 handling
- `tests/cf/durable-fs.ts` — DurableFs adapter: cache sync, path resolution, full stack operations
- `tests/cf/just-bash.ts` — Bash commands through the complete real stack

Each CF test uses a unique DO instance name for isolation (isolated storage is disabled due to a [known SQLite incompatibility](https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/#isolated-storage)).

## Extending the Package

**Adding a new filesystem operation:**
1. Add the synchronous method to `FsObject` in `src/fs-object.ts`
2. Add the async wrapper in `DurableFs` in `src/durable-fs.ts` — resolve paths with `this.resolve()`, call `this.stub.<method>()`, update cache with `addToCache`/`removeFromCache` if paths change
3. If new wire-format types are needed, add them to `src/types.ts`
4. Export any new public types from `src/index.ts`
5. Add tests to `tests/fs-object.test.ts` (unit), `tests/integration.test.ts` (e2e), and `tests/cf/fs-object.ts` (workerd runtime)

**Adding a new error code:**
1. Add a factory function in `src/errors.ts` following the `ENOENT` pattern

**Key conventions:**
- Paths are always normalized (leading `/`, no trailing `/`, `.`/`..` resolved)
- `FsObject` methods are synchronous — no async/await inside the DO
- `DurableFs` cache must stay in sync: use `addToCache` for creates, `removeFromCache` for deletes, `sync()` for bulk operations like `cp`/`mv`
- Biome enforces tab indentation and recommended lint rules
