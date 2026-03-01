export class FsError extends Error {
	constructor(
		public readonly code: string,
		message: string,
		public readonly path?: string,
	) {
		super(`${code}: ${message}${path ? `, '${path}'` : ""}`);
		this.name = "FsError";
	}
}

export const ENOENT = (path: string) =>
	new FsError("ENOENT", "no such file or directory", path);
export const EEXIST = (path: string) =>
	new FsError("EEXIST", "file already exists", path);
export const EISDIR = (path: string) =>
	new FsError("EISDIR", "illegal operation on a directory", path);
export const ENOTDIR = (path: string) =>
	new FsError("ENOTDIR", "not a directory", path);
export const ENOTEMPTY = (path: string) =>
	new FsError("ENOTEMPTY", "directory not empty", path);
