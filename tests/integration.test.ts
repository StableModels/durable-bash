import { beforeEach, describe, expect, test } from "bun:test";
import { DurableFs } from "../src/durable-fs.js";
import type { FsObject } from "../src/fs-object.js";
import { createDirectStub, createTestFsObject } from "./helpers.js";

let fs: DurableFs;
let obj: FsObject;

beforeEach(async () => {
	const result = await createTestFsObject();
	obj = result.obj;
	const stub = createDirectStub(obj);
	fs = new DurableFs(stub, "/home");
	await fs.sync();
});

describe("integration: DurableFs + FsObject", () => {
	test("create, read, list cycle", async () => {
		await fs.writeFile("hello.txt", "world");
		const content = await fs.readFile("hello.txt");
		expect(content).toBe("world");

		const entries = await fs.readdir("/home");
		expect(entries).toContain("hello.txt");
	});

	test("nested directory tree", async () => {
		await fs.mkdir("a/b/c", { recursive: true });
		await fs.writeFile("a/b/c/deep.txt", "deep");

		const aEntries = await fs.readdir("/home/a");
		expect(aEntries).toEqual(["b"]);

		const bEntries = await fs.readdir("/home/a/b");
		expect(bEntries).toEqual(["c"]);

		const cEntries = await fs.readdir("/home/a/b/c");
		expect(cEntries).toEqual(["deep.txt"]);

		const content = await fs.readFile("a/b/c/deep.txt");
		expect(content).toBe("deep");
	});

	test("overwrite preserves directory structure", async () => {
		await fs.writeFile("dir/file.txt", "first");
		await fs.writeFile("dir/file.txt", "second");

		const content = await fs.readFile("dir/file.txt");
		expect(content).toBe("second");

		// Parent dir still exists
		expect(await fs.exists("/home/dir")).toBe(true);
		const stat = await fs.stat("/home/dir");
		expect(stat.isDirectory).toBe(true);
	});

	test("rm -rf on tree", async () => {
		await fs.writeFile("tree/a.txt", "a");
		await fs.writeFile("tree/sub/b.txt", "b");
		await fs.writeFile("tree/sub/deep/c.txt", "c");

		await fs.rm("tree", { recursive: true });

		expect(await fs.exists("/home/tree")).toBe(false);
		expect(await fs.exists("/home/tree/a.txt")).toBe(false);
		expect(await fs.exists("/home/tree/sub/b.txt")).toBe(false);
	});

	test("symlink chain", async () => {
		await fs.writeFile("actual.txt", "real content");
		await fs.symlink("/home/actual.txt", "link1.txt");
		await fs.symlink("/home/link1.txt", "link2.txt");

		// Reading through chain of symlinks
		const content = await fs.readFile("link2.txt");
		expect(content).toBe("real content");

		// lstat sees symlink
		const lstat = await fs.lstat("link2.txt");
		expect(lstat.isSymbolicLink).toBe(true);

		// stat follows symlinks
		const stat = await fs.stat("link2.txt");
		expect(stat.isFile).toBe(true);
		expect(stat.isSymbolicLink).toBe(false);
	});

	test("concurrent writes to different files", async () => {
		await Promise.all([
			fs.writeFile("file1.txt", "content1"),
			fs.writeFile("file2.txt", "content2"),
			fs.writeFile("file3.txt", "content3"),
		]);

		expect(await fs.readFile("file1.txt")).toBe("content1");
		expect(await fs.readFile("file2.txt")).toBe("content2");
		expect(await fs.readFile("file3.txt")).toBe("content3");
	});

	test("stat returns correct FsStat shape", async () => {
		await fs.writeFile("file.txt", "hello");
		const stat = await fs.stat("file.txt");

		expect(stat.isFile).toBe(true);
		expect(stat.isDirectory).toBe(false);
		expect(stat.isSymbolicLink).toBe(false);
		expect(stat.size).toBe(5);
		expect(stat.mode).toBe(0o644);
		expect(stat.mtime).toBeInstanceOf(Date);
	});

	test("readdirWithFileTypes returns DirentEntry shape", async () => {
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

	test("getAllPaths reflects writes", async () => {
		await fs.writeFile("new.txt", "data");
		const paths = fs.getAllPaths();
		expect(paths).toContain("/home/new.txt");
	});

	test("copy file end-to-end", async () => {
		await fs.writeFile("original.txt", "copy me");
		await fs.cp("original.txt", "copied.txt");
		expect(await fs.readFile("copied.txt")).toBe("copy me");
		expect(await fs.readFile("original.txt")).toBe("copy me");
	});

	test("move file end-to-end", async () => {
		await fs.writeFile("before.txt", "moving");
		await fs.mv("before.txt", "after.txt");
		expect(await fs.exists("/home/before.txt")).toBe(false);
		expect(await fs.readFile("after.txt")).toBe("moving");
	});

	test("append creates and appends", async () => {
		await fs.appendFile("log.txt", "line1\n");
		await fs.appendFile("log.txt", "line2\n");
		expect(await fs.readFile("log.txt")).toBe("line1\nline2\n");
	});

	test("chmod changes permissions", async () => {
		await fs.writeFile("script.sh", "#!/bin/sh");
		await fs.chmod("script.sh", 0o755);
		const stat = await fs.stat("script.sh");
		expect(stat.mode).toBe(0o755);
	});

	test("utimes changes mtime", async () => {
		await fs.writeFile("file.txt", "data");
		const mtime = new Date(1700000000000);
		await fs.utimes("file.txt", mtime, mtime);
		const stat = await fs.stat("file.txt");
		expect(stat.mtime.getTime()).toBe(1700000000000);
	});

	test("hard link shares content", async () => {
		await fs.writeFile("original.txt", "shared");
		await fs.link("original.txt", "linked.txt");
		expect(await fs.readFile("linked.txt")).toBe("shared");
	});

	test("realpath resolves symlinks", async () => {
		await fs.writeFile("real.txt", "data");
		await fs.symlink("/home/real.txt", "alias.txt");
		const resolved = await fs.realpath("alias.txt");
		expect(resolved).toBe("/home/real.txt");
	});

	test("binary file roundtrip", async () => {
		const binary = new Uint8Array([0, 1, 127, 128, 255]);
		await fs.writeFile("binary.bin", binary);
		const result = await fs.readFileBuffer("binary.bin");
		expect(result).toEqual(binary);
	});
});
