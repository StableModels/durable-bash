import type { FsObject } from "./fs-object.js";
import { normalizePath } from "./fs-object.js";
import type { FsStatData } from "./types.js";

/** Minimal stub interface for the FsObject Durable Object */
type FsObjectStub = DurableObjectStub<FsObject>;

/**
 * IFileSystem implementation backed by a Durable Object.
 * Every filesystem operation is delegated to the FsObject DO over RPC.
 *
 * Use the static `create()` factory for easy setup:
 * ```ts
 * const fs = await DurableFs.create(env.FS, "my-agent");
 * ```
 */
export class DurableFs {
	private _cachedPaths = new Set<string>();

	constructor(
		private stub: FsObjectStub,
		private cwd = "/",
	) {}

	/**
	 * Create a ready-to-use DurableFs from a DO namespace and instance name.
	 * Handles stub creation and initial sync in one call.
	 */
	static async create(
		namespace: DurableObjectNamespace<FsObject>,
		name: string,
		cwd = "/",
	): Promise<DurableFs> {
		const id = namespace.idFromName(name);
		const stub = namespace.get(id);
		const fs = new DurableFs(stub, cwd);
		await fs.sync();
		return fs;
	}

	/**
	 * Refresh the local path cache from the DO.
	 * Called automatically by `create()`. Only needed if you modify
	 * the DO outside of this DurableFs instance.
	 */
	async sync(): Promise<void> {
		const paths = await this.stub.getAllPaths();
		this._cachedPaths = new Set(paths);
	}

	async readFile(
		path: string,
		_options?: { encoding?: string | null } | string,
	): Promise<string> {
		const result = await this.stub.readFile(this.resolve(path));
		return result.content;
	}

	async readFileBuffer(path: string): Promise<Uint8Array> {
		const result = await this.stub.readFileBuffer(this.resolve(path));
		return result.content;
	}

	async writeFile(
		path: string,
		content: string | Uint8Array,
		_options?: { encoding?: string } | string,
	): Promise<void> {
		const resolved = this.resolve(path);
		await this.stub.writeFile(resolved, content);
		this.addToCache(resolved);
	}

	async appendFile(
		path: string,
		content: string | Uint8Array,
		_options?: { encoding?: string } | string,
	): Promise<void> {
		const resolved = this.resolve(path);
		await this.stub.appendFile(resolved, content);
		this.addToCache(resolved);
	}

	async exists(path: string): Promise<boolean> {
		return this.stub.exists(this.resolve(path));
	}

	async stat(path: string): Promise<FsStat> {
		const data = await this.stub.stat(this.resolve(path));
		return toFsStat(data);
	}

	async lstat(path: string): Promise<FsStat> {
		const data = await this.stub.lstat(this.resolve(path));
		return toFsStat(data);
	}

	async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
		const resolved = this.resolve(path);
		await this.stub.mkdir(resolved, options);
		this.addToCache(resolved);
	}

	async readdir(path: string): Promise<string[]> {
		return this.stub.readdir(this.resolve(path));
	}

	async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
		const entries = await this.stub.readdirWithFileTypes(this.resolve(path));
		return entries.map((e) => ({
			name: e.name,
			isFile: e.isFile,
			isDirectory: e.isDirectory,
			isSymbolicLink: e.isSymlink,
		}));
	}

	async rm(
		path: string,
		options?: { recursive?: boolean; force?: boolean },
	): Promise<void> {
		const resolved = this.resolve(path);
		await this.stub.rm(resolved, options);
		this.removeFromCache(resolved);
	}

	async cp(
		src: string,
		dest: string,
		options?: { recursive?: boolean },
	): Promise<void> {
		await this.stub.cp(this.resolve(src), this.resolve(dest), options);
		// Re-sync cache since cp can create many paths
		await this.sync();
	}

	async mv(src: string, dest: string): Promise<void> {
		await this.stub.mv(this.resolve(src), this.resolve(dest));
		// Re-sync cache since mv can move many paths
		await this.sync();
	}

	resolvePath(base: string, path: string): string {
		if (path.startsWith("/")) return normalizePath(path);
		return normalizePath(`${base}/${path}`);
	}

	getAllPaths(): string[] {
		return [...this._cachedPaths].sort();
	}

	async chmod(path: string, mode: number): Promise<void> {
		await this.stub.chmod(this.resolve(path), mode);
	}

	async symlink(target: string, linkPath: string): Promise<void> {
		const resolved = this.resolve(linkPath);
		await this.stub.symlink(target, resolved);
		this.addToCache(resolved);
	}

	async link(existingPath: string, newPath: string): Promise<void> {
		const resolvedNew = this.resolve(newPath);
		await this.stub.link(this.resolve(existingPath), resolvedNew);
		this.addToCache(resolvedNew);
	}

	async readlink(path: string): Promise<string> {
		return this.stub.readlink(this.resolve(path));
	}

	async realpath(path: string): Promise<string> {
		return this.stub.realpath(this.resolve(path));
	}

	async utimes(path: string, atime: Date, mtime: Date): Promise<void> {
		await this.stub.utimes(
			this.resolve(path),
			atime.getTime(),
			mtime.getTime(),
		);
	}

	// --- Private helpers ---

	private resolve(path: string): string {
		return this.resolvePath(this.cwd, path);
	}

	/**
	 * Add a path and all its ancestor directories to the cache.
	 * The DO auto-creates parent dirs on write, so the cache must reflect them.
	 */
	private addToCache(path: string): void {
		this._cachedPaths.add(path);
		let dir = path;
		while (true) {
			const idx = dir.lastIndexOf("/");
			if (idx <= 0) {
				this._cachedPaths.add("/");
				break;
			}
			dir = dir.substring(0, idx);
			if (this._cachedPaths.has(dir)) break;
			this._cachedPaths.add(dir);
		}
	}

	private removeFromCache(path: string): void {
		this._cachedPaths.delete(path);
		const prefix = `${path}/`;
		// Safe to delete during Set iteration per ES spec — the iterator
		// will not visit deleted entries but will complete correctly.
		for (const p of this._cachedPaths) {
			if (p.startsWith(prefix)) {
				this._cachedPaths.delete(p);
			}
		}
	}
}

/** FsStat shape matching the just-bash IFileSystem interface */
export interface FsStat {
	isFile: boolean;
	isDirectory: boolean;
	isSymbolicLink: boolean;
	mode: number;
	size: number;
	mtime: Date;
}

/** DirentEntry shape matching the just-bash IFileSystem interface */
export interface DirentEntry {
	name: string;
	isFile: boolean;
	isDirectory: boolean;
	isSymbolicLink: boolean;
}

function toFsStat(data: FsStatData): FsStat {
	return {
		isFile: !data.isDir && !data.isSymlink,
		isDirectory: data.isDir,
		isSymbolicLink: data.isSymlink,
		mode: data.mode,
		size: data.size,
		mtime: new Date(data.mtimeMs),
	};
}
