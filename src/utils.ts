/**
 * Normalize a path: resolve `.` and `..`, remove trailing slashes, ensure leading `/`.
 */
export function normalizePath(p: string): string {
	if (!p || p === "/") return "/";
	const parts = p.split("/");
	const resolved: string[] = [];
	for (const part of parts) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			resolved.pop();
		} else {
			resolved.push(part);
		}
	}
	return `/${resolved.join("/")}`;
}
