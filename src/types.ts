/** Wire format for stat results (serializable over RPC) */
export interface FsStatData {
	isDir: boolean;
	isSymlink: boolean;
	size: number;
	mode: number;
	mtimeMs: number;
}

/** Wire format for directory entries (serializable over RPC) */
export interface DirentData {
	name: string;
	isFile: boolean;
	isDirectory: boolean;
	isSymlink: boolean;
}
