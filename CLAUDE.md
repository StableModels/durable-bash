# durable-bash

Cloudflare Durable Object-backed `IFileSystem` adapter for `just-bash`.

## Architecture

Two core classes, one adapter pattern:

- **`FsObject`** (`src/fs-object.ts`) — Durable Object with SQLite storage. Single `files` table stores paths, content (BLOB), metadata, and optional symlink targets. All methods are **synchronous** and exposed via RPC. This is where all filesystem logic lives.
- **`DurableFs`** (`src/durable-fs.ts`) — Thin adapter implementing `IFileSystem` from `just-bash`. Every method delegates to `FsObject` via a DO stub. Maintains a `Set<string>` cache for the synchronous `getAllPaths()` method. Call `sync()` after construction to populate the cache.
- **`src/errors.ts`** — `FsError` class and factory functions: `ENOENT`, `EEXIST`, `EISDIR`, `ENOTDIR`, `ENOTEMPTY`.
- **`src/types.ts`** — Wire-format types for RPC: `FsStatData`, `DirentData`.
- **`src/index.ts`** — Public API re-exports. Two entry points: `durable-bash` (adapter + errors + types) and `durable-bash/object` (DO class).

## Important Points

- **`IFileSystem` uses boolean properties**, not methods: `stat.isFile`, not `stat.isFile()`. `FsStat` and `DirentEntry` in `durable-fs.ts` define these shapes.
- **`getAllPaths()` is synchronous** but the DO is async. Solved with eager `sync()` + `Set` cache. `addToCache` walks ancestor dirs so auto-created parents are included.
- **Auto-parent creation**: `writeFile("/a/b/c.txt", ...)` auto-creates `/a` and `/a/b` via `ensureParentDirs` using `INSERT OR IGNORE`.
- **Symlinks**: stored as rows with `symlink_target` set. `resolveSymlinks()` follows chains up to 20 levels. `readFile`/`stat` follow symlinks; `lstat` does not.
- **`link()` copies content** at call time (not POSIX shared-inode semantics). This is by design per `IFileSystem` contract.
- **Content stored as BLOB** — `toBytes()` encodes strings to UTF-8 `Uint8Array`; binary is stored as-is.
- Mode constants: `DIR_MODE = 0o755`, `FILE_MODE = 0o644`, `SYMLINK_MODE = 0o777`.

## Commands

```bash
bun test                 # all tests (121 tests across 4 files)
bun run test:unit        # unit tests only (fs-object + durable-fs)
bun run test:integration # integration + smoke tests
bun run build            # tsc → dist/
bun run check            # biome lint
bun run format           # biome format (tabs, write)
```

## Testing

Tests use `bun:test` with `bun:sqlite` to simulate DO SQLite storage. The `cloudflare:workers` module is mocked via `tests/setup.ts` (preloaded in `bunfig.toml`).

- `tests/helpers.ts` — shared `createMockState()`, `createTestFsObject()`, `createDirectStub()` (Proxy wrapping sync methods as Promises for RPC simulation)
- `tests/fs-object.test.ts` — Unit tests for FsObject
- `tests/durable-fs.test.ts` — Unit tests for DurableFs with mock stub
- `tests/integration.test.ts` — DurableFs + FsObject wired together
- `tests/just-bash.test.ts` — Bash commands through DurableFs

## Extending the Package

**Adding a new filesystem operation:**
1. Add the synchronous method to `FsObject` in `src/fs-object.ts`
2. Add the async wrapper in `DurableFs` in `src/durable-fs.ts` — resolve paths with `this.resolve()`, call `this.stub.<method>()`, update cache with `addToCache`/`removeFromCache` if paths change
3. If new wire-format types are needed, add them to `src/types.ts`
4. Export any new public types from `src/index.ts`
5. Add tests to `tests/fs-object.test.ts` (unit) and `tests/integration.test.ts` (e2e)

**Adding a new error code:**
1. Add a factory function in `src/errors.ts` following the `ENOENT` pattern

**Key conventions:**
- Paths are always normalized (leading `/`, no trailing `/`, `.`/`..` resolved)
- `FsObject` methods are synchronous — no async/await inside the DO
- `DurableFs` cache must stay in sync: use `addToCache` for creates, `removeFromCache` for deletes, `sync()` for bulk operations like `cp`/`mv`
- Biome enforces tab indentation and recommended lint rules
