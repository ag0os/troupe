import { mcpSecretEnvName } from "../command-text";
import { nativeDeclarationProblems } from "../schema";
import type { Backend, NativeArg } from "../types";
import type {
	Invocation,
	ResolvedMcpServer,
	ResolvedStdioMcpServer,
	ResolvedValue,
} from "./types";

/** Builds `argv` and its redacted `displayArgv` side by side. */
export class ArgvBuilder {
	readonly argv: string[] = [];
	readonly displayArgv: string[] = [];

	/** Tokens that carry nothing to redact. */
	push(...tokens: readonly string[]): this {
		this.argv.push(...tokens);
		this.displayArgv.push(...tokens);
		return this;
	}

	pushValue(actual: string, display: string): this {
		this.argv.push(actual);
		this.displayArgv.push(display);
		return this;
	}
}

/** Both renderings of one token built from resolved values. */
export type Rendered = { actual: string; display: string };

export function render(
	build: (pick: (value: ResolvedValue) => string) => string,
): Rendered {
	return {
		actual: build((value) => value.actual),
		display: build((value) => value.display),
	};
}

export function nativeArgv(args: readonly NativeArg[] | undefined): string[] {
	return (args ?? []).map((arg) => (typeof arg === "string" ? arg : arg.flag));
}

/**
 * Reject invocations an adapter must not turn into argv: the wrong adapter,
 * an undeclared backend (D-005), or native declarations that the schema
 * would have refused (D-013).
 */
export function assertInvocation(inv: Invocation, id: Backend): void {
	if (inv.backend !== id) {
		throw new Error(
			`the ${id} adapter cannot build a "${inv.backend}" invocation`,
		);
	}
	if (!inv.spec.backends.includes(id)) {
		throw new Error(
			`${inv.spec.id} does not declare the ${id} backend (declared: ${inv.spec.backends.join(", ")})`,
		);
	}
	const problems = nativeDeclarationProblems(inv.spec.native ?? {});
	if (problems.length > 0) {
		throw new Error(
			`${inv.spec.id}: invalid native declarations:\n${problems.join("\n")}`,
		);
	}
	assertMcp(inv);
}

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

/**
 * Server names must be bare keys, since Codex splits `-c` keys on "."
 * without TOML parsing. Secret references are allowed only on HTTP header
 * values, under their generated, collision-free names (D-029).
 */
function assertMcp(inv: Invocation): void {
	const fail = (field: string, message: string): never => {
		throw new Error(`${inv.spec.id}: ${field}: ${message}`);
	};
	const owners = new Map<string, string>();
	for (const [name, server] of Object.entries(inv.mcp)) {
		const base = `mcp.${name}`;
		if (!BARE_KEY.test(name)) {
			fail(base, "server names use only letters, digits, - and _");
		}
		const plain: [string, ResolvedValue | undefined][] = isStdio(server)
			? [
					["command", server.command],
					["cwd", server.cwd],
					...(server.args ?? []).map((arg, i): [string, ResolvedValue] => [
						`args[${i}]`,
						arg,
					]),
					...Object.entries(server.env ?? {}).map(
						([key, value]): [string, ResolvedValue] => [`env.${key}`, value],
					),
				]
			: [["url", server.url]];
		for (const [field, value] of plain) {
			if (value && "secretEnv" in value) {
				fail(
					`${base}.${field}`,
					"a secret reference is only allowed on an HTTP header value (D-029)",
				);
			}
		}
		if (isStdio(server)) continue;
		for (const [header, value] of Object.entries(server.headers ?? {})) {
			if (value.secretEnv === undefined) continue;
			const field = `${base}.headers.${header}`;
			const expected = mcpSecretEnvName(name, header);
			if (value.secretEnv !== expected) {
				fail(
					field,
					`secret variable must be ${expected}, got "${value.secretEnv}"`,
				);
			}
			const owner = owners.get(expected);
			if (owner)
				fail(field, `secret variable ${expected} collides with ${owner}`);
			owners.set(expected, field);
		}
	}
}

export function isStdio(
	server: ResolvedMcpServer,
): server is ResolvedStdioMcpServer {
	return "command" in server;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One complete JSON stream line; malformed input throws (D-018). */
export function parseJsonLine(text: string, backend: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		const excerpt = text.length > 200 ? `${text.slice(0, 200)}...` : text;
		throw new Error(`malformed ${backend} stream line: ${excerpt}`);
	}
}
