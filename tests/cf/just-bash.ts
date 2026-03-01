import { env } from "cloudflare:test";
import { Bash } from "just-bash";
import { describe, expect, it } from "vitest";
import { DurableFs } from "../../src/durable-fs.js";
import type { FsObject } from "../../src/fs-object.js";

async function createBash(name: string): Promise<Bash> {
	const fs = await DurableFs.create(
		env.FS as DurableObjectNamespace<FsObject>,
		name,
		"/home",
	);
	return new Bash({ fs: fs as never, cwd: "/home" });
}

describe("just-bash through DurableFs in workerd", () => {
	it("echo and cat round-trip", async () => {
		const bash = await createBash("echo-cat");
		const result = await bash.exec('echo "hello" > file.txt && cat file.txt');
		expect(result.stdout.trim()).toBe("hello");
		expect(result.exitCode).toBe(0);
	});

	it("mkdir -p and ls", async () => {
		const bash = await createBash("mkdir-ls");
		await bash.exec("mkdir -p a/b/c");
		const result = await bash.exec("ls a/b");
		expect(result.stdout.trim()).toBe("c");
		expect(result.exitCode).toBe(0);
	});

	it("cp file", async () => {
		const bash = await createBash("cp-file");
		await bash.exec('echo "original" > file.txt');
		await bash.exec("cp file.txt copy.txt");
		const result = await bash.exec("cat copy.txt");
		expect(result.stdout.trim()).toBe("original");
	});

	it("append with >>", async () => {
		const bash = await createBash("append");
		await bash.exec('echo "line1" > f.txt');
		await bash.exec('echo "line2" >> f.txt');
		const result = await bash.exec("cat f.txt");
		expect(result.stdout).toContain("line1");
		expect(result.stdout).toContain("line2");
	});

	it("mv renames file", async () => {
		const bash = await createBash("mv-file");
		await bash.exec('echo "moveme" > old.txt');
		await bash.exec("mv old.txt new.txt");
		const result = await bash.exec("cat new.txt");
		expect(result.stdout.trim()).toBe("moveme");
	});

	it("pwd reflects cwd", async () => {
		const bash = await createBash("pwd");
		const result = await bash.exec("pwd");
		expect(result.stdout.trim()).toBe("/home");
	});

	it("multi-command sequence", async () => {
		const bash = await createBash("multi-cmd");
		const result = await bash.exec(`
			mkdir -p project/src
			echo 'console.log("hi")' > project/src/index.js
			cat project/src/index.js
		`);
		expect(result.stdout).toContain('console.log("hi")');
	});
});
