import { beforeEach, describe, expect, test } from "bun:test";
import { DurableFs } from "../src/durable-fs.js";
import { normalizePath } from "../src/fs-object.js";

// ─── Mock stub ────────────────────────────────────────────────────────

function createMockStub() {
	const calls: { method: string; args: unknown[] }[] = [];

	const stub = new Proxy(
		{},
		{
			get(_target, prop: string) {
				return (...args: unknown[]) => {
					calls.push({ method: prop, args });
					// Return canned responses based on method
					switch (prop) {
						case "readFile":
							return Promise.resolve({
								content: "mock content",
								encoding: "utf-8",
							});
						case "readFileBuffer":
							return Promise.resolve({
								content: new Uint8Array([1, 2, 3]),
							});
						case "exists":
							return Promise.resolve(true);
						case "stat":
						case "lstat":
							return Promise.resolve({
								isDir: false,
								isSymlink: false,
								size: 42,
								mode: 0o644,
								mtimeMs: 1700000000000,
							});
						case "readdir":
							return Promise.resolve(["a.txt", "b.txt"]);
						case "readdirWithFileTypes":
							return Promise.resolve([
								{
									name: "file.txt",
									isFile: true,
									isDirectory: false,
									isSymlink: false,
								},
								{
									name: "dir",
									isFile: false,
									isDirectory: true,
									isSymlink: false,
								},
							]);
						case "readlink":
							return Promise.resolve("/target");
						case "realpath":
							return Promise.resolve("/resolved");
						case "getAllPaths":
							return Promise.resolve(["/", "/a.txt", "/dir", "/dir/b.txt"]);
						default:
							return Promise.resolve();
					}
				};
			},
		},
	);

	return { stub: stub as never, calls };
}

// ─── Tests ────────────────────────────────────────────────────────────

describe("DurableFs", () => {
	let fs: DurableFs;
	let calls: { method: string; args: unknown[] }[];

	beforeEach(() => {
		const mock = createMockStub();
		fs = new DurableFs(mock.stub, "/home");
		calls = mock.calls;
	});

	describe("path resolution", () => {
		test("resolvePath handles relative path", () => {
			expect(fs.resolvePath("/home", "foo.txt")).toBe("/home/foo.txt");
		});

		test("resolvePath handles absolute path", () => {
			expect(fs.resolvePath("/home", "/etc/x")).toBe("/etc/x");
		});

		test("resolvePath normalizes ..", () => {
			expect(fs.resolvePath("/a/b", "../c")).toBe("/a/c");
		});

		test("resolvePath normalizes .", () => {
			expect(fs.resolvePath("/a/b", "./c")).toBe("/a/b/c");
		});
	});

	describe("readFile", () => {
		test("delegates to stub with resolved path", async () => {
			const content = await fs.readFile("test.txt");
			expect(content).toBe("mock content");
			expect(calls[0].method).toBe("readFile");
			expect(calls[0].args[0]).toBe("/home/test.txt");
		});

		test("handles absolute path", async () => {
			await fs.readFile("/etc/config");
			expect(calls[0].args[0]).toBe("/etc/config");
		});
	});

	describe("readFileBuffer", () => {
		test("delegates to stub", async () => {
			const result = await fs.readFileBuffer("data.bin");
			expect(result).toBeInstanceOf(Uint8Array);
			expect(calls[0].method).toBe("readFileBuffer");
			expect(calls[0].args[0]).toBe("/home/data.bin");
		});
	});

	describe("writeFile", () => {
		test("delegates to stub", async () => {
			await fs.writeFile("output.txt", "hello");
			expect(calls[0].method).toBe("writeFile");
			expect(calls[0].args[0]).toBe("/home/output.txt");
			expect(calls[0].args[1]).toBe("hello");
		});
	});

	describe("appendFile", () => {
		test("delegates to stub", async () => {
			await fs.appendFile("log.txt", "line\n");
			expect(calls[0].method).toBe("appendFile");
			expect(calls[0].args[0]).toBe("/home/log.txt");
		});
	});

	describe("exists", () => {
		test("delegates to stub", async () => {
			const result = await fs.exists("test.txt");
			expect(result).toBe(true);
			expect(calls[0].args[0]).toBe("/home/test.txt");
		});
	});

	describe("stat", () => {
		test("returns FsStat with correct shape", async () => {
			const s = await fs.stat("file.txt");
			expect(s.isFile).toBe(true);
			expect(s.isDirectory).toBe(false);
			expect(s.isSymbolicLink).toBe(false);
			expect(s.size).toBe(42);
			expect(s.mode).toBe(0o644);
			expect(s.mtime).toBeInstanceOf(Date);
			expect(s.mtime.getTime()).toBe(1700000000000);
		});
	});

	describe("lstat", () => {
		test("delegates to stub lstat", async () => {
			await fs.lstat("link.txt");
			expect(calls[0].method).toBe("lstat");
		});
	});

	describe("mkdir", () => {
		test("delegates with options", async () => {
			await fs.mkdir("newdir", { recursive: true });
			expect(calls[0].method).toBe("mkdir");
			expect(calls[0].args[0]).toBe("/home/newdir");
			expect(calls[0].args[1]).toEqual({ recursive: true });
		});
	});

	describe("readdir", () => {
		test("delegates and returns names", async () => {
			const result = await fs.readdir(".");
			expect(result).toEqual(["a.txt", "b.txt"]);
		});
	});

	describe("readdirWithFileTypes", () => {
		test("wraps DirentEntry correctly", async () => {
			const entries = await fs.readdirWithFileTypes(".");
			expect(entries).toHaveLength(2);

			const file = entries[0];
			expect(file.name).toBe("file.txt");
			expect(file.isFile).toBe(true);
			expect(file.isDirectory).toBe(false);
			expect(file.isSymbolicLink).toBe(false);

			const dir = entries[1];
			expect(dir.name).toBe("dir");
			expect(dir.isFile).toBe(false);
			expect(dir.isDirectory).toBe(true);
		});
	});

	describe("rm", () => {
		test("delegates with options", async () => {
			await fs.rm("file.txt", { recursive: true, force: true });
			expect(calls[0].method).toBe("rm");
			expect(calls[0].args[1]).toEqual({ recursive: true, force: true });
		});
	});

	describe("cp", () => {
		test("resolves both paths", async () => {
			await fs.cp("src.txt", "dest.txt");
			expect(calls[0].method).toBe("cp");
			expect(calls[0].args[0]).toBe("/home/src.txt");
			expect(calls[0].args[1]).toBe("/home/dest.txt");
		});
	});

	describe("mv", () => {
		test("resolves both paths", async () => {
			await fs.mv("old.txt", "new.txt");
			expect(calls[0].method).toBe("mv");
			expect(calls[0].args[0]).toBe("/home/old.txt");
			expect(calls[0].args[1]).toBe("/home/new.txt");
		});
	});

	describe("chmod", () => {
		test("delegates to stub", async () => {
			await fs.chmod("file.txt", 0o755);
			expect(calls[0].method).toBe("chmod");
			expect(calls[0].args[1]).toBe(0o755);
		});
	});

	describe("symlink", () => {
		test("resolves link path", async () => {
			await fs.symlink("/target", "link.txt");
			expect(calls[0].method).toBe("symlink");
			expect(calls[0].args[0]).toBe("/target");
			expect(calls[0].args[1]).toBe("/home/link.txt");
		});
	});

	describe("link", () => {
		test("resolves both paths", async () => {
			await fs.link("existing.txt", "new.txt");
			expect(calls[0].method).toBe("link");
			expect(calls[0].args[0]).toBe("/home/existing.txt");
			expect(calls[0].args[1]).toBe("/home/new.txt");
		});
	});

	describe("readlink", () => {
		test("delegates to stub", async () => {
			const target = await fs.readlink("link.txt");
			expect(target).toBe("/target");
		});
	});

	describe("realpath", () => {
		test("delegates to stub", async () => {
			const resolved = await fs.realpath("link.txt");
			expect(resolved).toBe("/resolved");
		});
	});

	describe("utimes", () => {
		test("converts Date to ms", async () => {
			const atime = new Date(1700000000000);
			const mtime = new Date(1700000001000);
			await fs.utimes("file.txt", atime, mtime);
			expect(calls[0].method).toBe("utimes");
			expect(calls[0].args[1]).toBe(1700000000000);
			expect(calls[0].args[2]).toBe(1700000001000);
		});
	});

	describe("sync and getAllPaths", () => {
		test("sync populates cache", async () => {
			await fs.sync();
			const paths = fs.getAllPaths();
			expect(paths).toEqual(["/", "/a.txt", "/dir", "/dir/b.txt"]);
		});

		test("getAllPaths returns empty before sync", () => {
			expect(fs.getAllPaths()).toEqual([]);
		});

		test("writeFile adds to cache", async () => {
			await fs.sync();
			await fs.writeFile("new.txt", "data");
			expect(fs.getAllPaths()).toContain("/home/new.txt");
		});

		test("rm removes from cache", async () => {
			await fs.sync();
			await fs.rm("/a.txt");
			expect(fs.getAllPaths()).not.toContain("/a.txt");
		});

		test("rm removes descendants from cache", async () => {
			await fs.sync();
			await fs.rm("/dir", { recursive: true });
			expect(fs.getAllPaths()).not.toContain("/dir");
			expect(fs.getAllPaths()).not.toContain("/dir/b.txt");
		});
	});
});

// ─── normalizePath standalone tests ───────────────────────────────────

describe("normalizePath", () => {
	test("root", () => expect(normalizePath("/")).toBe("/"));
	test("empty", () => expect(normalizePath("")).toBe("/"));
	test("simple", () => expect(normalizePath("/a/b/c")).toBe("/a/b/c"));
	test("trailing slash", () => expect(normalizePath("/a/b/")).toBe("/a/b"));
	test("double slash", () => expect(normalizePath("/a//b")).toBe("/a/b"));
	test("dot", () => expect(normalizePath("/a/./b")).toBe("/a/b"));
	test("dotdot", () => expect(normalizePath("/a/b/../c")).toBe("/a/c"));
	test("dotdot at root", () => expect(normalizePath("/a/../../b")).toBe("/b"));
});
