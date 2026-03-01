# durable-bash

Cloudflare Durable Object-backed [`IFileSystem`](https://www.npmjs.com/package/just-bash) adapter for [just-bash](https://www.npmjs.com/package/just-bash). Lets bash commands persist files in a Durable Object's SQLite storage.

## Install

```bash
npm install @stablemodels/durable-bash
```

Peer dependencies: `just-bash`, `@cloudflare/workers-types`

## Usage

```typescript
import { Bash } from "just-bash";
import { DurableFs } from "@stablemodels/durable-bash";

// In a Cloudflare Worker:
const fs = await DurableFs.create(env.FS, "my-agent");
const bash = new Bash({ fs, cwd: "/home" });
const result = await bash.exec('echo "hello" > greeting.txt && cat greeting.txt');
console.log(result.stdout); // "hello\n"
```

### Wrangler config

```toml
[[durable_objects.bindings]]
name = "FS"
class_name = "FsObject"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["FsObject"]
```

Re-export the DO class from your worker:

```typescript
export { FsObject } from "@stablemodels/durable-bash/object";
```

## API

`DurableFs` implements `IFileSystem` from `just-bash`:

- `readFile(path)` / `readFileBuffer(path)` — Read file contents
- `writeFile(path, content)` / `appendFile(path, content)` — Write/append
- `exists(path)` / `stat(path)` / `lstat(path)` — Check existence and metadata
- `mkdir(path, opts?)` / `readdir(path)` / `readdirWithFileTypes(path)` — Directories
- `rm(path, opts?)` / `cp(src, dest, opts?)` / `mv(src, dest)` — File operations
- `chmod(path, mode)` / `utimes(path, atime, mtime)` — Metadata changes
- `symlink(target, linkPath)` / `link(existing, new)` / `readlink(path)` / `realpath(path)` — Links
- `static create(namespace, name, cwd?)` — Factory: creates stub, syncs cache, returns ready instance
- `getAllPaths()` — Synchronous cached path list for glob matching

## Exports

| Export | Path | Description |
|--------|------|-------------|
| `DurableFs` | `@stablemodels/durable-bash` | `IFileSystem` adapter |
| `FsStat`, `DirentEntry` | `@stablemodels/durable-bash` | Stat/dirent types (boolean properties, not methods) |
| `normalizePath` | `@stablemodels/durable-bash` | Path normalizer (resolves `.`/`..`, ensures leading `/`) |
| `FsObject` | `@stablemodels/durable-bash/object` | Durable Object class — re-export in your worker |
| `FsError`, `ENOENT`, `EEXIST`, `EISDIR`, `ENOTDIR`, `ENOTEMPTY` | `@stablemodels/durable-bash` | POSIX-style errors |
| `FsStatData`, `DirentData` | `@stablemodels/durable-bash` | RPC wire-format types |

## Development

```bash
bun install
bun test              # all 121 tests
bun run test:unit     # unit tests only
bun run test:integration  # integration + smoke tests
bun run build         # tsc → dist/
bun run check         # biome lint
bun run format        # biome format
```

### Test structure

| File | Scope |
|------|-------|
| `tests/fs-object.test.ts` | Unit tests for `FsObject` DO |
| `tests/durable-fs.test.ts` | Unit tests for `DurableFs` (mock stub) |
| `tests/integration.test.ts` | End-to-end: `DurableFs` + `FsObject` |
| `tests/just-bash.test.ts` | Bash commands through `DurableFs` |

Tests mock `cloudflare:workers` via a preload script (`tests/setup.ts`, configured in `bunfig.toml`) and use `bun:sqlite` to simulate DO SQLite storage.

## CI/CD

- **PR checks**: Lint, build, and tests run automatically on pull requests via GitHub Actions.
- **NPM publishing**: Triggered automatically on merge to `main`. Requires an `NPM_TOKEN` secret in the repository/org settings.

## License

MIT
