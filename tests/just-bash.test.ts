import { beforeEach, describe, expect, test } from "bun:test";
import { Bash } from "just-bash";
import { DurableFs } from "../src/durable-fs.js";
import { createDirectStub, createTestFsObject } from "./helpers.js";

let bash: Bash;

beforeEach(async () => {
	const { obj } = await createTestFsObject();
	const stub = createDirectStub(obj);
	const fs = new DurableFs(stub, "/home");
	await fs.sync();
	bash = new Bash({ fs: fs as never, cwd: "/home" });
});

describe("just-bash smoke tests with DurableFs", () => {
	test('echo "hello" > file.txt && cat file.txt', async () => {
		const result = await bash.exec('echo "hello" > file.txt && cat file.txt');
		expect(result.stdout.trim()).toBe("hello");
		expect(result.exitCode).toBe(0);
	});

	test("mkdir -p a/b/c && ls a/b", async () => {
		await bash.exec("mkdir -p a/b/c");
		const result = await bash.exec("ls a/b");
		expect(result.stdout.trim()).toBe("c");
		expect(result.exitCode).toBe(0);
	});

	test("cp file.txt copy.txt && cat copy.txt", async () => {
		await bash.exec('echo "original" > file.txt');
		await bash.exec("cp file.txt copy.txt");
		const result = await bash.exec("cat copy.txt");
		expect(result.stdout.trim()).toBe("original");
	});

	test("append with >>", async () => {
		await bash.exec('echo "line1" > f.txt');
		await bash.exec('echo "line2" >> f.txt');
		const result = await bash.exec("cat f.txt");
		expect(result.stdout).toContain("line1");
		expect(result.stdout).toContain("line2");
	});

	test("rm -rf removes directory tree", async () => {
		await bash.exec("mkdir -p /tmp/test/sub");
		await bash.exec('echo "data" > /tmp/test/sub/file.txt');
		await bash.exec("rm -rf /tmp/test");
		const result = await bash.exec("ls /tmp/test 2>&1; echo $?");
		// Should fail since /tmp/test was removed
		expect(result.stdout).toContain("2");
	});

	test("pwd reflects cwd option", async () => {
		const result = await bash.exec("pwd");
		expect(result.stdout.trim()).toBe("/home");
	});

	test("write and read binary-safe through hex", async () => {
		await bash.exec('printf "hello\\nworld" > multi.txt');
		const result = await bash.exec("cat multi.txt");
		expect(result.stdout).toContain("hello");
		expect(result.stdout).toContain("world");
	});

	test("mv renames file", async () => {
		await bash.exec('echo "moveme" > old.txt');
		await bash.exec("mv old.txt new.txt");
		const result = await bash.exec("cat new.txt");
		expect(result.stdout.trim()).toBe("moveme");

		// old file should be gone
		const check = await bash.exec("cat old.txt 2>/dev/null");
		expect(check.exitCode).not.toBe(0);
	});

	test("multiple commands in sequence", async () => {
		const result = await bash.exec(`
			mkdir -p project/src
			echo 'console.log("hi")' > project/src/index.js
			cat project/src/index.js
		`);
		expect(result.stdout).toContain('console.log("hi")');
	});
});
