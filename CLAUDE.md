# durable-bash

Cloudflare Durable Object-backed `IFileSystem` adapter for `just-bash`.

## Architecture

- **`src/fs-object.ts`** — `FsObject` Durable Object class. SQLite-backed storage engine with a `files` table storing paths, content (BLOB), metadata. Extends `DurableObject` from `cloudflare:workers`. All filesystem operations are synchronous methods exposed via RPC.
- **`src/durable-fs.ts`** — `DurableFs` adapter. Implements `IFileSystem` from `just-bash` by delegating every call to a `FsObject` DO stub over RPC. Handles path resolution and caching for the synchronous `getAllPaths()` method.
- **`src/errors.ts`** — Filesystem error classes with standard POSIX codes (`ENOENT`, `EEXIST`, `EISDIR`, `ENOTDIR`, `ENOTEMPTY`).
- **`src/types.ts`** — Shared wire-format types for RPC serialization (`FsStatData`, `DirentData`).

## Commands

- `bun test` — Run all tests
- `bun run build` — Build with TypeScript (`tsc`)
- `bun run check` — Lint with Biome
- `bun run format` — Format with Biome

## Testing

Tests use `bun:test` with `bun:sqlite` to simulate the Durable Object's SQLite storage. The `cloudflare:workers` module is mocked via `tests/setup.ts` (preloaded in `bunfig.toml`).

- `tests/fs-object.test.ts` — Unit tests for FsObject DO
- `tests/durable-fs.test.ts` — Unit tests for DurableFs adapter (mock stub)
- `tests/integration.test.ts` — End-to-end tests with DurableFs + FsObject
- `tests/just-bash.test.ts` — Smoke tests running bash commands through DurableFs

## Key Design Decisions

- **Single DO per namespace**: One `FsObject` stores all files for an agent/namespace
- **SQLite storage**: Enables directory listing, path queries, atomic operations
- **Auto-create parent dirs**: `writeFile("/a/b/c.txt", ...)` auto-creates `/a` and `/a/b`
- **`sync()` initialization**: Required async step to populate the synchronous `getAllPaths()` cache
- **Content as BLOB**: Handles both text (UTF-8) and binary uniformly
