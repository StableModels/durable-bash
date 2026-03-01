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
import { normalizePath } from "./utils.js";

const DIR_MODE = 0o755;
const FILE_MODE = 0o644;
const SYMLINK_MODE = 0o777;

function parentDir(p: string): string {
	const idx = p.lastIndexOf("/");
	if (idx <= 0) return "/";
	return p.substring(0, idx);
}

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

type FileRow = {
	path: string;
	content: ArrayBuffer | null;
	is_dir: number;
	mode: number;
	size: number;
	mtime_ms: number;
	symlink_target: string | null;
};

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
		const root = this.sql
			.exec("SELECT 1 FROM files WHERE path = '/'")
			.toArray();
		if (root.length === 0) {
			this.sql.exec(
				"INSERT INTO files (path, is_dir, mode, size, mtime_ms) VALUES ('/', 1, ?, 0, ?)",
				DIR_MODE,
				Date.now(),
			);
		}
	}

	// ── Private helpers ──────────────────────────────────────────────

	private getRow(path: string): FileRow | null {
		const rows = this.sql
			.exec("SELECT * FROM files WHERE path = ?", path)
			.toArray();
		if (rows.length === 0) return null;
		return rows[0] as FileRow;
	}

	private resolveSymlinks(path: string, maxDepth = 20): string {
		let current = path;
		for (let i = 0; i < maxDepth; i++) {
			const row = this.getRow(current);
			if (!row) throw ENOENT(path);
			if (!row.symlink_target) return current;
			const target = row.symlink_target.startsWith("/")
				? normalizePath(row.symlink_target)
				: normalizePath(`${parentDir(current)}/${row.symlink_target}`);
			current = target;
		}
		throw new FsError("ELOOP", "too many levels of symbolic links", path);
	}

	/**
	 * Resolve path through symlinks if it exists and is a symlink, otherwise return as-is.
	 */
	private resolveTarget(normalized: string): string {
		const row = this.getRow(normalized);
		if (row?.symlink_target) {
			return this.resolveSymlinks(normalized);
		}
		return normalized;
	}

	private ensureParentDirs(path: string): void {
		const dirs = ancestors(path);
		const now = Date.now();
		for (const dir of dirs) {
			// INSERT OR IGNORE avoids the redundant SELECT per ancestor
			this.sql.exec(
				"INSERT OR IGNORE INTO files (path, is_dir, mode, size, mtime_ms) VALUES (?, 1, ?, 0, ?)",
				dir,
				DIR_MODE,
				now,
			);
		}
	}

	private childPrefix(dirPath: string): string {
		return dirPath === "/" ? "/" : `${dirPath}/`;
	}

	private toBytes(content: string | Uint8Array): Uint8Array {
		return typeof content === "string"
			? new TextEncoder().encode(content)
			: content;
	}

	private bufferToString(buf: ArrayBuffer | null): string {
		return buf !== null ? new TextDecoder().decode(buf) : "";
	}

	private bufferToUint8Array(buf: ArrayBuffer | null): Uint8Array {
		return buf !== null ? new Uint8Array(buf) : new Uint8Array(0);
	}

	private extractChildName(fullPath: string, prefix: string): string | null {
		const rest = fullPath.substring(prefix.length);
		const slashIdx = rest.indexOf("/");
		const name = slashIdx === -1 ? rest : rest.substring(0, slashIdx);
		return name || null;
	}

	private ensureDirRow(path: string, row: FileRow | null): void {
		if (!row) throw ENOENT(path);
		if (!row.is_dir) throw ENOTDIR(path);
	}

	/**
	 * Insert or update a file entry.
	 */
	private upsertFile(
		path: string,
		data: {
			content: ArrayBuffer | Uint8Array | null;
			is_dir: number;
			mode: number;
			size: number;
			mtime_ms: number;
			symlink_target?: string | null;
		},
	): void {
		const existing = this.getRow(path);
		if (existing) {
			this.sql.exec(
				"UPDATE files SET content = ?, is_dir = ?, mode = ?, size = ?, mtime_ms = ?, symlink_target = ? WHERE path = ?",
				data.content,
				data.is_dir,
				data.mode,
				data.size,
				data.mtime_ms,
				data.symlink_target ?? null,
				path,
			);
		} else {
			this.ensureParentDirs(path);
			this.sql.exec(
				"INSERT INTO files (path, content, is_dir, mode, size, mtime_ms, symlink_target) VALUES (?, ?, ?, ?, ?, ?, ?)",
				path,
				data.content,
				data.is_dir,
				data.mode,
				data.size,
				data.mtime_ms,
				data.symlink_target ?? null,
			);
		}
	}

	// ── Public RPC methods ───────────────────────────────────────────

	readFile(path: string): { content: string; encoding: string } {
		const resolved = this.resolveSymlinks(normalizePath(path));
		const row = this.getRow(resolved);
		if (!row) throw ENOENT(path);
		if (row.is_dir) throw EISDIR(path);
		return { content: this.bufferToString(row.content), encoding: "utf-8" };
	}

	readFileBuffer(path: string): { content: Uint8Array } {
		const resolved = this.resolveSymlinks(normalizePath(path));
		const row = this.getRow(resolved);
		if (!row) throw ENOENT(path);
		if (row.is_dir) throw EISDIR(path);
		return { content: this.bufferToUint8Array(row.content) };
	}

	writeFile(
		path: string,
		content: string | Uint8Array,
		opts?: { mode?: number },
	): void {
		const normalized = normalizePath(path);
		const bytes = this.toBytes(content);
		const mode = opts?.mode ?? FILE_MODE;

		const existing = this.getRow(normalized);
		if (existing?.is_dir) throw EISDIR(path);

		const target = existing?.symlink_target
			? this.resolveSymlinks(normalized)
			: normalized;

		this.ensureParentDirs(target);
		this.upsertFile(target, {
			content: bytes,
			is_dir: 0,
			mode,
			size: bytes.byteLength,
			mtime_ms: Date.now(),
		});
	}

	appendFile(path: string, content: string | Uint8Array): void {
		const normalized = normalizePath(path);
		const target = this.resolveTarget(normalized);

		const row = this.getRow(target);
		const appendBytes = this.toBytes(content);

		if (!row) {
			this.ensureParentDirs(target);
			this.sql.exec(
				"INSERT INTO files (path, content, is_dir, mode, size, mtime_ms) VALUES (?, ?, 0, ?, ?, ?)",
				target,
				appendBytes,
				FILE_MODE,
				appendBytes.byteLength,
				Date.now(),
			);
		} else {
			if (row.is_dir) throw EISDIR(path);
			const existing = this.bufferToUint8Array(row.content);
			const combined = new Uint8Array(
				existing.byteLength + appendBytes.byteLength,
			);
			combined.set(existing, 0);
			combined.set(appendBytes, existing.byteLength);
			this.sql.exec(
				"UPDATE files SET content = ?, size = ?, mtime_ms = ? WHERE path = ?",
				combined,
				combined.byteLength,
				Date.now(),
				target,
			);
		}
	}

	exists(path: string): boolean {
		return this.getRow(normalizePath(path)) !== null;
	}

	stat(path: string): FsStatData {
		const resolved = this.resolveSymlinks(normalizePath(path));
		const row = this.getRow(resolved);
		if (!row) throw ENOENT(path);
		return {
			isDir: row.is_dir === 1,
			isSymlink: false,
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
			const parent = parentDir(normalized);
			const parentRow = this.getRow(parent);
			if (!parentRow) throw ENOENT(parent);
			if (!parentRow.is_dir) throw ENOTDIR(parent);
		}

		this.sql.exec(
			"INSERT INTO files (path, is_dir, mode, size, mtime_ms) VALUES (?, 1, ?, 0, ?)",
			normalized,
			DIR_MODE,
			Date.now(),
		);
	}

	readdir(path: string): string[] {
		const normalized = normalizePath(path);
		const row = this.getRow(normalized);
		this.ensureDirRow(path, row);

		const prefix = this.childPrefix(normalized);
		const rows = this.sql
			.exec(
				"SELECT path FROM files WHERE path != ? AND path LIKE ?",
				normalized,
				`${prefix}%`,
			)
			.toArray();

		const names = new Set<string>();
		for (const r of rows) {
			const name = this.extractChildName(r.path as string, prefix);
			if (name) names.add(name);
		}
		return [...names].sort();
	}

	readdirWithFileTypes(path: string): DirentData[] {
		const normalized = normalizePath(path);
		const row = this.getRow(normalized);
		this.ensureDirRow(path, row);

		const prefix = this.childPrefix(normalized);
		const rows = this.sql
			.exec(
				"SELECT path, is_dir, symlink_target FROM files WHERE path != ? AND path LIKE ?",
				normalized,
				`${prefix}%`,
			)
			.toArray();

		const entries = new Map<string, DirentData>();
		for (const r of rows) {
			const fullPath = r.path as string;
			const rest = fullPath.substring(prefix.length);
			const slashIdx = rest.indexOf("/");
			const name = slashIdx === -1 ? rest : rest.substring(0, slashIdx);
			if (!name || entries.has(name)) continue;

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
			const prefix = this.childPrefix(normalized);
			const children = this.sql
				.exec("SELECT 1 FROM files WHERE path LIKE ? LIMIT 1", `${prefix}%`)
				.toArray();

			if (children.length > 0) {
				if (!opts?.recursive) throw ENOTEMPTY(path);
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

		const now = Date.now();

		if (srcRow.is_dir) {
			if (!opts?.recursive) throw EISDIR(src);
			const prefix = this.childPrefix(srcNorm);
			const rows = this.sql
				.exec(
					"SELECT * FROM files WHERE path = ? OR path LIKE ?",
					srcNorm,
					`${prefix}%`,
				)
				.toArray();

			this.ensureParentDirs(destNorm);

			for (const r of rows) {
				const rPath = r.path as string;
				const relativePath =
					rPath === srcNorm ? "" : rPath.substring(srcNorm.length);
				this.upsertFile(destNorm + relativePath, {
					content: r.content as ArrayBuffer | null,
					is_dir: r.is_dir as number,
					mode: r.mode as number,
					size: r.size as number,
					mtime_ms: now,
					symlink_target: r.symlink_target as string | null,
				});
			}
		} else {
			this.upsertFile(destNorm, {
				content: srcRow.content,
				is_dir: 0,
				mode: srcRow.mode,
				size: srcRow.size,
				mtime_ms: now,
			});
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
			const prefix = this.childPrefix(srcNorm);
			const rows = this.sql
				.exec("SELECT path FROM files WHERE path LIKE ?", `${prefix}%`)
				.toArray();

			// All descendants share the same new parent prefix — the directory
			// entry itself (moved below) covers the intermediate dirs, so no
			// per-child ensureParentDirs is needed.
			for (const r of rows) {
				const rPath = r.path as string;
				const newPath = destNorm + rPath.substring(srcNorm.length);
				this.sql.exec(
					"UPDATE files SET path = ?, mtime_ms = ? WHERE path = ?",
					newPath,
					now,
					rPath,
				);
			}
		}

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
		this.sql.exec(
			"INSERT INTO files (path, is_dir, mode, size, mtime_ms, symlink_target) VALUES (?, 0, ?, 0, ?, ?)",
			normalized,
			SYMLINK_MODE,
			Date.now(),
			target,
		);
	}

	/**
	 * Create a hard link. Note: this copies content at call time rather than
	 * sharing underlying storage — subsequent writes to one path will not
	 * update the other. This matches the IFileSystem contract but differs
	 * from POSIX hard link semantics.
	 */
	link(existingPath: string, newPath: string): void {
		const existingNorm = this.resolveSymlinks(normalizePath(existingPath));
		const newNorm = normalizePath(newPath);

		const srcRow = this.getRow(existingNorm);
		if (!srcRow) throw ENOENT(existingPath);
		if (srcRow.is_dir) throw EISDIR(existingPath);

		const destRow = this.getRow(newNorm);
		if (destRow) throw EEXIST(newPath);

		this.ensureParentDirs(newNorm);
		this.sql.exec(
			"INSERT INTO files (path, content, is_dir, mode, size, mtime_ms) VALUES (?, ?, 0, ?, ?, ?)",
			newNorm,
			srcRow.content,
			srcRow.mode,
			srcRow.size,
			Date.now(),
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
