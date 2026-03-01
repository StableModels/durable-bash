import { Database } from "bun:sqlite";
import type { FsObject } from "../src/fs-object.js";

function processRow(row: Record<string, unknown>): Record<string, unknown> {
	const processed: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(row)) {
		if (Buffer.isBuffer(value)) {
			processed[key] = (value as Buffer).buffer.slice(
				value.byteOffset,
				value.byteOffset + value.byteLength,
			);
		} else {
			processed[key] = value;
		}
	}
	return processed;
}

function processBindings(bindings: unknown[]): unknown[] {
	return bindings.map((b) => (b instanceof Uint8Array ? Buffer.from(b) : b));
}

/**
 * Create a mock DurableObjectState with real SQLite storage.
 */
export function createMockState(): {
	ctx: MockDurableObjectState;
	db: Database;
} {
	const db = new Database(":memory:");

	const sql: MockSqlStorage = {
		exec(query: string, ...bindings: unknown[]) {
			const isSelect = query.trimStart().toUpperCase().startsWith("SELECT");

			if (bindings.length > 0) {
				const processed = processBindings(bindings);
				const stmt = db.prepare(query);
				if (isSelect) {
					return {
						toArray: () =>
							stmt
								.all(...processed)
								.map((r) => processRow(r as Record<string, unknown>)),
					};
				}
				stmt.run(...processed);
				return { toArray: () => [] };
			}

			if (isSelect) {
				return {
					toArray: () =>
						db
							.prepare(query)
							.all()
							.map((r) => processRow(r as Record<string, unknown>)),
				};
			}
			db.exec(query);
			return { toArray: () => [] };
		},
	};

	return { ctx: { storage: { sql } } as MockDurableObjectState, db };
}

interface MockSqlStorage {
	exec(query: string, ...bindings: unknown[]): { toArray(): unknown[] };
}

interface MockDurableObjectState {
	storage: {
		sql: MockSqlStorage;
	};
}

/**
 * Create a fresh FsObject instance for testing.
 */
export async function createTestFsObject() {
	const { FsObject } = await import("../src/fs-object.js");
	const { ctx, db } = createMockState();
	const obj = new FsObject(ctx as never, {});
	return { obj, db };
}

/**
 * Create a stub that wraps FsObject methods in Promises to simulate DO RPC.
 * Used by integration and smoke tests.
 */
export function createDirectStub(obj: FsObject): DurableObjectStub<FsObject> {
	return new Proxy(obj, {
		get(target, prop: string) {
			const method = (target as Record<string, unknown>)[prop];
			if (typeof method === "function") {
				return (...args: unknown[]) => {
					const result = method.apply(target, args);
					return result instanceof Promise ? result : Promise.resolve(result);
				};
			}
			return method;
		},
	}) as unknown as DurableObjectStub<FsObject>;
}
