import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DurableFs } from "../../src/durable-fs.js";
import type { FsObject } from "../../src/fs-object.js";

async function createFs(name: string, cwd = "/home"): Promise<DurableFs> {
	return DurableFs.create(
		env.FS as DurableObjectNamespace<FsObject>,
		name,
		cwd,
	);
}

describe("DurableFs adapter in workerd", () => {
	it("create, read, list cycle", async () => {
		const fs = await createFs("cycle");
		await fs.writeFile("hello.txt", "world");
		const content = await fs.readFile("hello.txt");
		expect(content).toBe("world");

		const entries = await fs.readdir("/home");
		expect(entries).toContain("hello.txt");
	});

	it("nested directory tree", async () => {
		const fs = await createFs("nested");
		await fs.mkdir("a/b/c", { recursive: true });
		await fs.writeFile("a/b/c/deep.txt", "deep");

		expect(await fs.readdir("/home/a")).toEqual(["b"]);
		expect(await fs.readdir("/home/a/b")).toEqual(["c"]);
		expect(await fs.readdir("/home/a/b/c")).toEqual(["deep.txt"]);
		expect(await fs.readFile("a/b/c/deep.txt")).toBe("deep");
	});

	it("stat returns FsStat with boolean properties", async () => {
		const fs = await createFs("stat");
		await fs.writeFile("file.txt", "hello");
		const stat = await fs.stat("file.txt");

		// IFileSystem uses boolean properties, not methods
		expect(stat.isFile).toBe(true);
		expect(stat.isDirectory).toBe(false);
		expect(stat.isSymbolicLink).toBe(false);
		expect(stat.size).toBe(5);
		expect(stat.mode).toBe(0o644);
		expect(stat.mtime).toBeInstanceOf(Date);
	});

	it("readdirWithFileTypes returns DirentEntry shape", async () => {
		const fs = await createFs("dirent");
		await fs.writeFile("dir/file.txt", "data");
		await fs.mkdir("dir/subdir");

		const entries = await fs.readdirWithFileTypes("/home/dir");
		expect(entries).toHaveLength(2);

		const file = entries.find((e) => e.name === "file.txt")!;
		expect(file.isFile).toBe(true);
		expect(file.isDirectory).toBe(false);
		expect(file.isSymbolicLink).toBe(false);

		const dir = entries.find((e) => e.name === "subdir")!;
		expect(dir.isFile).toBe(false);
		expect(dir.isDirectory).toBe(true);
	});

	it("getAllPaths cache stays in sync with writes", async () => {
		const fs = await createFs("cache-sync");
		await fs.writeFile("new.txt", "data");
		const paths = fs.getAllPaths();
		expect(paths).toContain("/home/new.txt");
		expect(paths).toContain("/home");
		expect(paths).toContain("/");
	});

	it("getAllPaths cache stays in sync with deletes", async () => {
		const fs = await createFs("cache-delete");
		await fs.writeFile("gone.txt", "data");
		expect(fs.getAllPaths()).toContain("/home/gone.txt");
		await fs.rm("gone.txt");
		expect(fs.getAllPaths()).not.toContain("/home/gone.txt");
	});

	it("binary file round-trip through adapter", async () => {
		const fs = await createFs("binary");
		const binary = new Uint8Array([0, 1, 127, 128, 255]);
		await fs.writeFile("binary.bin", binary);
		const result = await fs.readFileBuffer("binary.bin");
		expect(new Uint8Array(result)).toEqual(binary);
	});

	it("symlink chain through adapter", async () => {
		const fs = await createFs("symlink-chain");
		await fs.writeFile("actual.txt", "real content");
		await fs.symlink("/home/actual.txt", "link1.txt");
		await fs.symlink("/home/link1.txt", "link2.txt");

		const content = await fs.readFile("link2.txt");
		expect(content).toBe("real content");

		const lstat = await fs.lstat("link2.txt");
		expect(lstat.isSymbolicLink).toBe(true);

		const stat = await fs.stat("link2.txt");
		expect(stat.isFile).toBe(true);
		expect(stat.isSymbolicLink).toBe(false);
	});

	it("copy file end-to-end", async () => {
		const fs = await createFs("copy");
		await fs.writeFile("original.txt", "copy me");
		await fs.cp("original.txt", "copied.txt");
		expect(await fs.readFile("copied.txt")).toBe("copy me");
		expect(await fs.readFile("original.txt")).toBe("copy me");
		// Cache should include both
		expect(fs.getAllPaths()).toContain("/home/copied.txt");
	});

	it("move file end-to-end", async () => {
		const fs = await createFs("move");
		await fs.writeFile("before.txt", "moving");
		await fs.mv("before.txt", "after.txt");
		expect(await fs.exists("/home/before.txt")).toBe(false);
		expect(await fs.readFile("after.txt")).toBe("moving");
		// Cache should reflect the move
		expect(fs.getAllPaths()).not.toContain("/home/before.txt");
		expect(fs.getAllPaths()).toContain("/home/after.txt");
	});

	it("append creates and appends", async () => {
		const fs = await createFs("append");
		await fs.appendFile("log.txt", "line1\n");
		await fs.appendFile("log.txt", "line2\n");
		expect(await fs.readFile("log.txt")).toBe("line1\nline2\n");
	});

	it("chmod changes permissions", async () => {
		const fs = await createFs("chmod");
		await fs.writeFile("script.sh", "#!/bin/sh");
		await fs.chmod("script.sh", 0o755);
		const stat = await fs.stat("script.sh");
		expect(stat.mode).toBe(0o755);
	});

	it("rm -rf on tree", async () => {
		const fs = await createFs("rmrf");
		await fs.writeFile("tree/a.txt", "a");
		await fs.writeFile("tree/sub/b.txt", "b");
		await fs.rm("tree", { recursive: true });

		expect(await fs.exists("/home/tree")).toBe(false);
		expect(await fs.exists("/home/tree/a.txt")).toBe(false);
	});
});
