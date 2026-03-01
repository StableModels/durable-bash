import { DurableObject } from "cloudflare:workers";
import {
	EEXIST,
	EISDIR,
	ENOENT,
	ENOTDIR,
	ENOTEMPTY,
	FsError,
} from "./errors.js";
import type { DirentData, FsStatData } from "./types.js";

/**
 * Normalize a path: resolve `.` and `..`, remove trailing slashes, ensure leading `/`.
 */
export function normalizePath(p: string): string {
	if (!p || p === "/") return "/";
	const parts = p.split("/");
	const resolved: string[] = [];
	for (const part of parts) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			resolved.pop();
		} else {
			resolved.push(part);
		}
	}
	return `/${resolved.join("/")}`;
}

/**
 * Get the parent directory of a path.
 */
function parentDir(p: string): string {
	const idx = p.lastIndexOf("/");
	if (idx <= 0) return "/";
	return p.substring(0, idx);
}

/**
 * Get all ancestor directories of a path (excluding the path itself and root).
 */
function ancestors(p: string): string[] {
	const result: string[] = [];
	let current = parentDir(p);
	while (current !== "/") {
		result.push(current);
		current = parentDir(current);
	}
	result.push("/");
	return result.reverse();
}

export class FsObject extends DurableObject<any> {
	private sql: SqlStorage;

	constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
		super(ctx, env as any);
		this.sql = ctx.storage.sql;
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS files (
				path TEXT PRIMARY KEY,
				content BLOB,
				is_dir INTEGER NOT NULL DEFAULT 0,
				mode INTEGER NOT NULL DEFAULT 420,
				size INTEGER NOT NULL DEFAULT 0,
				mtime_ms INTEGER NOT NULL,
				symlink_target TEXT
			)
		`);
		// Ensure root directory exists
		const root = this.sql
			.exec("SELECT 1 FROM files WHERE path = '/'")
			.toArray();
		if (root.length === 0) {
			const now = Date.now();
			this.sql.exec(
				"INSERT INTO files (path, is_dir, mode, size, mtime_ms) VALUES ('/', 1, 493, 0, ?)",
				now,
			);
		}
	}

	private getRow(path: string): {
		path: string;
		content: ArrayBuffer | null;
		is_dir: number;
		mode: number;
		size: number;
		mtime_ms: number;
		symlink_target: string | null;
	} | null {
		const rows = this.sql
			.exec("SELECT * FROM files WHERE path = ?", path)
			.toArray();
		if (rows.length === 0) return null;
		return rows[0] as ReturnType<FsObject["getRow"]>;
	}

	/**
	 * Follow symlinks to resolve to the final target path.
	 */
	private resolveSymlinks(path: string, maxDepth = 20): string {
		let current = path;
		for (let i = 0; i < maxDepth; i++) {
			const row = this.getRow(current);
			if (!row) throw ENOENT(path);
			if (!row.symlink_target) return current;
			// Resolve symlink target relative to the symlink's directory
			const target = row.symlink_target.startsWith("/")
				? normalizePath(row.symlink_target)
				: normalizePath(`${parentDir(current)}/${row.symlink_target}`);
			current = target;
		}
		throw new FsError("ELOOP", "too many levels of symbolic links", path);
	}

	/**
	 * Ensure all parent directories of a path exist.
	 */
	private ensureParentDirs(path: string): void {
		const dirs = ancestors(path);
		const now = Date.now();
		for (const dir of dirs) {
			const existing = this.getRow(dir);
			if (!existing) {
				this.sql.exec(
					"INSERT INTO files (path, is_dir, mode, size, mtime_ms) VALUES (?, 1, 493, 0, ?)",
					dir,
					now,
				);
			}
		}
	}

	readFile(path: string): { content: string; encoding: string } {
		const resolved = this.resolveSymlinks(normalizePath(path));
		const row = this.getRow(resolved);
		if (!row) throw ENOENT(path);
		if (row.is_dir) throw EISDIR(path);
		const content =
			row.content !== null ? new TextDecoder().decode(row.content) : "";
		return { content, encoding: "utf-8" };
	}

	readFileBuffer(path: string): { content: Uint8Array } {
		const resolved = this.resolveSymlinks(normalizePath(path));
		const row = this.getRow(resolved);
		if (!row) throw ENOENT(path);
		if (row.is_dir) throw EISDIR(path);
		const content =
			row.content !== null ? new Uint8Array(row.content) : new Uint8Array(0);
		return { content };
	}

	writeFile(
		path: string,
		content: string | Uint8Array,
		opts?: { mode?: number },
	): void {
		const normalized = normalizePath(path);
		this.ensureParentDirs(normalized);

		const now = Date.now();
		const bytes =
			typeof content === "string" ? new TextEncoder().encode(content) : content;
		const mode = opts?.mode ?? 0o644;

		const existing = this.getRow(normalized);
		if (existing?.is_dir) throw EISDIR(path);

		// Follow symlinks for the write target
		let target = normalized;
		if (existing?.symlink_target) {
			target = this.resolveSymlinks(normalized);
		}

		const targetRow = this.getRow(target);
		if (targetRow) {
			this.sql.exec(
				"UPDATE files SET content = ?, size = ?, mode = ?, mtime_ms = ?, is_dir = 0, symlink_target = NULL WHERE path = ?",
				bytes,
				bytes.byteLength,
				mode,
				now,
				target,
			);
		} else {
			this.ensureParentDirs(target);
			this.sql.exec(
				"INSERT INTO files (path, content, is_dir, mode, size, mtime_ms) VALUES (?, ?, 0, ?, ?, ?)",
				target,
				bytes,
				mode,
				bytes.byteLength,
				now,
			);
		}
	}

	appendFile(path: string, content: string | Uint8Array): void {
		const normalized = normalizePath(path);
		let target = normalized;
		const existingCheck = this.getRow(normalized);
		if (existingCheck?.symlink_target) {
			target = this.resolveSymlinks(normalized);
		}

		const row = this.getRow(target);
		const appendBytes =
			typeof content === "string" ? new TextEncoder().encode(content) : content;

		if (!row) {
			// Create the file
			this.ensureParentDirs(target);
			const now = Date.now();
			this.sql.exec(
				"INSERT INTO files (path, content, is_dir, mode, size, mtime_ms) VALUES (?, ?, 0, 420, ?, ?)",
				target,
				appendBytes,
				appendBytes.byteLength,
				now,
			);
		} else {
			if (row.is_dir) throw EISDIR(path);
			const existing =
				row.content !== null ? new Uint8Array(row.content) : new Uint8Array(0);
			const combined = new Uint8Array(
				existing.byteLength + appendBytes.byteLength,
			);
			combined.set(existing, 0);
			combined.set(appendBytes, existing.byteLength);
			const now = Date.now();
			this.sql.exec(
				"UPDATE files SET content = ?, size = ?, mtime_ms = ? WHERE path = ?",
				combined,
				combined.byteLength,
				now,
				target,
			);
		}
	}

	exists(path: string): boolean {
		const normalized = normalizePath(path);
		return this.getRow(normalized) !== null;
	}

	stat(path: string): FsStatData {
		const resolved = this.resolveSymlinks(normalizePath(path));
		const row = this.getRow(resolved);
		if (!row) throw ENOENT(path);
		return {
			isDir: row.is_dir === 1,
			isSymlink: false, // stat follows symlinks, so never symlink
			size: row.size,
			mode: row.mode,
			mtimeMs: row.mtime_ms,
		};
	}

	lstat(path: string): FsStatData {
		const normalized = normalizePath(path);
		const row = this.getRow(normalized);
		if (!row) throw ENOENT(path);
		return {
			isDir: row.is_dir === 1,
			isSymlink: row.symlink_target !== null,
			size: row.size,
			mode: row.mode,
			mtimeMs: row.mtime_ms,
		};
	}

	mkdir(path: string, opts?: { recursive?: boolean }): void {
		const normalized = normalizePath(path);
		const existing = this.getRow(normalized);

		if (existing) {
			if (existing.is_dir && opts?.recursive) return;
			throw EEXIST(path);
		}

		if (opts?.recursive) {
			this.ensureParentDirs(normalized);
		} else {
			// Check parent exists and is a directory
			const parent = parentDir(normalized);
			const parentRow = this.getRow(parent);
			if (!parentRow) throw ENOENT(parent);
			if (!parentRow.is_dir) throw ENOTDIR(parent);
		}

		const now = Date.now();
		this.sql.exec(
			"INSERT INTO files (path, is_dir, mode, size, mtime_ms) VALUES (?, 1, 493, 0, ?)",
			normalized,
			now,
		);
	}

	readdir(path: string): string[] {
		const normalized = normalizePath(path);
		const row = this.getRow(normalized);
		if (!row) throw ENOENT(path);
		if (!row.is_dir) throw ENOTDIR(path);

		const prefix = normalized === "/" ? "/" : `${normalized}/`;
		const rows = this.sql
			.exec(
				"SELECT path FROM files WHERE path != ? AND path LIKE ?",
				normalized,
				`${prefix}%`,
			)
			.toArray();

		const names = new Set<string>();
		for (const r of rows) {
			const p = r.path as string;
			const rest = p.substring(prefix.length);
			const slashIdx = rest.indexOf("/");
			const name = slashIdx === -1 ? rest : rest.substring(0, slashIdx);
			if (name) names.add(name);
		}
		return [...names].sort();
	}

	readdirWithFileTypes(path: string): DirentData[] {
		const normalized = normalizePath(path);
		const row = this.getRow(normalized);
		if (!row) throw ENOENT(path);
		if (!row.is_dir) throw ENOTDIR(path);

		const prefix = normalized === "/" ? "/" : `${normalized}/`;
		const rows = this.sql
			.exec(
				"SELECT path, is_dir, symlink_target FROM files WHERE path != ? AND path LIKE ?",
				normalized,
				`${prefix}%`,
			)
			.toArray();

		const entries = new Map<string, DirentData>();
		for (const r of rows) {
			const p = r.path as string;
			const rest = p.substring(prefix.length);
			const slashIdx = rest.indexOf("/");
			const name = slashIdx === -1 ? rest : rest.substring(0, slashIdx);
			if (!name || entries.has(name)) continue;

			// For nested entries, they appear as directories
			if (slashIdx !== -1) {
				entries.set(name, {
					name,
					isFile: false,
					isDirectory: true,
					isSymlink: false,
				});
			} else {
				const isDir = (r.is_dir as number) === 1;
				const isSymlink = r.symlink_target !== null;
				entries.set(name, {
					name,
					isFile: !isDir && !isSymlink,
					isDirectory: isDir,
					isSymlink,
				});
			}
		}

		return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
	}

	rm(path: string, opts?: { recursive?: boolean; force?: boolean }): void {
		const normalized = normalizePath(path);
		const row = this.getRow(normalized);

		if (!row) {
			if (opts?.force) return;
			throw ENOENT(path);
		}

		if (row.is_dir) {
			const prefix = normalized === "/" ? "/" : `${normalized}/`;
			const children = this.sql
				.exec("SELECT 1 FROM files WHERE path LIKE ? LIMIT 1", `${prefix}%`)
				.toArray();

			if (children.length > 0) {
				if (!opts?.recursive) throw ENOTEMPTY(path);
				// Delete all descendants
				this.sql.exec("DELETE FROM files WHERE path LIKE ?", `${prefix}%`);
			}
		}

		this.sql.exec("DELETE FROM files WHERE path = ?", normalized);
	}

	cp(src: string, dest: string, opts?: { recursive?: boolean }): void {
		const srcNorm = this.resolveSymlinks(normalizePath(src));
		const destNorm = normalizePath(dest);
		const srcRow = this.getRow(srcNorm);
		if (!srcRow) throw ENOENT(src);

		if (srcRow.is_dir) {
			if (!opts?.recursive) throw EISDIR(src);
			// Copy directory recursively
			const prefix = srcNorm === "/" ? "/" : `${srcNorm}/`;
			const rows = this.sql
				.exec(
					"SELECT * FROM files WHERE path = ? OR path LIKE ?",
					srcNorm,
					`${prefix}%`,
				)
				.toArray();

			this.ensureParentDirs(destNorm);
			const now = Date.now();

			for (const r of rows) {
				const rPath = r.path as string;
				const relativePath =
					rPath === srcNorm ? "" : rPath.substring(srcNorm.length);
				const newPath = destNorm + relativePath;

				const existing = this.getRow(newPath);
				if (existing) {
					this.sql.exec(
						"UPDATE files SET content = ?, is_dir = ?, mode = ?, size = ?, mtime_ms = ?, symlink_target = ? WHERE path = ?",
						r.content as ArrayBuffer | null,
						r.is_dir as number,
						r.mode as number,
						r.size as number,
						now,
						r.symlink_target as string | null,
						newPath,
					);
				} else {
					this.ensureParentDirs(newPath);
					this.sql.exec(
						"INSERT INTO files (path, content, is_dir, mode, size, mtime_ms, symlink_target) VALUES (?, ?, ?, ?, ?, ?, ?)",
						newPath,
						r.content as ArrayBuffer | null,
						r.is_dir as number,
						r.mode as number,
						r.size as number,
						now,
						r.symlink_target as string | null,
					);
				}
			}
		} else {
			// Copy single file
			this.ensureParentDirs(destNorm);
			const now = Date.now();
			const existing = this.getRow(destNorm);
			if (existing) {
				this.sql.exec(
					"UPDATE files SET content = ?, is_dir = 0, mode = ?, size = ?, mtime_ms = ?, symlink_target = NULL WHERE path = ?",
					srcRow.content,
					srcRow.mode,
					srcRow.size,
					now,
					destNorm,
				);
			} else {
				this.sql.exec(
					"INSERT INTO files (path, content, is_dir, mode, size, mtime_ms) VALUES (?, ?, 0, ?, ?, ?)",
					destNorm,
					srcRow.content,
					srcRow.mode,
					srcRow.size,
					now,
				);
			}
		}
	}

	mv(src: string, dest: string): void {
		const srcNorm = normalizePath(src);
		const destNorm = normalizePath(dest);
		const srcRow = this.getRow(srcNorm);
		if (!srcRow) throw ENOENT(src);

		this.ensureParentDirs(destNorm);
		const now = Date.now();

		if (srcRow.is_dir) {
			// Move directory and all descendants
			const prefix = srcNorm === "/" ? "/" : `${srcNorm}/`;
			const rows = this.sql
				.exec("SELECT path FROM files WHERE path LIKE ?", `${prefix}%`)
				.toArray();

			for (const r of rows) {
				const rPath = r.path as string;
				const newPath = destNorm + rPath.substring(srcNorm.length);
				this.ensureParentDirs(newPath);
				this.sql.exec(
					"UPDATE files SET path = ?, mtime_ms = ? WHERE path = ?",
					newPath,
					now,
					rPath,
				);
			}
		}

		// Move or update the entry itself
		const existing = this.getRow(destNorm);
		if (existing) {
			this.sql.exec("DELETE FROM files WHERE path = ?", destNorm);
		}
		this.sql.exec(
			"UPDATE files SET path = ?, mtime_ms = ? WHERE path = ?",
			destNorm,
			now,
			srcNorm,
		);
	}

	chmod(path: string, mode: number): void {
		const resolved = this.resolveSymlinks(normalizePath(path));
		const row = this.getRow(resolved);
		if (!row) throw ENOENT(path);
		this.sql.exec("UPDATE files SET mode = ? WHERE path = ?", mode, resolved);
	}

	symlink(target: string, linkPath: string): void {
		const normalized = normalizePath(linkPath);
		const existing = this.getRow(normalized);
		if (existing) throw EEXIST(linkPath);

		this.ensureParentDirs(normalized);
		const now = Date.now();
		this.sql.exec(
			"INSERT INTO files (path, is_dir, mode, size, mtime_ms, symlink_target) VALUES (?, 0, 511, 0, ?, ?)",
			normalized,
			now,
			target,
		);
	}

	link(existingPath: string, newPath: string): void {
		const existingNorm = this.resolveSymlinks(normalizePath(existingPath));
		const newNorm = normalizePath(newPath);

		const srcRow = this.getRow(existingNorm);
		if (!srcRow) throw ENOENT(existingPath);
		if (srcRow.is_dir) throw EISDIR(existingPath);

		const destRow = this.getRow(newNorm);
		if (destRow) throw EEXIST(newPath);

		this.ensureParentDirs(newNorm);
		const now = Date.now();
		this.sql.exec(
			"INSERT INTO files (path, content, is_dir, mode, size, mtime_ms) VALUES (?, ?, 0, ?, ?, ?)",
			newNorm,
			srcRow.content,
			srcRow.mode,
			srcRow.size,
			now,
		);
	}

	readlink(path: string): string {
		const normalized = normalizePath(path);
		const row = this.getRow(normalized);
		if (!row) throw ENOENT(path);
		if (!row.symlink_target) {
			throw new FsError("EINVAL", "invalid argument", path);
		}
		return row.symlink_target;
	}

	realpath(path: string): string {
		return this.resolveSymlinks(normalizePath(path));
	}

	utimes(path: string, _atimeMs: number, mtimeMs: number): void {
		const resolved = this.resolveSymlinks(normalizePath(path));
		const row = this.getRow(resolved);
		if (!row) throw ENOENT(path);
		this.sql.exec(
			"UPDATE files SET mtime_ms = ? WHERE path = ?",
			mtimeMs,
			resolved,
		);
	}

	getAllPaths(): string[] {
		const rows = this.sql
			.exec("SELECT path FROM files ORDER BY path")
			.toArray();
		return rows.map((r) => r.path as string);
	}
}
