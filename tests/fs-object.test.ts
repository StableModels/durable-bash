import { beforeEach, describe, expect, test } from "bun:test";
import { createTestFsObject } from "./helpers.js";

import type { FsObject } from "../src/fs-object.js";

let obj: FsObject;

beforeEach(async () => {
	const result = await createTestFsObject();
	obj = result.obj;
});

// ─── Basic File Operations ────────────────────────────────────────────

describe("writeFile + readFile", () => {
	test("roundtrip", () => {
		obj.writeFile("/hello.txt", "hello world");
		const result = obj.readFile("/hello.txt");
		expect(result.content).toBe("hello world");
		expect(result.encoding).toBe("utf-8");
	});

	test("creates parent directories automatically", () => {
		obj.writeFile("/a/b/c.txt", "deep");
		expect(obj.exists("/a")).toBe(true);
		expect(obj.exists("/a/b")).toBe(true);
		const stat = obj.stat("/a");
		expect(stat.isDir).toBe(true);
	});

	test("overwrites existing file", () => {
		obj.writeFile("/file.txt", "first");
		obj.writeFile("/file.txt", "second");
		expect(obj.readFile("/file.txt").content).toBe("second");
	});

	test("readFile throws ENOENT for missing file", () => {
		expect(() => obj.readFile("/missing.txt")).toThrow("ENOENT");
	});

	test("readFile throws EISDIR for directory", () => {
		obj.mkdir("/mydir");
		expect(() => obj.readFile("/mydir")).toThrow("EISDIR");
	});
});

describe("readFileBuffer", () => {
	test("returns Uint8Array for text content", () => {
		obj.writeFile("/test.txt", "hello");
		const result = obj.readFileBuffer("/test.txt");
		expect(result.content).toBeInstanceOf(Uint8Array);
		expect(new TextDecoder().decode(result.content)).toBe("hello");
	});

	test("preserves binary content", () => {
		const binary = new Uint8Array([0, 1, 2, 255, 128]);
		obj.writeFile("/binary.bin", binary);
		const result = obj.readFileBuffer("/binary.bin");
		expect(result.content).toEqual(binary);
	});
});

describe("appendFile", () => {
	test("creates file if missing", () => {
		obj.appendFile("/new.txt", "hello");
		expect(obj.readFile("/new.txt").content).toBe("hello");
	});

	test("appends to existing file", () => {
		obj.writeFile("/log.txt", "line1\n");
		obj.appendFile("/log.txt", "line2\n");
		expect(obj.readFile("/log.txt").content).toBe("line1\nline2\n");
	});

	test("throws EISDIR on directory", () => {
		obj.mkdir("/dir");
		expect(() => obj.appendFile("/dir", "data")).toThrow("EISDIR");
	});
});

// ─── exists ───────────────────────────────────────────────────────────

describe("exists", () => {
	test("returns true for existing file", () => {
		obj.writeFile("/file.txt", "data");
		expect(obj.exists("/file.txt")).toBe(true);
	});

	test("returns true for existing directory", () => {
		obj.mkdir("/dir");
		expect(obj.exists("/dir")).toBe(true);
	});

	test("returns false for missing path", () => {
		expect(obj.exists("/nope")).toBe(false);
	});

	test("returns true for root", () => {
		expect(obj.exists("/")).toBe(true);
	});
});

// ─── stat ─────────────────────────────────────────────────────────────

describe("stat", () => {
	test("returns correct shape for file", () => {
		obj.writeFile("/file.txt", "hello");
		const s = obj.stat("/file.txt");
		expect(s.isDir).toBe(false);
		expect(s.isSymlink).toBe(false);
		expect(s.size).toBe(5);
		expect(s.mode).toBe(0o644);
		expect(typeof s.mtimeMs).toBe("number");
	});

	test("returns correct shape for directory", () => {
		obj.mkdir("/dir");
		const s = obj.stat("/dir");
		expect(s.isDir).toBe(true);
		expect(s.isSymlink).toBe(false);
	});

	test("throws ENOENT for missing path", () => {
		expect(() => obj.stat("/missing")).toThrow("ENOENT");
	});
});

// ─── mkdir ────────────────────────────────────────────────────────────

describe("mkdir", () => {
	test("creates directory", () => {
		obj.mkdir("/newdir");
		expect(obj.exists("/newdir")).toBe(true);
		expect(obj.stat("/newdir").isDir).toBe(true);
	});

	test("recursive creates full chain", () => {
		obj.mkdir("/a/b/c", { recursive: true });
		expect(obj.exists("/a")).toBe(true);
		expect(obj.exists("/a/b")).toBe(true);
		expect(obj.exists("/a/b/c")).toBe(true);
	});

	test("throws EEXIST for existing path (non-recursive)", () => {
		obj.mkdir("/existing");
		expect(() => obj.mkdir("/existing")).toThrow("EEXIST");
	});

	test("recursive on existing dir is no-op", () => {
		obj.mkdir("/existing");
		obj.mkdir("/existing", { recursive: true }); // Should not throw
		expect(obj.exists("/existing")).toBe(true);
	});

	test("throws ENOENT if parent doesn't exist (non-recursive)", () => {
		expect(() => obj.mkdir("/no/parent")).toThrow("ENOENT");
	});
});

// ─── readdir ──────────────────────────────────────────────────────────

describe("readdir", () => {
	test("lists direct children only", () => {
		obj.writeFile("/dir/a.txt", "a");
		obj.writeFile("/dir/b.txt", "b");
		obj.writeFile("/dir/sub/c.txt", "c");
		const entries = obj.readdir("/dir");
		expect(entries).toEqual(["a.txt", "b.txt", "sub"]);
	});

	test("throws ENOTDIR for a file", () => {
		obj.writeFile("/file.txt", "data");
		expect(() => obj.readdir("/file.txt")).toThrow("ENOTDIR");
	});

	test("throws ENOENT for missing directory", () => {
		expect(() => obj.readdir("/missing")).toThrow("ENOENT");
	});

	test("returns empty array for empty directory", () => {
		obj.mkdir("/empty");
		expect(obj.readdir("/empty")).toEqual([]);
	});
});

describe("readdirWithFileTypes", () => {
	test("returns DirentData with correct flags", () => {
		obj.writeFile("/dir/file.txt", "data");
		obj.mkdir("/dir/subdir");
		const entries = obj.readdirWithFileTypes("/dir");
		expect(entries).toHaveLength(2);

		const file = entries.find((e) => e.name === "file.txt");
		expect(file?.isFile).toBe(true);
		expect(file?.isDirectory).toBe(false);

		const dir = entries.find((e) => e.name === "subdir");
		expect(dir?.isFile).toBe(false);
		expect(dir?.isDirectory).toBe(true);
	});
});

// ─── rm ───────────────────────────────────────────────────────────────

describe("rm", () => {
	test("removes a file", () => {
		obj.writeFile("/file.txt", "data");
		obj.rm("/file.txt");
		expect(obj.exists("/file.txt")).toBe(false);
	});

	test("removes directory recursively", () => {
		obj.writeFile("/dir/a.txt", "a");
		obj.writeFile("/dir/sub/b.txt", "b");
		obj.rm("/dir", { recursive: true });
		expect(obj.exists("/dir")).toBe(false);
		expect(obj.exists("/dir/a.txt")).toBe(false);
		expect(obj.exists("/dir/sub/b.txt")).toBe(false);
	});

	test("throws ENOENT for missing path (no force)", () => {
		expect(() => obj.rm("/missing")).toThrow("ENOENT");
	});

	test("force ignores ENOENT", () => {
		obj.rm("/missing", { force: true }); // Should not throw
	});

	test("throws ENOTEMPTY for non-recursive rm on non-empty dir", () => {
		obj.writeFile("/dir/file.txt", "data");
		expect(() => obj.rm("/dir")).toThrow("ENOTEMPTY");
	});
});

// ─── cp ───────────────────────────────────────────────────────────────

describe("cp", () => {
	test("copies a file", () => {
		obj.writeFile("/src.txt", "content");
		obj.cp("/src.txt", "/dest.txt");
		expect(obj.readFile("/dest.txt").content).toBe("content");
		// Original still exists
		expect(obj.readFile("/src.txt").content).toBe("content");
	});

	test("copies directory recursively", () => {
		obj.writeFile("/src/a.txt", "a");
		obj.writeFile("/src/sub/b.txt", "b");
		obj.cp("/src", "/dest", { recursive: true });
		expect(obj.readFile("/dest/a.txt").content).toBe("a");
		expect(obj.readFile("/dest/sub/b.txt").content).toBe("b");
	});

	test("throws EISDIR for directory without recursive", () => {
		obj.mkdir("/dir");
		expect(() => obj.cp("/dir", "/copy")).toThrow("EISDIR");
	});
});

// ─── mv ───────────────────────────────────────────────────────────────

describe("mv", () => {
	test("moves a file", () => {
		obj.writeFile("/old.txt", "data");
		obj.mv("/old.txt", "/new.txt");
		expect(obj.exists("/old.txt")).toBe(false);
		expect(obj.readFile("/new.txt").content).toBe("data");
	});

	test("moves a directory with contents", () => {
		obj.writeFile("/old/file.txt", "data");
		obj.mv("/old", "/new");
		expect(obj.exists("/old")).toBe(false);
		expect(obj.readFile("/new/file.txt").content).toBe("data");
	});

	test("throws ENOENT for missing source", () => {
		expect(() => obj.mv("/missing", "/dest")).toThrow("ENOENT");
	});
});

// ─── chmod ────────────────────────────────────────────────────────────

describe("chmod", () => {
	test("changes mode", () => {
		obj.writeFile("/file.txt", "data");
		obj.chmod("/file.txt", 0o755);
		expect(obj.stat("/file.txt").mode).toBe(0o755);
	});

	test("throws ENOENT for missing path", () => {
		expect(() => obj.chmod("/missing", 0o644)).toThrow("ENOENT");
	});
});

// ─── symlink ──────────────────────────────────────────────────────────

describe("symlink", () => {
	test("creates symlink and readlink returns target", () => {
		obj.writeFile("/target.txt", "data");
		obj.symlink("/target.txt", "/link.txt");
		expect(obj.readlink("/link.txt")).toBe("/target.txt");
	});

	test("readFile follows symlink", () => {
		obj.writeFile("/target.txt", "hello");
		obj.symlink("/target.txt", "/link.txt");
		expect(obj.readFile("/link.txt").content).toBe("hello");
	});

	test("lstat does not follow symlink", () => {
		obj.writeFile("/target.txt", "hello");
		obj.symlink("/target.txt", "/link.txt");
		const s = obj.lstat("/link.txt");
		expect(s.isSymlink).toBe(true);
		expect(s.isDir).toBe(false);
	});

	test("stat follows symlink", () => {
		obj.writeFile("/target.txt", "hello");
		obj.symlink("/target.txt", "/link.txt");
		const s = obj.stat("/link.txt");
		expect(s.isSymlink).toBe(false);
		expect(s.isDir).toBe(false);
		expect(s.size).toBe(5);
	});

	test("throws EEXIST when link path exists", () => {
		obj.writeFile("/target.txt", "data");
		obj.writeFile("/existing.txt", "existing");
		expect(() => obj.symlink("/target.txt", "/existing.txt")).toThrow("EEXIST");
	});

	test("writeFile through symlink writes to target", () => {
		obj.writeFile("/target.txt", "original");
		obj.symlink("/target.txt", "/link.txt");
		obj.writeFile("/link.txt", "updated");
		expect(obj.readFile("/target.txt").content).toBe("updated");
		expect(obj.readFile("/link.txt").content).toBe("updated");
	});

	test("readFile on broken symlink throws ENOENT", () => {
		obj.symlink("/nonexistent.txt", "/broken-link.txt");
		expect(obj.exists("/broken-link.txt")).toBe(true);
		expect(() => obj.readFile("/broken-link.txt")).toThrow("ENOENT");
	});
});

// ─── hard link ────────────────────────────────────────────────────────

describe("link (hard link)", () => {
	test("creates hard link that reads same content", () => {
		obj.writeFile("/original.txt", "shared content");
		obj.link("/original.txt", "/hardlink.txt");
		expect(obj.readFile("/hardlink.txt").content).toBe("shared content");
	});

	test("throws ENOENT for missing source", () => {
		expect(() => obj.link("/missing.txt", "/link.txt")).toThrow("ENOENT");
	});

	test("throws EEXIST for existing destination", () => {
		obj.writeFile("/src.txt", "data");
		obj.writeFile("/dest.txt", "existing");
		expect(() => obj.link("/src.txt", "/dest.txt")).toThrow("EEXIST");
	});
});

// ─── realpath ─────────────────────────────────────────────────────────

describe("realpath", () => {
	test("resolves chain of symlinks", () => {
		obj.writeFile("/actual.txt", "data");
		obj.symlink("/actual.txt", "/link1.txt");
		obj.symlink("/link1.txt", "/link2.txt");
		expect(obj.realpath("/link2.txt")).toBe("/actual.txt");
	});

	test("returns same path for non-symlink", () => {
		obj.writeFile("/file.txt", "data");
		expect(obj.realpath("/file.txt")).toBe("/file.txt");
	});
});

// ─── utimes ───────────────────────────────────────────────────────────

describe("utimes", () => {
	test("updates mtime", () => {
		obj.writeFile("/file.txt", "data");
		const newMtime = 1700000000000;
		obj.utimes("/file.txt", newMtime, newMtime);
		expect(obj.stat("/file.txt").mtimeMs).toBe(newMtime);
	});

	test("throws ENOENT for missing path", () => {
		expect(() => obj.utimes("/missing", 0, 0)).toThrow("ENOENT");
	});
});

// ─── getAllPaths ───────────────────────────────────────────────────────

describe("getAllPaths", () => {
	test("returns all paths including root", () => {
		obj.writeFile("/a.txt", "a");
		obj.mkdir("/dir");
		obj.writeFile("/dir/b.txt", "b");
		const paths = obj.getAllPaths();
		expect(paths).toContain("/");
		expect(paths).toContain("/a.txt");
		expect(paths).toContain("/dir");
		expect(paths).toContain("/dir/b.txt");
	});

	test("returns sorted paths", () => {
		obj.writeFile("/z.txt", "z");
		obj.writeFile("/a.txt", "a");
		const paths = obj.getAllPaths();
		const sorted = [...paths].sort();
		expect(paths).toEqual(sorted);
	});
});

// ─── Path normalization ───────────────────────────────────────────────

describe("path normalization", () => {
	test("handles dot segments", () => {
		obj.writeFile("/a/b/../c.txt", "data");
		expect(obj.readFile("/a/c.txt").content).toBe("data");
	});

	test("handles double slashes", () => {
		obj.writeFile("/a//b.txt", "data");
		expect(obj.readFile("/a/b.txt").content).toBe("data");
	});
});
