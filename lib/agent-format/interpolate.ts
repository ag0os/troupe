import type {
	ResolvedHeaderValue,
	ResolvedMcpServer,
	ResolvedValue,
} from "./adapters/types";
import {
	type Interpolation,
	mcpSecretEnvName,
	scanInterpolations,
} from "./command-text";
import { PREVIEW_PLACEHOLDERS } from "./preview";
import type { Interpolate, InterpolationContext } from "./run";

/**
 * Resolve declared MCP servers at launch (B-005, Design §6). Only MCP string
 * leaves are visited. `${env:NAME}` reads the launch environment;
 * `${cmd:...}` runs its pre-split argv through the runner's tracked
 * `runCommand` in the effective cwd, with no shell (D-026). Expansion is
 * single-pass: resolved text is never scanned again.
 *
 * Every leaf keeps its actual value paired with a redacted display. An
 * interpolated HTTP header value is marked with its D-029 variable and
 * returned in `env` for the backend's environment, so the adapters emit a
 * reference instead of the value.
 */
export const interpolateMcp: Interpolate = async (servers, ctx) => {
	const mcp: Record<string, ResolvedMcpServer> = {};
	const env: Record<string, string> = {};
	for (const [name, server] of Object.entries(servers ?? {})) {
		const base = `mcp.${name}`;
		const leaf = (value: string, field: string) =>
			resolveLeaf(value, `${base}.${field}`, ctx);
		if ("command" in server) {
			const resolved: ResolvedMcpServer = {
				command: (await leaf(server.command, "command")).value,
			};
			if (server.args) {
				resolved.args = [];
				for (const [i, arg] of server.args.entries()) {
					resolved.args.push((await leaf(arg, `args[${i}]`)).value);
				}
			}
			if (server.env) {
				resolved.env = {};
				for (const [key, value] of Object.entries(server.env)) {
					resolved.env[key] = (await leaf(value, `env.${key}`)).value;
				}
			}
			if (server.cwd !== undefined) {
				resolved.cwd = (await leaf(server.cwd, "cwd")).value;
			}
			mcp[name] = resolved;
			continue;
		}
		const resolved: ResolvedMcpServer = {
			url: (await leaf(server.url, "url")).value,
		};
		if (server.headers) {
			const headers: Record<string, ResolvedHeaderValue> = {};
			for (const [header, value] of Object.entries(server.headers)) {
				const result = await leaf(value, `headers.${header}`);
				if (!result.interpolated) {
					headers[header] = result.value;
					continue;
				}
				const variable = mcpSecretEnvName(name, header);
				if (variable in env) {
					throw new Error(
						`${base}.headers.${header}: secret variable ${variable} is already used`,
					);
				}
				env[variable] = result.value.actual;
				headers[header] = { ...result.value, secretEnv: variable };
			}
			resolved.headers = headers;
		}
		mcp[name] = resolved;
	}
	return { mcp, env };
};

async function resolveLeaf(
	value: string,
	field: string,
	ctx: InterpolationContext,
): Promise<{ value: ResolvedValue; interpolated: boolean }> {
	const scan = scanInterpolations(value);
	if (!scan.ok) throw new Error(`${field}: ${scan.error}`);
	if (scan.references.length === 0) {
		return { value: { actual: value, display: value }, interpolated: false };
	}
	let actual = "";
	let display = "";
	let cursor = 0;
	for (const reference of scan.references) {
		const start = value.indexOf(reference.raw, cursor);
		const before = value.slice(cursor, start);
		actual += before + (await resolveReference(reference, field, ctx));
		display += before + placeholderFor(reference);
		cursor = start + reference.raw.length;
	}
	const rest = value.slice(cursor);
	return {
		value: { actual: actual + rest, display: display + rest },
		interpolated: true,
	};
}

function placeholderFor(reference: Interpolation): string {
	return reference.kind === "env"
		? PREVIEW_PLACEHOLDERS.env(reference.name)
		: PREVIEW_PLACEHOLDERS.cmd;
}

/**
 * One reference's value. Failure messages name the field and the command's
 * program, never its output, which may hold part of a secret.
 */
async function resolveReference(
	reference: Interpolation,
	field: string,
	ctx: InterpolationContext,
): Promise<string> {
	if (reference.kind === "env") {
		const found = ctx.env[reference.name];
		if (found === undefined) {
			throw new Error(`${field}: \${env:${reference.name}} is not set`);
		}
		return found;
	}
	const [program, ...args] = reference.argv;
	if (program === undefined) throw new Error(`${field}: empty \${cmd:...}`);
	const label = `\${cmd:${program} ...}`;
	ctx.signal.throwIfAborted();
	let result: Awaited<ReturnType<InterpolationContext["runCommand"]>>;
	try {
		result = await ctx.runCommand({ argv: [program, ...args], cwd: ctx.cwd });
	} catch (error) {
		if (ctx.signal.aborted) throw error;
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`${field}: ${label} could not run: ${message}`);
	}
	if (result.exitCode !== 0) {
		throw new Error(`${field}: ${label} exited with ${result.exitCode}`);
	}
	const output = result.stdout.replace(/(?:\r\n|\n|\r)$/, "");
	if (output.length === 0) {
		throw new Error(`${field}: ${label} printed nothing`);
	}
	return output;
}
