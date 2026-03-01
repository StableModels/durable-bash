# durable-bash

Cloudflare Durable Object-backed `IFileSystem` adapter for [just-bash](https://www.npmjs.com/package/just-bash). Lets bash commands persist files in a Durable Object's SQLite storage instead of in-memory.

## Install

```bash
bun add durable-bash
```

## Usage

```typescript
import { Bash } from "just-bash";
import { DurableFs } from "durable-bash";

// In a Cloudflare Worker:
const id = env.FS.idFromName("my-agent");
const stub = env.FS.get(id);

const fs = new DurableFs(stub);
await fs.sync();

const bash = new Bash({ fs, cwd: "/home" });
const result = await bash.exec('echo "hello" > greeting.txt && cat greeting.txt');
console.log(result.stdout); // "hello\n"
```

### Worker setup

Add the Durable Object binding to your `wrangler.toml`:

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
export { FsObject } from "durable-bash/object";
```

## API

### `DurableFs`

Implements the `IFileSystem` interface from `just-bash`:

- `readFile(path)` / `readFileBuffer(path)` — Read file contents
- `writeFile(path, content)` / `appendFile(path, content)` — Write/append
- `exists(path)` / `stat(path)` / `lstat(path)` — Check existence and metadata
- `mkdir(path, opts?)` / `readdir(path)` / `readdirWithFileTypes(path)` — Directories
- `rm(path, opts?)` / `cp(src, dest, opts?)` / `mv(src, dest)` — File operations
- `chmod(path, mode)` / `utimes(path, atime, mtime)` — Metadata changes
- `symlink(target, linkPath)` / `link(existing, new)` / `readlink(path)` / `realpath(path)` — Links
- `sync()` — Fetch all paths from DO (required once before `getAllPaths()`)
- `getAllPaths()` — Synchronous cached path list for glob matching
