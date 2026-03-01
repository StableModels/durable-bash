import { Database } from "bun:sqlite";

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
			if (bindings.length > 0) {
				// Handle Uint8Array bindings - convert to Buffer for bun:sqlite
				const processedBindings = bindings.map((b) => {
					if (b instanceof Uint8Array) {
						return Buffer.from(b);
					}
					return b;
				});
				const stmt = db.prepare(query);
				// Check if it's a SELECT/query
				if (query.trimStart().toUpperCase().startsWith("SELECT")) {
					const rows = stmt.all(...processedBindings);
					return {
						toArray() {
							return rows.map((row) => {
								// Convert Buffer back to ArrayBuffer for content fields
								const processed: Record<string, unknown> = {};
								for (const [key, value] of Object.entries(
									row as Record<string, unknown>,
								)) {
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
							});
						},
					};
				}
				stmt.run(...processedBindings);
				return { toArray: () => [] };
			}
			// No bindings
			if (query.trimStart().toUpperCase().startsWith("SELECT")) {
				const rows = db.prepare(query).all();
				return {
					toArray() {
						return rows.map((row) => {
							const processed: Record<string, unknown> = {};
							for (const [key, value] of Object.entries(
								row as Record<string, unknown>,
							)) {
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
						});
					},
				};
			}
			db.exec(query);
			return { toArray: () => [] };
		},
	};

	const ctx = {
		storage: { sql },
	};

	return { ctx: ctx as MockDurableObjectState, db };
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
	// Import after mocking
	const { FsObject } = await import("../src/fs-object.js");
	const { ctx, db } = createMockState();
	const obj = new FsObject(ctx as never, {});
	return { obj, db };
}
