import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { FsObject } from "../../src/fs-object.js";

function getStub(name = "test"): DurableObjectStub<FsObject> {
	const id = env.FS.idFromName(name);
	return env.FS.get(id);
}

describe("FsObject in workerd", () => {
	it("writeFile and readFile round-trip text", async () => {
		const stub = getStub("text-roundtrip");
		await stub.writeFile("/test.txt", "hello world");
		const result = await stub.readFile("/test.txt");
		expect(result.content).toBe("hello world");
		expect(result.encoding).toBe("utf-8");
	});

	it("writeFile and readFileBuffer round-trip binary", async () => {
		const stub = getStub("binary-roundtrip");
		const bytes = new Uint8Array([0, 1, 2, 127, 128, 254, 255]);
		await stub.writeFile("/binary.bin", bytes);
		const result = await stub.readFileBuffer("/binary.bin");
		expect(result.content).toBeInstanceOf(Uint8Array);
		expect(new Uint8Array(result.content)).toEqual(bytes);
	});

	it("handles large binary content", async () => {
		const stub = getStub("large-binary");
		const size = 64 * 1024; // 64KB
		const bytes = new Uint8Array(size);
		for (let i = 0; i < size; i++) {
			bytes[i] = i % 256;
		}
		await stub.writeFile("/large.bin", bytes);
		const result = await stub.readFileBuffer("/large.bin");
		expect(new Uint8Array(result.content)).toEqual(bytes);
	});

	it("handles UTF-8 multi-byte characters", async () => {
		const stub = getStub("utf8");
		const content = "Hello \u{1F600} \u00E9\u00E8\u00EA \u4F60\u597D \u{1F30D}";
		await stub.writeFile("/utf8.txt", content);
		const result = await stub.readFile("/utf8.txt");
		expect(result.content).toBe(content);
	});

	it("stat returns correct shape over RPC", async () => {
		const stub = getStub("stat-shape");
		await stub.writeFile("/file.txt", "data");
		const stat = await stub.stat("/file.txt");
		expect(stat.isDir).toBe(false);
		expect(stat.isSymlink).toBe(false);
		expect(stat.size).toBe(4);
		expect(stat.mode).toBe(0o644);
		expect(typeof stat.mtimeMs).toBe("number");
	});

	it("stat on directory returns isDir true", async () => {
		const stub = getStub("stat-dir");
		await stub.mkdir("/mydir");
		const stat = await stub.stat("/mydir");
		expect(stat.isDir).toBe(true);
		expect(stat.mode).toBe(0o755);
	});

	it("readdir returns sorted string array over RPC", async () => {
		const stub = getStub("readdir");
		await stub.writeFile("/dir/b.txt", "b");
		await stub.writeFile("/dir/a.txt", "a");
		await stub.writeFile("/dir/c.txt", "c");
		const entries = await stub.readdir("/dir");
		expect(entries).toEqual(["a.txt", "b.txt", "c.txt"]);
	});

	it("readdirWithFileTypes returns correct dirent shape over RPC", async () => {
		const stub = getStub("readdir-types");
		await stub.writeFile("/parent/file.txt", "data");
		await stub.mkdir("/parent/subdir");
		await stub.symlink("/parent/file.txt", "/parent/link.txt");

		const entries = await stub.readdirWithFileTypes("/parent");
		expect(entries).toHaveLength(3);

		const file = entries.find((e: any) => e.name === "file.txt")!;
		expect(file.isFile).toBe(true);
		expect(file.isDirectory).toBe(false);
		expect(file.isSymlink).toBe(false);

		const dir = entries.find((e: any) => e.name === "subdir")!;
		expect(dir.isFile).toBe(false);
		expect(dir.isDirectory).toBe(true);

		const link = entries.find((e: any) => e.name === "link.txt")!;
		expect(link.isSymlink).toBe(true);
	});

	it("ENOENT error propagates through RPC", async () => {
		const stub = getStub("enoent");
		await expect(stub.readFile("/nonexistent.txt")).rejects.toThrow();
	});

	it("EEXIST error propagates through RPC", async () => {
		const stub = getStub("eexist");
		await stub.mkdir("/existing");
		await expect(stub.mkdir("/existing")).rejects.toThrow();
	});

	it("EISDIR error propagates through RPC", async () => {
		const stub = getStub("eisdir");
		await stub.mkdir("/adir");
		await expect(stub.readFile("/adir")).rejects.toThrow();
	});

	it("appendFile creates and appends", async () => {
		const stub = getStub("append");
		await stub.appendFile("/log.txt", "line1\n");
		await stub.appendFile("/log.txt", "line2\n");
		const result = await stub.readFile("/log.txt");
		expect(result.content).toBe("line1\nline2\n");
	});

	it("symlink and readlink round-trip", async () => {
		const stub = getStub("symlink");
		await stub.writeFile("/target.txt", "real");
		await stub.symlink("/target.txt", "/link.txt");
		const target = await stub.readlink("/link.txt");
		expect(target).toBe("/target.txt");

		// Reading through symlink
		const result = await stub.readFile("/link.txt");
		expect(result.content).toBe("real");
	});

	it("lstat distinguishes symlinks from files", async () => {
		const stub = getStub("lstat");
		await stub.writeFile("/real.txt", "data");
		await stub.symlink("/real.txt", "/sym.txt");

		const statReal = await stub.lstat("/real.txt");
		expect(statReal.isSymlink).toBe(false);

		const statSym = await stub.lstat("/sym.txt");
		expect(statSym.isSymlink).toBe(true);
	});

	it("getAllPaths returns sorted paths", async () => {
		const stub = getStub("allpaths");
		await stub.writeFile("/b.txt", "b");
		await stub.writeFile("/a.txt", "a");
		const paths = await stub.getAllPaths();
		expect(Array.isArray(paths)).toBe(true);
		expect(paths).toContain("/");
		expect(paths).toContain("/a.txt");
		expect(paths).toContain("/b.txt");
		// Should be sorted
		const sorted = [...paths].sort();
		expect(paths).toEqual(sorted);
	});

	it("rm removes files and directories", async () => {
		const stub = getStub("rm");
		await stub.writeFile("/dir/file.txt", "data");
		await stub.rm("/dir", { recursive: true });
		expect(await stub.exists("/dir")).toBe(false);
		expect(await stub.exists("/dir/file.txt")).toBe(false);
	});

	it("cp copies file content", async () => {
		const stub = getStub("cp");
		await stub.writeFile("/src.txt", "copy me");
		await stub.cp("/src.txt", "/dst.txt");
		const result = await stub.readFile("/dst.txt");
		expect(result.content).toBe("copy me");
	});

	it("mv moves file", async () => {
		const stub = getStub("mv");
		await stub.writeFile("/old.txt", "moving");
		await stub.mv("/old.txt", "/new.txt");
		expect(await stub.exists("/old.txt")).toBe(false);
		const result = await stub.readFile("/new.txt");
		expect(result.content).toBe("moving");
	});
});
