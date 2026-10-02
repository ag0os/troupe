import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spec as fixtureSpec } from "./adapters/test-fixtures";
import type { ResolvedMcpServer } from "./adapters/types";
import { parseCli } from "./cli";
import { installFakeClis, isAlive, readRecords, waitForFile } from "./fake-cli";
import { interpolateMcp } from "./interpolate";
import {
	createRunCommand,
	type ExecuteIo,
	executeAgent,
	type InterpolationContext,
	type RunCommand,
	type RunnerSignal,
	type SignalSource,
} from "./run";
import { parseAgentMarkdown } from "./schema";
import type { AgentSpec, CommandRequest, McpServer } from "./types";

const SECRET = "tok-9f8e7d6c5b4a";
const GITHUB_COMMAND =
	'op item get "Github CLI Token" --fields password --reveal';

let root: string;
let workspace: string;
let tmpRoot: string;
let bin: string;
let recordFile: string;
let opArgvFile: string;

/** A fake `op` that records its argv and cwd and prints the secret. */
function installFakeOp(dir: string) {
	const path = join(dir, "op");
	writeFileSync(
		path,
		`#!${process.execPath}
import { writeFileSync } from "node:fs";
writeFileSync(process.env.OP_ARGV_FILE, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
if (process.env.OP_FAIL) { console.error("op: not signed in ${SECRET}"); process.exit(2); }
process.stdout.write(process.env.OP_EMPTY ? "\\n" : "${SECRET}\\n");
`,
	);
	chmodSync(path, 0o755);
}

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "agent-interpolate-")));
	workspace = join(root, "workspace");
	tmpRoot = join(root, "tmp");
	bin = join(root, "bin");
	for (const dir of [workspace, tmpRoot, bin]) mkdirSync(dir);
	installFakeClis(bin);
	installFakeOp(bin);
	recordFile = join(root, "records.jsonl");
	opArgvFile = join(root, "op-argv.json");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** A context whose `runCommand` answers from `respond` and logs requests. */
function context(
	env: Record<string, string | undefined>,
	respond: (request: CommandRequest) => {
		exitCode?: number;
		stdout?: string;
	} = () => ({ stdout: "out\n" }),
) {
	const requests: CommandRequest[] = [];
	const runCommand: RunCommand = async (request) => {
		requests.push(request);
		const { exitCode = 0, stdout = "" } = respond(request);
		return { exitCode, stdout, stderr: "" };
	};
	const ctx: InterpolationContext = {
		env,
		cwd: "/effective/cwd",
		signal: new AbortController().signal,
		runCommand,
	};
	return { ctx, requests };
}

describe("interpolateMcp resolves MCP string leaves at launch (AC #1)", () => {
	const servers: Record<string, McpServer> = {
		chrome: {
			command: "${env:BIN}/chrome-devtools-mcp",
			args: ["--profile", "${env:PROFILE}", "plain ${notours}"],
			env: { TOKEN: "${cmd:mint token}", MODE: "real" },
			cwd: "${env:HOME}/srv",
		},
		github: {
			url: "https://${env:HOST}/mcp/",
			headers: {
				Authorization: `Bearer \${cmd:${GITHUB_COMMAND}}`,
				"X-Toolsets": "repos,issues",
			},
		},
	};
	const env = { BIN: "/opt", PROFILE: "p1", HOME: "/home/u", HOST: "gh.test" };

	test("every leaf resolves with its redacted twin; cmd runs in the effective cwd", async () => {
		const { ctx, requests } = context(env, (request) => ({
			stdout: request.argv[0] === "op" ? `${SECRET}\n` : "minted\n",
		}));
		const result = await interpolateMcp(servers, ctx);
		expect(result.mcp).toEqual({
			chrome: {
				command: {
					actual: "/opt/chrome-devtools-mcp",
					display: "<redacted:env:BIN>/chrome-devtools-mcp",
				},
				args: [
					{ actual: "--profile", display: "--profile" },
					{ actual: "p1", display: "<redacted:env:PROFILE>" },
					{ actual: "plain ${notours}", display: "plain ${notours}" },
				],
				env: {
					TOKEN: { actual: "minted", display: "<redacted:cmd>" },
					MODE: { actual: "real", display: "real" },
				},
				cwd: { actual: "/home/u/srv", display: "<redacted:env:HOME>/srv" },
			},
			github: {
				url: {
					actual: "https://gh.test/mcp/",
					display: "https://<redacted:env:HOST>/mcp/",
				},
				headers: {
					Authorization: {
						actual: `Bearer ${SECRET}`,
						display: "Bearer <redacted:cmd>",
						secretEnv: "TROUPE_MCP_GITHUB_AUTHORIZATION",
					},
					"X-Toolsets": { actual: "repos,issues", display: "repos,issues" },
				},
			},
		} satisfies Record<string, ResolvedMcpServer>);
		expect(result.env).toEqual({
			TROUPE_MCP_GITHUB_AUTHORIZATION: `Bearer ${SECRET}`,
		});
		expect(requests).toEqual([
			{ argv: ["mint", "token"], cwd: "/effective/cwd" },
			{
				argv: [
					"op",
					"item",
					"get",
					"Github CLI Token",
					"--fields",
					"password",
					"--reveal",
				],
				cwd: "/effective/cwd",
			},
		]);
	});

	test("expansion is single-pass: resolved text is never scanned again", async () => {
		const { ctx, requests } = context({ A: "${env:B}", B: "leak" }, () => ({
			stdout: "${cmd:evil}\n",
		}));
		const result = await interpolateMcp(
			{ s: { command: "x", args: ["${env:A}", "${cmd:echo}"] } },
			ctx,
		);
		expect(
			(result.mcp.s as { args: { actual: string }[] }).args.map(
				(arg) => arg.actual,
			),
		).toEqual(["${env:B}", "${cmd:evil}"]);
		expect(requests).toHaveLength(1);
	});

	test("nothing runs and nothing is exported without references", async () => {
		const { ctx, requests } = context({});
		const result = await interpolateMcp(
			{ api: { url: "https://x", headers: { A: "literal" } } },
			ctx,
		);
		expect(result).toEqual({
			mcp: {
				api: {
					url: { actual: "https://x", display: "https://x" },
					headers: { A: { actual: "literal", display: "literal" } },
				},
			},
			env: {},
		});
		expect(requests).toEqual([]);
		expect(await interpolateMcp(undefined, ctx)).toEqual({ mcp: {}, env: {} });
	});
});

describe("command resolution rules (AC #3)", () => {
	const one = (value: string): Record<string, McpServer> => ({
		s: { url: "https://x", headers: { H: value } },
	});
	const actualOf = async (stdout: string) => {
		const { ctx } = context({}, () => ({ stdout }));
		const result = await interpolateMcp(one("${cmd:tok}"), ctx);
		return result.env.TROUPE_MCP_S_H;
	};

	test("exactly one trailing line ending is trimmed", async () => {
		expect(await actualOf("v\n")).toBe("v");
		expect(await actualOf("v\r\n")).toBe("v");
		expect(await actualOf("v\n\n")).toBe("v\n");
		expect(await actualOf(" v ")).toBe(" v ");
	});

	test.each([
		["a nonzero exit", { exitCode: 1, stdout: `${SECRET}\n` }, /exited with 1/],
		["empty output", { stdout: "\n" }, /printed nothing/],
		["no output", { stdout: "" }, /printed nothing/],
	])("%s fails with the field and no output", async (_, response, message) => {
		const { ctx } = context({}, () => response);
		const failure = interpolateMcp(one("${cmd:tok --x}"), ctx);
		await expect(failure).rejects.toThrow(message);
		await expect(failure).rejects.toThrow(
			/^mcp\.s\.headers\.H: \$\{cmd:tok \.\.\.\}/,
		);
		await failure.catch((error: Error) => {
			expect(error.message).not.toContain(SECRET);
		});
	});

	test("an unset ${env:...} fails; an empty one is a value", async () => {
		const { ctx } = context({ EMPTY: "" });
		await expect(interpolateMcp(one("${env:NOPE}"), ctx)).rejects.toThrow(
			"mcp.s.headers.H: ${env:NOPE} is not set",
		);
		expect(
			(await interpolateMcp(one("x${env:EMPTY}"), ctx)).env.TROUPE_MCP_S_H,
		).toBe("x");
	});

	test("a command that cannot start fails; an abort propagates unchanged", async () => {
		const { ctx } = context({});
		ctx.runCommand = async () => {
			throw new Error("ENOENT");
		};
		await expect(interpolateMcp(one("${cmd:missing}"), ctx)).rejects.toThrow(
			"mcp.s.headers.H: ${cmd:missing ...} could not run: ENOENT",
		);
		const controller = new AbortController();
		const reason = new Error("aborted by signal");
		controller.abort(reason);
		await expect(
			interpolateMcp(one("${cmd:tok}"), {
				...ctx,
				signal: controller.signal,
			}),
		).rejects.toBe(reason);
	});
});

describe("${cmd:...} reaches the process as argv with no shell (AC #2)", () => {
	test("the 1Password item name arrives as one argument, run in the effective cwd", async () => {
		const runCommand = createRunCommand({
			cwd: root,
			signal: new AbortController().signal,
			env: { PATH: `${bin}:${process.env.PATH}`, OP_ARGV_FILE: opArgvFile },
		});
		const result = await interpolateMcp(
			{
				gh: {
					url: "https://x",
					headers: { Authorization: `Bearer \${cmd:${GITHUB_COMMAND}}` },
				},
			},
			{
				env: {},
				cwd: workspace,
				signal: new AbortController().signal,
				runCommand,
			},
		);
		expect(JSON.parse(readFileSync(opArgvFile, "utf8"))).toEqual({
			argv: [
				"item",
				"get",
				"Github CLI Token",
				"--fields",
				"password",
				"--reveal",
			],
			cwd: workspace,
		});
		expect(result.env.TROUPE_MCP_GH_AUTHORIZATION).toBe(`Bearer ${SECRET}`);
	});

	test("shell syntax never reaches a shell: a quoted operator is a plain argument", async () => {
		const marker = join(root, "pwned");
		const runCommand = createRunCommand({
			cwd: root,
			signal: new AbortController().signal,
			env: { PATH: `${bin}:${process.env.PATH}`, OP_ARGV_FILE: opArgvFile },
		});
		await interpolateMcp(
			{
				s: {
					url: "https://x",
					headers: { H: `\${cmd:op 'a; touch ${marker}' "b | c"}` },
				},
			},
			{
				env: {},
				cwd: workspace,
				signal: new AbortController().signal,
				runCommand,
			},
		);
		expect(JSON.parse(readFileSync(opArgvFile, "utf8")).argv).toEqual([
			`a; touch ${marker}`,
			"b | c",
		]);
		expect(existsSync(marker)).toBe(false);
	});

	test.each([
		["pipe", "op read x | cat"],
		["redirection", "op read x > out"],
		["separator", "op read x; rm -rf y"],
		["and", "op read x && echo"],
		["variable expansion", "op read $ITEM"],
		["glob", "op read *.txt"],
	])("%s fails compile", (_, command) => {
		expect(() =>
			parseAgentMarkdown(
				"agents/x.md",
				`---\ndescription: d\nbackends: [claude]\nmcp:\n  s:\n    url: https://x\n    headers:\n      H: '\${cmd:${command}}'\n---\n`,
			),
		).toThrow(/agents\/x\.md:\d+: mcp\.s\.headers\.H: .*without a shell/);
	});
});

/** A signal source the test fires by hand. */
function fakeSignals() {
	let handler: ((signal: RunnerSignal) => void) | undefined;
	const source: SignalSource = (next) => {
		handler = next;
		return () => {
			handler = undefined;
		};
	};
	return { source, send: (signal: RunnerSignal) => handler?.(signal) };
}

const githubMcp: Record<string, McpServer> = {
	gh: {
		url: "https://api.githubcopilot.test/mcp/",
		headers: {
			Authorization: `Bearer \${cmd:${GITHUB_COMMAND}}`,
			"X-MCP-Toolsets": "repos,issues",
		},
	},
	local: {
		command: "npx",
		args: ["server"],
		env: { TOKEN: "${env:LOCAL_TOKEN}" },
	},
};

async function launch(
	spec: AgentSpec,
	argv: string[],
	options: {
		env?: Record<string, string>;
		scenario?: string;
		signals?: SignalSource;
	} = {},
) {
	const outcome = parseCli(spec, argv, { cwd: workspace });
	if (outcome.kind !== "run") throw new Error("expected a run outcome");
	const out = { stdout: "", stderr: "" };
	const io: ExecuteIo = {
		stdout: (text) => {
			out.stdout += text;
		},
		stderr: (text) => {
			out.stderr += text;
		},
		isDirectory: (path) => existsSync(path) || "missing",
		env: {
			PATH: `${bin}:${process.env.PATH}`,
			HOME: process.env.HOME,
			FAKE_RECORD: recordFile,
			FAKE_PID_FILE: join(root, "backend.pid"),
			FAKE_SCENARIO: options.scenario ?? "ok",
			OP_ARGV_FILE: opArgvFile,
			LOCAL_TOKEN: "local-env-value",
			...options.env,
		},
		tmpRoot,
	};
	if (options.signals) io.signals = options.signals;
	const code = await executeAgent(spec, {}, outcome.invocation, io);
	return { code, ...out, leftovers: readdirSync(tmpRoot) };
}

/** Every file under `dir` whose content contains `needle`. */
function filesContaining(dir: string, needle: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { recursive: true, encoding: "utf8" })
		.map((entry) => join(dir, entry))
		.filter(
			(path) =>
				statSync(path).isFile() && readFileSync(path, "utf8").includes(needle),
		);
}

describe("secrets travel by environment only (AC #4, #6, #8; D-029)", () => {
	for (const backend of ["claude", "codex"] as const) {
		test(`${backend}: the secret is exported, referenced, and absent from argv, files and output`, async () => {
			const spec = fixtureSpec({ mode: "print", mcp: githubMcp });
			const result = await launch(spec, ["--backend", backend, "hi"]);
			expect(result.code).toBe(0);
			const [record] = readRecords(recordFile);
			if (!record) throw new Error("the backend never started");

			expect(record.troupeEnv).toEqual({
				TROUPE_MCP_GH_AUTHORIZATION: `Bearer ${SECRET}`,
			});
			const argv = record.argv.join("\n");
			expect(argv).not.toContain(SECRET);
			// Literal and non-header interpolated values still map literally.
			expect(argv).toContain("repos,issues");
			expect(argv).toContain("local-env-value");
			if (backend === "claude") {
				const config = JSON.parse(
					record.argv[record.argv.indexOf("--mcp-config") + 1] ?? "",
				);
				expect(config.mcpServers.gh.headers).toEqual({
					Authorization: "${TROUPE_MCP_GH_AUTHORIZATION}",
					"X-MCP-Toolsets": "repos,issues",
				});
			} else {
				expect(argv).toContain(
					'http_headers = {X-MCP-Toolsets = "repos,issues"}, env_http_headers = {Authorization = "TROUPE_MCP_GH_AUTHORIZATION"}',
				);
				expect(argv).not.toContain("bearer_token_env_var");
			}
			expect(result.stdout + result.stderr).not.toContain(SECRET);
			// Skip the fake `op` (it prints the secret) and the fake backend's
			// record of its own environment, which is where the secret belongs.
			expect(
				filesContaining(root, SECRET).filter(
					(path) => path !== recordFile && !path.startsWith(`${bin}/`),
				),
			).toEqual([]);
			expect(result.leftovers).toEqual([]);
		});

		test(`${backend}: the secret is absent from the process listing`, async () => {
			const signals = fakeSignals();
			const spec = fixtureSpec({ mode: "print", mcp: githubMcp });
			const pending = launch(spec, ["--backend", backend, "hi"], {
				scenario: "hang",
				signals: signals.source,
			});
			const pid = await waitForFile(join(root, "backend.pid"));
			const ps = Bun.spawnSync(["ps", "-ww", "-o", "args=", "-p", String(pid)]);
			const listing = ps.stdout.toString();
			expect(listing).toContain(backend);
			expect(listing).toContain("TROUPE_MCP_GH_AUTHORIZATION");
			expect(listing).not.toContain(SECRET);
			signals.send("SIGTERM");
			expect((await pending).code).toBe(143);
			expect(isAlive(pid)).toBe(false);
		});
	}

	test("the displayed preview pairs with the actual value: same shape, secret redacted", async () => {
		const runCommand = createRunCommand({
			cwd: workspace,
			signal: new AbortController().signal,
			env: { PATH: `${bin}:${process.env.PATH}`, OP_ARGV_FILE: opArgvFile },
		});
		const { mcp } = await interpolateMcp(githubMcp, {
			env: { LOCAL_TOKEN: "local-env-value" },
			cwd: workspace,
			signal: new AbortController().signal,
			runCommand,
		});
		const header = (
			mcp.gh as { headers: Record<string, { actual: string; display: string }> }
		).headers.Authorization;
		expect(header).toMatchObject({
			actual: `Bearer ${SECRET}`,
			display: "Bearer <redacted:cmd>",
		});
	});
});

describe("failed or interrupted resolution stops before the backend (AC #3)", () => {
	for (const [label, env] of [
		["failed command", { OP_FAIL: "1" }],
		["empty output", { OP_EMPTY: "1" }],
	] as const) {
		test(`${label}: stderr/1, no backend, no leftovers, no secret`, async () => {
			const result = await launch(
				fixtureSpec({ mcp: githubMcp }),
				["--backend", "claude"],
				{ env },
			);
			expect(result.code).toBe(1);
			expect(result.stderr).toStartWith(
				"test:agent: interpolation failed: mcp.gh.headers.Authorization: ${cmd:op ...}",
			);
			expect(result.stderr).not.toContain(SECRET);
			expect(readRecords(recordFile)).toEqual([]);
			expect(result.leftovers).toEqual([]);
		});
	}

	test("missing environment variable: stderr/1, no backend", async () => {
		const result = await launch(
			fixtureSpec({
				mcp: {
					s: { url: "https://x", headers: { H: "${env:TROUPE_TEST_UNSET}" } },
				},
			}),
			["--backend", "codex"],
		);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("${env:TROUPE_TEST_UNSET} is not set");
		expect(readRecords(recordFile)).toEqual([]);
	});

	test("a signal during ${cmd:...} terminates the command, cleans up and never starts the backend", async () => {
		const signals = fakeSignals();
		const pidFile = join(root, "sleeper.pid");
		const pending = launch(
			fixtureSpec({
				mcp: {
					s: {
						url: "https://x",
						headers: { H: `\${cmd:fake-sleeper '${pidFile}'}` },
					},
				},
			}),
			["--backend", "claude"],
			{ signals: signals.source },
		);
		const pid = await waitForFile(pidFile);
		signals.send("SIGTERM");
		const result = await pending;
		expect(result.code).toBe(143);
		expect(isAlive(pid)).toBe(false);
		expect(result.leftovers).toEqual([]);
		expect(readRecords(recordFile)).toEqual([]);
	});
});

describe("adapters carry every declared field (AC #8)", () => {
	test("a mutation that drops any header or stdio field is caught", async () => {
		const spec = fixtureSpec({
			backends: ["codex"],
			mode: "print",
			mcp: {
				...githubMcp,
				local: {
					command: "npx",
					args: ["server", "--flag"],
					env: { TOKEN: "${env:LOCAL_TOKEN}", MODE: "m" },
					cwd: "/srv",
				},
			},
		});
		const result = await launch(spec, ["--backend", "codex", "hi"]);
		expect(result.code).toBe(0);
		const [record] = readRecords(recordFile);
		const entries = (record?.argv ?? []).filter(
			(_, i, all) => all[i - 1] === "-c",
		);
		const tables = entries
			.filter((entry) => entry.startsWith("mcp_servers."))
			.map((entry) => Bun.TOML.parse(entry));
		expect(tables).toEqual([
			{
				mcp_servers: {
					gh: {
						url: "https://api.githubcopilot.test/mcp/",
						http_headers: { "X-MCP-Toolsets": "repos,issues" },
						env_http_headers: { Authorization: "TROUPE_MCP_GH_AUTHORIZATION" },
					},
				},
			},
			{
				mcp_servers: {
					local: {
						command: "npx",
						args: ["server", "--flag"],
						env: { TOKEN: "local-env-value", MODE: "m" },
						cwd: "/srv",
					},
				},
			},
		]);
	});
});

describe("fix round 1: a resolved value carrying ${ never reaches Claude (D-033)", () => {
	const DOLLAR = "${HOME}";
	const cases: [string, Record<string, McpServer>][] = [
		["mcp.h.url", { h: { url: "https://x/${env:A}" } }],
		["mcp.s.args[0]", { s: { command: "x", args: ["${env:A}"] } }],
		["mcp.s.env.K", { s: { command: "x", env: { K: "${env:A}" } } }],
	];

	for (const [field, mcp] of cases) {
		test(`${field}: claude fails at the adapter stage; codex launches`, async () => {
			for (const value of [DOLLAR, "${TROUPE_MCP_GH_AUTHORIZATION}"]) {
				rmSync(recordFile, { force: true });
				const failed = await launch(
					fixtureSpec({ mcp }),
					["--backend", "claude"],
					{
						env: { A: value, TROUPE_MCP_GH_AUTHORIZATION: SECRET },
					},
				);
				expect(failed.code).toBe(1);
				expect(failed.stderr).toBe(
					`test:agent: adapter failed: test:agent: ${field}: the resolved value contains "\${", which Claude would expand (D-033)\n`,
				);
				expect(failed.stderr).not.toContain(value);
				expect(failed.stderr).not.toContain(SECRET);
				expect(readRecords(recordFile)).toEqual([]);
				expect(failed.leftovers).toEqual([]);

				const launched = await launch(
					fixtureSpec({ mcp }),
					["--backend", "codex"],
					{
						env: { A: value },
					},
				);
				expect(launched.code).toBe(0);
				const [record] = readRecords(recordFile);
				expect(record?.argv.join("\n")).toContain(value);
			}
		});
	}

	test("a $ before a reference whose value starts with { is caught too", async () => {
		const result = await launch(
			fixtureSpec({ mcp: { h: { url: "https://x/$${env:A}" } } }),
			["--backend", "claude"],
			{ env: { A: "{HOME}" } },
		);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("mcp.h.url: the resolved value contains");
		expect(readRecords(recordFile)).toEqual([]);
	});
});
