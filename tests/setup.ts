// This file must be imported (via preload) before any test files.
// It mocks cloudflare:workers so FsObject can be imported in tests.
import { mock } from "bun:test";

mock.module("cloudflare:workers", () => ({
	DurableObject: class DurableObject {
		ctx: unknown;
		env: unknown;
		constructor(ctx: unknown, env: unknown) {
			this.ctx = ctx;
			this.env = env;
		}
	},
}));
