import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseCli } from "../lib/agent-format/cli";
import { previewAgent } from "../lib/agent-format/run";
import type { Backend, PrepareContext } from "../lib/agent-format/types";
import {
	type LoadedAgent,
	loadAgentDefinition,
} from "../scripts/agent-compiler";
import * as shepherd from "./shepherd";

const repo = resolve(import.meta.dir, "..");
const fixtures = join(import.meta.dir, "__fixtures__/shepherd-module-matrix");
const fixedTime = "2026-10-02T12:00:00";
const backends: Backend[] = ["claude", "codex"];
const titles = {
	nested: "# Integration: Nested workspace",
	root: "# Integration: Root workspace",
	software: "# Integration: Software coordination",
};
const bodySources = {
	herdr: "system-prompts/shepherd/integrations/herdr.md",
	"inter-agent": "system-prompts/shepherd/integrations/inter-agent.md",
	nested: "system-prompts/shepherd/integrations/nested.md",
	root: "system-prompts/shepherd/integrations/root.md",
	software: "packages/software/MODULE.md",
	"integrations-shared":
		"system-prompts/shepherd/templates/integrations-shared.md",
};

let agent: LoadedAgent;
let root: string;

beforeAll(async () => {
	agent = await loadAgentDefinition(repo, "agents/shepherd.md");
	root = realpathSync(mkdtempSync(join(tmpdir(), "shepherd-module-matrix-")));
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

function write(path: string, body: string) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, body);
}

type Gates = Record<keyof typeof titles, boolean>;

function build(name: string, gates: Gates, enclosing = true): string {
	const base = join(root, name);
	const parent = join(base, "parent");
	const cwd = join(parent, "workspace");
	if (enclosing) {
		write(join(parent, ".shepherd/charter.md"), "# Parent charter\n");
	}
	if (gates.nested) {
		write(
			join(parent, ".shepherd/integrations/shared.md"),
			"# Matrix shared integration\n\nUse the shared reference files.\n",
		);
	}
	write(
		join(cwd, ".shepherd/charter.md"),
		`# Matrix charter\n\n${gates.software ? "Modules: software\n\n" : ""}Coordinate this workspace.\n`,
	);
	write(
		join(cwd, ".shepherd/integrations/local.md"),
		"# Matrix local integration\n\nKeep the workspace records current.\n",
	);
	if (gates.root) {
		write(join(cwd, "child/.shepherd/charter.md"), "# Child charter\n");
	}
	return cwd;
}

async function preview(backend: Backend, cwd: string): Promise<string> {
	const outcome = parseCli(
		agent.spec,
		["--backend", backend, "--show-prompt"],
		{
			cwd,
		},
	);
	if (outcome.kind !== "run") throw new Error("unexpected help");
	let stdout = "";
	let stderr = "";
	const chunks: string[] = [];
	const directStderr = spyOn(process.stderr, "write").mockImplementation(
		(chunk) => {
			chunks.push(String(chunk));
			return true;
		},
	);
	let code: number;
	try {
		code = await previewAgent(
			agent.spec,
			{
				prepare: (ctx: PrepareContext) =>
					shepherd.prepare(ctx, {
						cwd: ctx.cwd,
						home: join(root, "home"),
						env: {},
						now: new Date(fixedTime),
						clock: () => new Date(fixedTime),
						pidAlive: () => false,
						runCommand: ctx.runCommand,
					}),
			},
			outcome.invocation,
			{
				stdout: (chunk) => {
					stdout += chunk;
				},
				stderr: (chunk) => {
					stderr += chunk;
				},
				isDirectory: () => true,
				runCommand: async () => {
					throw new Error("a module matrix preview runs no command");
				},
			},
		);
		expect(chunks).toEqual([]);
	} finally {
		directStderr.mockRestore();
	}
	expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
	const match =
		/^Backend: \w+\n--- System prompt ---\n([\s\S]*)\n--- Initial prompt ---\n([\s\S]*)\n--- Argv ---\n(.*)\n$/.exec(
			stdout,
		);
	if (!match) throw new Error("missing preview envelope");
	const prompt = match[1] ?? "";
	const argv: string[] = JSON.parse(match[3] ?? "[]");
	const transported =
		backend === "claude"
			? argv[argv.indexOf("--append-system-prompt") + 1]
			: JSON.parse(
					argv
						.find((arg) => arg.startsWith("developer_instructions="))
						?.slice("developer_instructions=".length) ?? "null",
				);
	expect(transported).toBe(prompt);
	return prompt;
}

function normalize(prompt: string, name: string): string {
	return prompt
		.replaceAll(join(root, name), "<workspace-fixture>")
		.replaceAll(root, "<test-root>");
}

function pinnedBody(name: keyof typeof bodySources): string {
	return readFileSync(
		join(fixtures, "builtin-bodies", `${name}.md.txt`),
		"utf8",
	);
}

describe("prechange full prompt matrix", () => {
	for (const backend of backends) {
		test(`no-enclosing.${backend}`, async () => {
			const name = `no-enclosing.${backend}`;
			const cwd = build(
				name,
				{ nested: false, root: false, software: false },
				false,
			);
			for (let dir = dirname(cwd); ; dir = dirname(dir)) {
				expect(existsSync(join(dir, ".shepherd"))).toBe(false);
				if (dir === dirname(dir)) break;
			}
			const prompt = await preview(backend, cwd);
			expect(prompt).toContain("- Enclosing workspace: none\n");
			expect(prompt).toContain("- Gated modules loaded: none\n");
			expect(prompt).toContain("- Workspaces beneath: none within 3 levels\n");
			for (const gate of Object.keys(titles) as (keyof Gates)[]) {
				expect(prompt).not.toContain(titles[gate]);
				expect(prompt).not.toContain(pinnedBody(gate));
			}
			for (const capability of ["herdr", "inter-agent"] as const) {
				expect(prompt).toContain(pinnedBody(capability));
			}
			const baseline = join(fixtures, `${name}.prompt.txt`);
			const normalized = normalize(prompt, name);
			if (process.env.UPDATE_MODULE_MATRIX === "1") {
				write(baseline, normalized);
			}
			expect(Buffer.from(normalized)).toEqual(readFileSync(baseline));
		});
	}
	for (const nested of [false, true]) {
		for (const hasChildren of [false, true]) {
			for (const software of [false, true]) {
				const gates = { nested, root: hasChildren, software };
				const name = `nested-${Number(nested)}.root-${Number(hasChildren)}.software-${Number(software)}`;
				for (const backend of backends) {
					test(`${name}.${backend}`, async () => {
						const cwd = build(`${name}.${backend}`, gates);
						const prompt = await preview(backend, cwd);
						const loaded = Object.entries(gates)
							.filter(([, on]) => on)
							.map(([gate]) => gate);
						expect(prompt).toContain(
							`- Gated modules loaded: ${loaded.join(", ") || "none"}\n`,
						);
						for (const gate of Object.keys(titles) as (keyof Gates)[]) {
							expect(prompt.split(titles[gate]).length - 1).toBe(
								gates[gate] ? 1 : 0,
							);
							expect(prompt.includes(pinnedBody(gate))).toBe(gates[gate]);
						}
						for (const capability of ["herdr", "inter-agent"] as const) {
							expect(prompt).toContain(pinnedBody(capability));
						}
						expect(prompt).toContain("# Shepherd session context\n");
						expect(prompt).toContain("- Date: 2026-10-02\n");
						expect(prompt).toContain(
							`(inherited integrations: ${nested ? "shared.md" : "none"})\n`,
						);
						expect(prompt).toContain(
							`- Workspaces beneath: ${hasChildren ? "child" : "none within 3 levels"}\n`,
						);
						const baseline = join(fixtures, `${name}.${backend}.prompt.txt`);
						const normalized = normalize(prompt, `${name}.${backend}`);
						if (process.env.UPDATE_MODULE_MATRIX === "1") {
							write(baseline, normalized);
						}
						expect(Buffer.from(normalized)).toEqual(readFileSync(baseline));
					});
				}
			}
		}
	}
});

// Strip only a leading delimiter block, independently of the production parser.
function afterDelimiterBlock(source: string): string | undefined {
	const lineEnding = source.startsWith("---\r\n")
		? "\r\n"
		: source.startsWith("---\n")
			? "\n"
			: undefined;
	if (lineEnding === undefined) return undefined;
	let start = 3 + lineEnding.length;
	let signature = false;
	while (start < source.length) {
		const newline = source.indexOf("\n", start);
		const end = newline === -1 ? source.length : newline;
		const rawLine = source.slice(start, end);
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		if (line === "---") {
			const closingEnding =
				newline === -1 ? "" : rawLine.endsWith("\r") ? "\r\n" : "\n";
			return signature && closingEnding === lineEnding
				? source.slice(end + 1)
				: undefined;
		}
		if (!signature && line.trim()) {
			if (
				!/^(name|type|description|applies-when|provides|default|budget|charter-keys|contract|tools|guides):(?:\s|$)/.test(
					line,
				)
			) {
				return undefined;
			}
			signature = true;
		}
		start = end + 1;
	}
	return undefined;
}

describe("original built-in body bytes", () => {
	for (const [name, path] of Object.entries(bodySources)) {
		test(name, () => {
			const source = readFileSync(join(repo, path));
			const pinned = readFileSync(
				join(fixtures, "builtin-bodies", `${name}.md.txt`),
			);
			if (source.equals(pinned)) return;
			const body = afterDelimiterBlock(source.toString("utf8"));
			expect(body).toBeDefined();
			expect(Buffer.from(body ?? "")).toEqual(pinned);
		});
	}
});

test("independent instrument preserves heading openers and requires colon whitespace", () => {
	for (const source of [
		"---\n# Title\nname: x\n---\nbody",
		"---\nname:sample\n---\nbody",
	])
		expect(afterDelimiterBlock(source)).toBeUndefined();
	expect(
		afterDelimiterBlock("---\n\nname:\tsample\n# comment\n---\nbody"),
	).toBe("body");
});
