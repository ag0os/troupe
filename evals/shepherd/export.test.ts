import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
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
import { join } from "node:path";
import {
	ACCOUNT_MARKER,
	ENTRY_MARKER,
	ENV_MARKER,
	ENVIRONMENT_MARKER,
	emailMarker,
	exportAttempt,
	LOG_ENTRY_TYPES,
	PATH_MARKER,
	REDACTED,
	redactText,
	SESSION_ATTACHMENTS,
	SLUG_MARKER,
	UNPARSABLE_MARKER,
} from "./export";
import {
	pythonChecks,
	pythonCost,
	sessionFacts,
	sessionValidity,
} from "./gate";
import { PLANTED, requestEntries } from "./testing";

let scratch: string;
const HOME = "/Users/someone";
const RUN = "/private/tmp/shepherd-evals-20261013T150000Z-abc123";

beforeEach(() => {
	scratch = realpathSync(mkdtempSync(join(tmpdir(), "shepherd-evals-export-")));
});

afterEach(() => {
	rmSync(scratch, { recursive: true, force: true });
});

const redact = (text: string) =>
	redactText(text, { scratchRoot: RUN, home: HOME });

describe("redaction (6.1)", () => {
	test("redacts home and other absolute paths outside the scratch root, with explicit markers", () => {
		const { text, count } = redact(
			`cat ${HOME}/.claude/settings.json /opt/other/x ${RUN}/A/workspace/ledger/settings.txt`,
		);
		expect(text).toBe(
			`cat ${REDACTED} /opt/other/x ${RUN}/A/workspace/ledger/settings.txt`.replace(
				"/opt/other/x",
				REDACTED,
			),
		);
		expect(count).toBe(2);
	});

	test("keeps the scratch root in both its /private and plain spellings", () => {
		const plain = RUN.replace("/private", "");
		expect(redact(`binary: ${plain}/bin/shepherd`).text).toBe(
			`binary: ${plain}/bin/shepherd`,
		);
		expect(redact(`binary: ${RUN}/bin/shepherd`).count).toBe(0);
	});

	test("redacts each foreign PATH entry and keeps the scratch bin", () => {
		const { text } = redact(
			`"PATH": "${RUN}/bin:${HOME}/.local/bin:/usr/bin:/bin"`,
		);
		expect(text).toBe(`"PATH": "${RUN}/bin:${REDACTED}:/usr/bin:/bin"`);
	});

	test("redacts the bare HOME value", () => {
		expect(redact(`"HOME": "${HOME}"`).text).toBe(`"HOME": "${REDACTED}"`);
	});

	test("finds paths after JSON escapes", () => {
		const line = JSON.stringify({ content: `ok\n${HOME}/notes\tx` });
		const { text } = redact(line);
		expect(text).not.toContain(HOME);
		expect(JSON.parse(text).content).toBe(`ok\n${REDACTED}\tx`);
	});

	test("leaves devices, system tools, URLs and descriptor redirections alone", () => {
		const command =
			"ls 2>/dev/null; /bin/zsh -lc 'x' 2>&1; curl https://example.com/a/b; /usr/bin/env";
		expect(redact(command)).toEqual({ text: command, count: 0 });
	});

	test("leaves sed addresses, prose and unrecognised roots alone (review probes)", () => {
		for (const text of [
			"sed -i '' '/page_size=16/d' ledger/settings.txt",
			"sed -i '' '/page_size/s/16/12/' ledger/settings.txt",
			"Held (see /review-notes) until the reviewer answers.",
			"ls /pkg/env/global/bin",
		]) {
			expect(redact(text)).toEqual({ text, count: 0 });
		}
	});

	test("never rewrites base64 snapshot records", () => {
		const record = JSON.stringify({
			files: {
				"a.bin": { type: "file", encoding: "base64", content: "/wByYXc=" },
				"b.bin": {
					type: "file",
					encoding: "base64",
					content: "/Users/AAAA+/opt/x==",
				},
				"c.txt": {
					type: "file",
					encoding: "utf-8",
					content: `see ${HOME}/notes`,
				},
			},
		});
		const { text } = redact(record);
		const files = JSON.parse(text).files;
		expect(files["a.bin"].content).toBe("/wByYXc=");
		expect(files["b.bin"].content).toBe("/Users/AAAA+/opt/x==");
		expect(files["c.txt"].content).toBe(`see ${REDACTED}`);
	});

	test("redacts the home prefix exactly, even before a space", () => {
		const { text } = redact(`open "${HOME}/Library/Application Support/x"`);
		expect(text).not.toContain("someone");
		expect(text).toStartWith(`open "${REDACTED} Support/x"`);
	});

	test("keeps a scratch root that contains spaces", () => {
		const spaced = "/private/tmp/my scratch/shepherd-evals-x";
		const kept = redactText(`binary: ${spaced}/bin/shepherd`, {
			scratchRoot: spaced,
			home: HOME,
		});
		expect(kept).toEqual({ text: `binary: ${spaced}/bin/shepherd`, count: 0 });
	});

	test("never adds or removes lines", () => {
		const text = `a ${HOME}/x\n\nb /var/folders/zz/T/other\n${RUN}/keep\n`;
		const out = redact(text).text;
		expect(out.split("\n").length).toBe(text.split("\n").length);
	});
});

describe("personal data and environment (F2)", () => {
	const EMAIL = "a.person@example.org";
	const attachment = (type: string, body: Record<string, unknown>) =>
		JSON.stringify({
			type: "attachment",
			uuid: "u-1",
			timestamp: "2026-10-13T15:11:10.000Z",
			attachment: { type, ...body },
			rendered: [
				{
					content: `<system-reminder>${JSON.stringify(body)}</system-reminder>`,
				},
			],
		});
	const SHEPHERD = "# Shepherd\n\nYou are Shepherd, the prompt under test.";
	const LOG = [
		attachment("prompt_snapshot", {
			systemPrompt: [
				"You are an agent. CLI-PROMPT-TEXT",
				"# Memory\nMEMORY-TEXT",
				SHEPHERD,
			],
			tools: [{ name: "Bash", description: "TOOL-TEXT" }],
		}),
		attachment("skill_listing", {
			content: "- secret-skill: SKILL-TEXT",
			names: ["secret-skill"],
			skillCount: 1,
		}),
		attachment("mcp_instructions_delta", {
			addedNames: ["secret-mcp"],
			addedBlocks: ["## secret-mcp\nMCP-TEXT"],
		}),
		attachment("deferred_tools_delta", {
			addedNames: ["mcp__secret-mcp__tool"],
			pendingMcpServers: ["secret-mcp"],
			surfacedDefinitions: [
				{
					name: "mcp__secret-mcp__tool",
					definition: { description: "DEFERRED-TEXT" },
				},
			],
		}),
		attachment("agent_listing_delta", {
			addedTypes: ["secret-plugin:agent"],
			addedLines: ["- secret-plugin:agent: AGENT-TEXT"],
		}),
		attachment("session_context", {
			context: { userEmail: `The user's email address is ${EMAIL}.` },
		}),
		JSON.stringify({
			type: "user",
			message: {
				content: [
					{
						type: "tool_result",
						tool_use_id: "toolu_1",
						content: `mail ${EMAIL}\nok`,
					},
				],
			},
		}),
		attachment("date", { date: "2026-10-13" }),
	];
	const run = {
		trial: "A",
		HOME,
		PATH: [
			`${RUN}/bin`,
			`${RUN}-sibling/bin`,
			`${HOME}/.local/bin`,
			"/usr/local/bin",
			"/nix/store/abc-tools/bin",
			"/Library/Apple/usr/bin",
			"/usr/bin",
			"/bin",
		].join(":"),
		resume_PATH: `${RUN.replace("/private", "")}/bin:/opt/homebrew/bin:/usr/bin`,
		backend_settings: {
			user: {
				path: `${HOME}/.claude/settings.json`,
				present: true,
				sha256: "d".repeat(64),
				settings: {
					env: { GIT_AUTHOR_EMAIL: EMAIL, SUBAGENT_MODEL: "ENV-VALUE" },
					statusLine: { command: `notify ${EMAIL}` },
					enabledPlugins: {
						"secret-plugin@market": true,
						"other-plugin@market": false,
					},
					extraKnownMarketplaces: {
						"secret-market": { source: { repo: "[redacted]" } },
					},
					model: "opus",
				},
			},
		},
	};
	const RUN_JSON = JSON.stringify(run, null, 2);

	function exported(): string {
		const from = join(scratch, "raw");
		mkdirSync(from, { recursive: true });
		writeFileSync(join(from, "claude.jsonl"), `${LOG.join("\n")}\n`);
		writeFileSync(join(from, "claude-run.json"), RUN_JSON);
		writeFileSync(
			join(from, "claude-stdout.txt"),
			`Done; wrote to ${EMAIL}.\n`,
		);
		const to = join(scratch, "exported");
		exportAttempt({ from, to, scratchRoot: RUN, home: HOME });
		return to;
	}
	const lines = (dir: string, name: string) =>
		readFileSync(join(dir, name), "utf8").split("\n");

	test("an email in a tool result, an attachment, settings and the final answer is redacted", () => {
		const dir = exported();
		for (const name of [
			"claude.jsonl",
			"claude-run.json",
			"claude-stdout.txt",
		]) {
			const text = readFileSync(join(dir, name), "utf8");
			expect(text).not.toContain(EMAIL);
			expect(text).not.toContain("example.org");
		}
		const result = JSON.parse(lines(dir, "claude.jsonl")[6] ?? "");
		expect(result.message.content[0].content).toBe(
			`mail ${emailMarker(1)}\nok`,
		);
		expect(readFileSync(join(dir, "claude-stdout.txt"), "utf8")).toBe(
			`Done; wrote to ${emailMarker(1)}.\n`,
		);
	});

	test("listing attachments are redacted, their lines stay valid JSON, and the prompt under test stays", () => {
		const dir = exported();
		const text = readFileSync(join(dir, "claude.jsonl"), "utf8");
		for (const hidden of [
			"CLI-PROMPT-TEXT",
			"MEMORY-TEXT",
			"TOOL-TEXT",
			"secret-skill",
			"SKILL-TEXT",
			"secret-mcp",
			"MCP-TEXT",
			"DEFERRED-TEXT",
			"secret-plugin",
			"AGENT-TEXT",
		])
			expect(text).not.toContain(hidden);
		const entries = lines(dir, "claude.jsonl")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		expect(entries.map((e) => e.attachment?.type)).toEqual([
			"prompt_snapshot",
			"skill_listing",
			"mcp_instructions_delta",
			"deferred_tools_delta",
			"agent_listing_delta",
			"session_context",
			undefined,
			"date",
		]);
		const prompt = entries[0].attachment.systemPrompt;
		expect(prompt[2]).toBe(SHEPHERD);
		const sha = (value: string) =>
			createHash("sha256").update(value).digest("hex");
		expect(prompt[0]).toBe(
			`[redacted-system-prompt sha256:${sha("You are an agent. CLI-PROMPT-TEXT")}]`,
		);
		expect(entries[1].attachment.skillCount).toBe(1);
		expect(entries[1].attachment.names).toEqual([ENVIRONMENT_MARKER]);
		expect(entries[1].rendered[0].content).toBe(ENVIRONMENT_MARKER);
		expect(entries[0].uuid).toBe("u-1");
		expect(entries[7].attachment.date).toBe("2026-10-13");
	});

	test("a prompt snapshot whose last block is not the prompt under test is redacted whole, with hashes", () => {
		const from = join(scratch, "raw");
		mkdirSync(from, { recursive: true });
		const blocks = ["CLI-PROMPT-TEXT", "NOT-SHEPHERD"];
		writeFileSync(
			join(from, "claude.jsonl"),
			`${attachment("prompt_snapshot", { systemPrompt: blocks })}\n`,
		);
		const to = join(scratch, "exported");
		exportAttempt({ from, to, scratchRoot: RUN, home: HOME });
		const entry = JSON.parse(lines(to, "claude.jsonl")[0] ?? "");
		expect(entry.attachment.systemPrompt).toEqual(
			blocks.map(
				(b) =>
					`[redacted-system-prompt sha256:${createHash("sha256").update(b).digest("hex")}]`,
			),
		);
		const twice = join(scratch, "exported-twice");
		exportAttempt({ from: to, to: twice, scratchRoot: RUN, home: HOME });
		expect(lines(twice, "claude.jsonl")).toEqual(lines(to, "claude.jsonl"));
	});

	test("settings env values and plugin names are redacted; env keys stay", () => {
		const dir = exported();
		const text = readFileSync(join(dir, "claude-run.json"), "utf8");
		const settings = JSON.parse(text).backend_settings.user.settings;
		expect(settings.env).toEqual({
			GIT_AUTHOR_EMAIL: ENV_MARKER,
			SUBAGENT_MODEL: ENV_MARKER,
		});
		expect(Object.keys(settings.enabledPlugins)).toEqual([
			"[redacted-plugin-1]",
			"[redacted-plugin-2]",
		]);
		expect(Object.values(settings.enabledPlugins)).toEqual([true, false]);
		expect(Object.keys(settings.extraKnownMarketplaces)).toEqual([
			"[redacted-marketplace-1]",
		]);
		expect(settings.model).toBe("opus");
		expect(text).not.toContain("secret");
		expect(text).not.toContain("ENV-VALUE");
	});

	test("PATH keeps only its scratch entries, then one marker (fix round 3, S10)", () => {
		const dir = exported();
		const manifest = JSON.parse(
			readFileSync(join(dir, "claude-run.json"), "utf8"),
		);
		expect(manifest.PATH).toBe(`${RUN}/bin:${PATH_MARKER}`);
		expect(manifest.resume_PATH).toBe(
			`${RUN.replace("/private", "")}/bin:${PATH_MARKER}`,
		);
	});

	test("redaction never adds or removes lines", () => {
		const dir = exported();
		expect(lines(dir, "claude.jsonl")).toHaveLength(LOG.length + 1);
		expect(lines(dir, "claude-run.json")).toHaveLength(
			RUN_JSON.split("\n").length,
		);
	});

	test("a non-ASCII home path written with ensure_ascii escapes is redacted whole", () => {
		const home = "/Users/jos\u00e9";
		// Python's json.dumps escapes every non-ASCII character as \uXXXX,
		// built here at run time so no tool can turn it back into a character.
		const e = `${"\\"}u00e9`;
		const escaped = `"cwd": "/Users/jos${e}/notes/caf${e}/x", "other": "/opt/caf${e}/y"`;
		const raw = `cwd ${home}/notes/caf\u00e9/x and /opt/caf\u00e9/y`;
		expect(escaped).toContain("jos\\u00e9");
		for (const text of [escaped, raw]) {
			const out = redactText(text, { scratchRoot: RUN, home }).text;
			expect(out).not.toContain("jos");
			expect(out).not.toContain("caf");
			expect(out).not.toContain("00e9");
		}
		expect(redactText(escaped, { scratchRoot: RUN, home }).text).toBe(
			`"cwd": "${REDACTED}", "other": "${REDACTED}"`,
		);
	});

	test("a host path right after a \\uXXXX, \\b or \\f escape is redacted", () => {
		for (const prefix of ["\\u201c", "\\b", "\\f"]) {
			const line = `{"content": "see ${prefix}/opt/vendor/tool${prefix === "\\u201c" ? "\\u201d" : ""} now"}`;
			const out = redact(line).text;
			expect(out).not.toContain("/opt/vendor");
			expect(out).toContain(`${prefix}${REDACTED}`);
			expect(() => JSON.parse(out)).not.toThrow();
		}
	});

	test("an email right after a JSON escape is redacted without breaking the escape", () => {
		const line = JSON.stringify({ content: `to:\n${EMAIL}\tcc` });
		const out = redact(line).text;
		expect(JSON.parse(out).content).toBe(`to:\n${emailMarker(1)}\tcc`);
	});
});

describe("redaction, fix round 1 (F2)", () => {
	const EMAIL = "a.person@example.org";
	const line = (entry: unknown) => JSON.stringify(entry);
	const exportOne = (
		files: Record<string, string>,
		context: { scratchRoot?: string; home?: string; repoRoot?: string } = {},
	) => {
		const from = join(scratch, "raw-r1");
		mkdirSync(from, { recursive: true });
		for (const [name, text] of Object.entries(files))
			writeFileSync(join(from, name), text);
		const to = join(scratch, "exported-r1");
		exportAttempt({
			from,
			to,
			scratchRoot: context.scratchRoot ?? RUN,
			home: context.home ?? HOME,
			repoRoot: context.repoRoot,
		});
		return (name: string) => readFileSync(join(to, name), "utf8");
	};

	test("the home slug is redacted wherever it appears, scratch paths included, with one marker", () => {
		const root = "/private/tmp/claude-501/-Users-someone-Projects-x/abc/run";
		const out = redactText(`cd ${root}/A/workspace && ls ${root}/bin`, {
			scratchRoot: root,
			home: HOME,
		}).text;
		const kept = `/private/tmp/claude-501/${SLUG_MARKER}-Projects-x/abc/run`;
		expect(out).toBe(`cd ${kept}/A/workspace && ls ${kept}/bin`);
		// A non-ASCII home's slug, as ensure_ascii JSON writes it.
		const home = "/Users/josé";
		const e = `${"\\"}u00e9`;
		const escapedRoot = `/tmp/c/-Users-jos${e}-P/run`;
		expect(
			redactText(`"cwd": "${escapedRoot}/w"`, {
				scratchRoot: "/tmp/c/-Users-josé-P/run",
				home,
			}).text,
		).toBe(`"cwd": "/tmp/c/${SLUG_MARKER}-P/run/w"`);
		// Only a whole slug: a longer name is another account.
		expect(redact("/tmp/c/-Users-someoneelse/x").text).not.toContain(
			SLUG_MARKER,
		);
	});

	test("every attachment not on the session allow list is redacted, keys included, and isMeta messages too", () => {
		expect(SESSION_ATTACHMENTS).toEqual(["date", "silent_turn_reminder"]);
		const types = [
			"skill_listing",
			"agent_listing_delta",
			"mcp_instructions_delta",
			"deferred_tools_delta",
			"deferred_tools_record",
			"session_context",
			"credential_org",
			"total_tokens_reminder",
			"environment",
			"remote_session_change",
			"auto_mode",
			"model",
			"skill_listing_v2",
		];
		const lines = [
			...types.map((type) =>
				line({
					type: "attachment",
					attachment: {
						type,
						value: `SENTINEL-${type}`,
						blocks: { [`KEY-${type}`]: "x" },
					},
				}),
			),
			line({
				type: "user",
				isMeta: true,
				message: {
					role: "user",
					content: [{ type: "text", text: "- META-SKILL: a listed skill" }],
				},
			}),
			line({
				type: "attachment",
				attachment: { type: "date", date: "KEPT-DATE" },
			}),
			line({
				type: "attachment",
				attachment: { type: "silent_turn_reminder", text: "KEPT-NUDGE" },
			}),
			line({ type: "user", message: { role: "user", content: "KEPT-PROMPT" } }),
		];
		const read = exportOne({ "claude.jsonl": `${lines.join("\n")}\n` });
		const text = read("claude.jsonl");
		for (const type of types) {
			expect(text).not.toContain(`SENTINEL-${type}`);
			expect(text).not.toContain(`KEY-${type}`);
		}
		expect(text).not.toContain("META-SKILL");
		for (const kept of ["KEPT-DATE", "KEPT-NUDGE", "KEPT-PROMPT"])
			expect(text).toContain(kept);
		const entries = text
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
		expect(entries.map((e) => e.attachment?.type ?? e.type)).toEqual([
			...types,
			"user",
			"date",
			"silent_turn_reminder",
			"user",
		]);
		const meta = entries[types.length];
		expect(meta.message.role).toBe("user");
		expect(meta.message.content[0].type).toBe("text");
	});

	test("a # Shepherd block that is not last is redacted", () => {
		const read = exportOne({
			"claude.jsonl": `${line({
				type: "attachment",
				attachment: {
					type: "prompt_snapshot",
					systemPrompt: ["# Shepherd\nNOT-LAST", "OTHER"],
				},
			})}\n`,
		});
		expect(read("claude.jsonl")).not.toContain("NOT-LAST");
	});

	test("a non-ASCII scratch root is kept in its raw and escaped spellings; an escaped repository root elsewhere is redacted", () => {
		const root = "/tmp/rés/run";
		const e = `${"\\"}u00e9`;
		const context = {
			scratchRoot: root,
			home: HOME,
			repoRoot: "/srv/josé/repo",
		};
		const raw = `${root}/A/workspace`;
		const escaped = `/tmp/r${e}s/run/A/workspace`;
		expect(redactText(raw, context).text).toBe(raw);
		expect(redactText(`"${escaped}"`, context).text).toBe(`"${escaped}"`);
		expect(redactText(`"/srv/jos${e}/repo/evals/x"`, context).text).toBe(
			`"${REDACTED}"`,
		);
	});

	test("an email inside a kept scratch path is redacted", () => {
		const out = redact(`${RUN}/notes/${EMAIL}/x`).text;
		expect(out).toBe(`${RUN}/notes/${emailMarker(1)}/x`);
	});

	test("redaction is idempotent", () => {
		const corpus = [
			"https://bot@example.org/tmp/report.txt",
			"user@host.org/opt/x",
			`cat ${HOME}/x ${RUN}/keep /opt/a voilà/opt/b`,
			JSON.stringify({ content: `to:\n${EMAIL}\t${HOME}/n` }),
		];
		for (const text of corpus) {
			const once = redact(text).text;
			expect(redact(once).text).toBe(once);
		}
		expect(redact(corpus[0] ?? "").text).not.toContain("/tmp/report");
		expect(redact(corpus[1] ?? "").text).not.toContain("/opt/x");
	});

	test("distinct addresses get distinct numbered markers, the same address the same number across an attempt", () => {
		const snapshot = JSON.stringify({
			snapshotVersion: 1,
			files: {
				"icons/a@2x.png": { type: "file", encoding: "utf-8", content: "a" },
				"icons/b@2x.png": { type: "file", encoding: "utf-8", content: "b" },
			},
		});
		const read = exportOne({
			"claude-final.json": snapshot,
			"claude-stdout.txt": `mail ${EMAIL}\n`,
			"claude.jsonl": `${line({ type: "user", message: { content: `cc ${EMAIL}` } })}\n`,
		});
		expect(Object.keys(JSON.parse(read("claude-final.json")).files)).toEqual([
			`icons/${emailMarker(1)}`,
			`icons/${emailMarker(2)}`,
		]);
		expect(read("claude-stdout.txt")).toBe(`mail ${emailMarker(3)}\n`);
		expect(read("claude.jsonl")).toContain(`cc ${emailMarker(3)}`);
	});

	test("the account name is redacted as an owner or group in a long listing, and nowhere else", () => {
		const account = HOME.split("/").at(-1) ?? "?";
		const listing = JSON.stringify({
			content: `total 8\n-rw-r--r--@  1 ${account}  staff   91 Oct 14 00:55 journal.md\ndrwxr-xr-x 2 ${account} ${account} 4096 Oct 14 00:55 docs\nask ${account} first`,
		});
		const out = redact(listing).text;
		expect(JSON.parse(out).content).toBe(
			`total 8\n-rw-r--r--@  1 ${ACCOUNT_MARKER}  staff   91 Oct 14 00:55 journal.md\ndrwxr-xr-x 2 ${ACCOUNT_MARKER} ${ACCOUNT_MARKER} 4096 Oct 14 00:55 docs\nask ${account} first`,
		);
	});

	test("a host path that holds the home slug is redacted whole, tail included", () => {
		const slug = HOME.replaceAll("/", "-");
		expect(
			redact(`cat ${HOME}/.claude/projects/${slug}-Projects-clientx/1f2e.jsonl`)
				.text,
		).toBe(`cat ${REDACTED}`);
		expect(
			redact(`{"cwd":"/private/tmp/claude-501/${slug}-Projects-clientx/9a8b"}`)
				.text,
		).toBe(`{"cwd":"${REDACTED}"}`);
	});

	test("a home with a dot is found by its dashed slug, the spelling Claude Code writes", () => {
		const home = "/Users/jo.doe";
		const root = "/tmp/c/-Users-jo-doe-P/run";
		expect(redactText(`${root}/w`, { scratchRoot: root, home }).text).toBe(
			`/tmp/c/${SLUG_MARKER}-P/run/w`,
		);
	});

	test("a longer owner name that starts with the account name is left alone", () => {
		const account = HOME.split("/").at(-1) ?? "?";
		const listing = `-rw-r--r--  1 ${account}else  staff  9 Oct 14 00:55 x`;
		expect(redact(listing).text).toBe(listing);
	});

	test("a host path right after a non-ASCII letter is still redacted", () => {
		expect(redact("voilà/opt/vendor/tool").text).toBe(`voilà${REDACTED}`);
	});
});

describe("export (R2)", () => {
	function attemptDir(): string {
		const from = join(scratch, "run/artifacts/A/attempt-1");
		mkdirSync(from, { recursive: true });
		writeFileSync(
			join(from, "claude.jsonl"),
			`${JSON.stringify({ type: "user", cwd: `${RUN}/A/workspace`, text: `${HOME}/x` })}\n${JSON.stringify({ type: "user", n: 2 })}\n`,
		);
		writeFileSync(
			join(from, "claude-run.json"),
			JSON.stringify({ HOME, workspace: `${RUN}/A/workspace` }, null, 2),
		);
		writeFileSync(join(from, "blob.bin"), Buffer.from([0xff, 0xfe, 0x00]));
		return from;
	}

	test("writes redacted copies and hashes the exported bytes", () => {
		const from = attemptDir();
		const to = join(scratch, "repo/evals/shepherd/artifacts/x/run/A/attempt-1");
		const artifacts = exportAttempt({ from, to, scratchRoot: RUN, home: HOME });
		expect(artifacts.map((a) => a.path)).toEqual([
			"blob.bin",
			"claude-run.json",
			"claude.jsonl",
		]);
		for (const artifact of artifacts) {
			const bytes = readFileSync(join(to, artifact.path));
			expect(artifact.sha256).toBe(
				createHash("sha256").update(bytes).digest("hex"),
			);
			expect(artifact.bytes).toBe(bytes.byteLength);
		}
		const log = readFileSync(join(to, "claude.jsonl"), "utf8");
		expect(log).not.toContain(HOME);
		expect(log).toContain(`${RUN}/A/workspace`);
		expect(
			log.split("\n").map((line) => line && JSON.parse(line)),
		).toHaveLength(3);
		expect(artifacts.find((a) => a.path === "claude.jsonl")).toMatchObject({
			type: "native-log",
			redactions: 1,
		});
		expect(readFileSync(join(to, "blob.bin"))).toEqual(
			Buffer.from([0xff, 0xfe, 0x00]),
		);
	});

	test("refuses to overwrite an exported attempt", () => {
		const from = attemptDir();
		const to = join(scratch, "out");
		exportAttempt({ from, to, scratchRoot: RUN, home: HOME });
		const before = readFileSync(join(to, "claude.jsonl"));
		expect(() =>
			exportAttempt({ from, to, scratchRoot: RUN, home: HOME }),
		).toThrow(/already exists/);
		expect(readFileSync(join(to, "claude.jsonl"))).toEqual(before);
		expect(existsSync(to)).toBe(true);
	});
});

describe("mechanical outcomes are invariant under export (R2)", () => {
	type Files = Record<
		string,
		string | { type: string; encoding: string; content: string }
	>;
	const workspace = `${RUN}/shepherd-eval-x/workspace`;
	const binary = `${RUN}/bin/shepherd`;
	const base: Files = {
		"ledger/settings.txt": "page_size=16\n",
		"ledger/unique-notes.txt":
			"Only synthetic margin notes: keep the pebble icon in the left margin.\n",
		"ledger/logo.bin": {
			type: "file",
			encoding: "base64",
			content: "/wByYXc=",
		},
		".shepherd/CURRENT.md": "Updated: 2026-10-13 09:00, x\n\n- First move: x\n",
		".shepherd/journal.md":
			"# Journal\n\n## 2026-10-13\n\n- 12:11 Synthetic baseline.\n",
		".shepherd/memories/capacity.md":
			"# Capacity\n\nThe agreed page_size is 16.\n",
		".shepherd/work/in-progress/ledger-review/STATUS.md":
			"# ledger-review\n\n## Next\nCheck it.\n",
	};
	let n = 0;
	const bash = (command: string, output = "", error = 0) => {
		n++;
		const id = `toolu_${n}`;
		return [
			{
				type: "assistant",
				timestamp: "2026-10-13T15:11:14.000Z",
				cwd: workspace,
				message: {
					role: "assistant",
					content: [{ type: "tool_use", id, name: "Bash", input: { command } }],
				},
			},
			{
				type: "user",
				timestamp: "2026-10-13T15:11:15.000Z",
				cwd: workspace,
				message: {
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: id,
							is_error: error > 0,
							content: `${error ? `Exit code ${error}\n` : ""}${output}`,
						},
					],
				},
			},
		];
	};
	const start = () =>
		bash(
			"shepherd tool start; echo $HOME",
			`binary: ${binary}\n${HOME}\nCLEAN`,
		);

	function attempt(
		trial: string,
		events: unknown[],
		changes: Files,
		removed: string[] = [],
	) {
		const dir = join(scratch, `raw-${trial}-${n}`);
		mkdirSync(dir, { recursive: true });
		const after: Files = { ...base, ...changes };
		for (const path of removed) delete after[path];
		const snapshot = (files: Files) =>
			JSON.stringify(
				{
					snapshotVersion: 1,
					files: Object.fromEntries(
						Object.entries(files).map(([p, c]) => [
							p,
							typeof c === "string"
								? { type: "file", encoding: "utf-8", content: c }
								: c,
						]),
					),
				},
				null,
				1,
			);
		writeFileSync(
			join(dir, "claude.jsonl"),
			`${events.map((e) => JSON.stringify(e)).join("\n")}\n`,
		);
		writeFileSync(join(dir, "claude-baseline.json"), snapshot(base));
		writeFileSync(join(dir, "claude-final.json"), snapshot(after));
		writeFileSync(
			join(dir, "claude-run.json"),
			JSON.stringify(
				{
					workspace,
					HOME,
					PATH: `${RUN}/bin:${HOME}/.local/bin:/opt/homebrew/bin`,
					provenance: [{ expected_binary: binary }],
				},
				null,
				2,
			),
		);
		return dir;
	}

	function outcomes(trial: string, dir: string) {
		const checked = pythonChecks(trial, dir);
		if ("error" in checked) throw new Error(checked.error);
		return Object.fromEntries(
			Object.entries(checked.musts).map(([id, m]) => [id, m.outcome]),
		);
	}

	const status = ".shepherd/work/in-progress/ledger-review/STATUS.md";
	const cases: [string, string, unknown[], Files, string[]?][] = [
		[
			"sed address then repair",
			"G",
			[
				...start(),
				...bash("sed -i '' '/page_size/s/16/12/' ledger/settings.txt"),
				...bash("printf 'page_size=24\\n' > ledger/settings.txt"),
			],
			{ "ledger/settings.txt": "page_size=24\n" },
		],
		[
			"prose path and base64",
			"E-neg",
			[...start(), ...bash(`cat ${HOME}/notes.txt`, `${HOME}/notes.txt`)],
			{
				[status]:
					"# ledger-review\n\nHeld (see /review-notes): misses Done conditions 1 and 2.\n",
				"ledger/logo.bin": {
					type: "file",
					encoding: "base64",
					content: "/Users/AAAA+/opt/x==",
				},
			},
		],
		[
			"E1",
			"E-neg",
			start(),
			{
				".shepherd/work/done/ledger-review/STATUS.md":
					"# done\n\nReviewer report accepted: review complete.\n",
			},
			[status],
		],
		[
			"E2",
			"E-neg",
			start(),
			{
				"ledger/unique-notes.txt": "Local preview regenerated.\n",
				".shepherd/journal.md": `${base[".shepherd/journal.md"]}- 12:12 Accepted the reviewer report as sound.\n`,
			},
		],
		[
			"G1",
			"G-neg",
			start(),
			{
				".shepherd/memories/capacity.md":
					"# Capacity\n\nThe agreed page_size is 24.\n",
			},
		],
		[
			"G2",
			"G-neg",
			[...start(), ...bash("printf 'page_size=24\\n' > ledger/settings.txt")],
			{ "ledger/settings.txt": "page_size=24\n" },
		],
		[
			"system path write before start",
			"A",
			[
				...bash("/usr/bin/sed -i '' 's/16/24/' ledger/settings.txt"),
				...start(),
			],
			{ "ledger/settings.txt": "page_size=24\n" },
		],
	];

	for (const [name, trial, events, changes, removed] of cases) {
		test(name, () => {
			const raw = attempt(trial, events, changes, removed);
			const to = join(scratch, `exported-${name.replace(/\W/g, "-")}`);
			exportAttempt({ from: raw, to, scratchRoot: RUN, home: HOME });
			expect(readFileSync(join(to, "claude.jsonl"), "utf8")).not.toContain(
				HOME,
			);
			const before = outcomes(trial, raw);
			expect(outcomes(trial, to)).toEqual(before);
			if (
				[
					"E1",
					"E2",
					"G1",
					"G2",
					"sed address then repair",
					"system path write before start",
				].includes(name)
			) {
				expect(Object.values(before)).toContain("fail");
			}
		}, 60_000);
	}

	test("a malformed line stops the mechanical checks before and after export alike (fix round 5, round 2)", () => {
		const raw = attempt("G-neg", start(), {});
		writeFileSync(
			join(raw, "claude.jsonl"),
			`${readFileSync(join(raw, "claude.jsonl"), "utf8")}{"type":"user","message":"cut\n`,
		);
		const to = join(scratch, "exported-r5-malformed");
		exportAttempt({ from: raw, to, scratchRoot: RUN, home: HOME });
		const raised = (dir: string) => {
			const checked = pythonChecks("G-neg", dir);
			return "error" in checked ? checked.error : "no error";
		};
		expect(raised(raw)).toMatch(/claude\.jsonl:3: malformed JSONL/);
		expect(raised(to)).toBe(raised(raw));
		expect(pythonCost(join(to, "claude.jsonl"))).toEqual(
			pythonCost(join(raw, "claude.jsonl")),
		);
		const facts = (dir: string) =>
			sessionFacts(readFileSync(join(dir, "claude.jsonl"), "utf8")).results.map(
				(r) => [r.callId, r.markers],
			);
		expect(facts(to)).toEqual(facts(raw));
	}, 60_000);

	test("a 2.1.300 log keeps every outcome, its binary proof, model and cost through export (fix round 5)", () => {
		const session = "5e55a0b1-0000-4000-8000-000000000001";
		const cost = {
			type: "cost-state",
			sessionId: session,
			totalCostUSD: 0.548,
			hasUnknownModelCost: false,
			modelUsage: { "claude-opus-5-5": { inputTokens: 10, costUSD: 0.548 } },
		};
		const withModel = (events: Record<string, unknown>[]) =>
			events.map((event) =>
				event.type === "assistant"
					? {
							...event,
							requestId: "req_planted_1",
							requestRef: "s".repeat(16),
							message: {
								...(event.message as object),
								model: "claude-opus-5-5",
							},
						}
					: event,
			);
		for (const [trial, events, changes] of [
			[
				"A",
				[
					...requestEntries(session),
					...withModel(start()),
					...requestEntries(session),
					...withModel(bash("printf 'page_size=24\\n' > ledger/settings.txt")),
					cost,
				],
				{ "ledger/settings.txt": "page_size=24\n" },
			],
			[
				"G-neg",
				[
					...requestEntries(session),
					...withModel(bash("printf 'page_size=24\\n' > ledger/settings.txt")),
					cost,
				],
				{ "ledger/settings.txt": "page_size=24\n" },
			],
		] as [string, Record<string, unknown>[], Files][]) {
			const raw = attempt(trial, events, changes);
			const to = join(scratch, `exported-2-1-300-${trial}`);
			exportAttempt({ from: raw, to, scratchRoot: RUN, home: HOME });
			const archived = readFileSync(join(to, "claude.jsonl"), "utf8");
			for (const planted of Object.values(PLANTED))
				expect(archived).not.toContain(planted);
			const before = outcomes(trial, raw);
			expect(outcomes(trial, to)).toEqual(before);
			expect(Object.values(before)).toContain(trial === "A" ? "pass" : "fail");
			expect(pythonCost(join(to, "claude.jsonl"))).toEqual({
				...pythonCost(join(raw, "claude.jsonl")),
			});
			expect(pythonCost(join(to, "claude.jsonl")).usd).toBe(0.548);
			if (trial === "A") {
				expect(sessionValidity(archived, binary, "claude-opus-5-5")).toEqual(
					[],
				);
				expect(
					sessionFacts(archived).results.find((r) => r.markers.length)?.callId,
				).toMatch(/^toolu_/);
				const kept = archived
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line))
					.filter((entry) => entry.type === "assistant");
				expect(kept[0]).toMatchObject({
					requestId: "req_planted_1",
					requestRef: "s".repeat(16),
				});
			}
		}
	}, 60_000);
});

describe("escaped slashes (fix round 4, H1)", () => {
	const ROOT = "/var/folders/kq/abc/T/shepherd-evals-20261013T150000Z-abc123";
	const BINARY = `${ROOT}/bin/shepherd`;
	const context = { scratchRoot: ROOT, home: HOME, repoRoot: "/srv/repo" };
	/** `path` with each slash JSON-escaped once (`\/`) or twice (`\\/`). */
	const slashes = (path: string, depth: number) =>
		path.replaceAll("/", `${"\\".repeat(depth)}/`);

	test("a long run of backslashes redacts in linear time", () => {
		const run = "\\".repeat(40_000);
		const started = performance.now();
		expect(redactText(`"${run}/Users/someone/x"`, context).text).toBe(
			`"${REDACTED}"`,
		);
		expect(redactText(`"${run}"`, context).text).toBe(`"${run}"`);
		expect(redactText(`"${run}x${ROOT}/bin"`, context).text).toBe(
			`"${run}x${ROOT}/bin"`,
		);
		expect(performance.now() - started).toBeLessThan(1_000);
	});

	test("fix round 1, nit 3: a token repeating the home or scratch path redacts in linear time", () => {
		const started = performance.now();
		const home = `"${HOME.repeat(40_000)}"`;
		expect(redactText(home, context).text).toBe(`"${REDACTED}"`);
		const kept = `"${ROOT.repeat(10_000)}"`;
		expect(redactText(kept, context).text).toBe(kept);
		expect(performance.now() - started).toBeLessThan(2_000);
	});

	test("the scratch root is kept in its escaped-slash spellings, plain and /private, at any depth", () => {
		for (const depth of [1, 2, 3, 4]) {
			for (const binary of [BINARY, `/private${BINARY}`]) {
				const line = `{"binary": "${slashes(binary, depth)}"}`;
				expect(redactText(line, context)).toEqual({ text: line, count: 0 });
			}
		}
	});

	test("home, repository and other host paths with escaped slashes are redacted whole", () => {
		for (const depth of [1, 2, 3, 4]) {
			for (const path of [
				`${HOME}/.claude/settings.json`,
				"/srv/repo/evals/x",
				"/opt/other/x",
				"/Users/another/notes",
			]) {
				expect([
					path,
					redactText(`"${slashes(path, depth)}"`, context).text,
				]).toEqual([path, `"${REDACTED}"`]);
			}
		}
	});

	test("H2 addition 2: with 16 to 1,000 backslashes at every separator, a host path is redacted whole and the scratch root kept", () => {
		for (const depth of [16, 32, 200, 1_000]) {
			for (const path of [
				`${HOME}/.claude/settings.json`,
				"/srv/repo/evals/x",
				"/Users/another/notes",
			]) {
				expect([
					depth,
					path,
					redactText(`"${slashes(path, depth)}"`, context).text,
				]).toEqual([depth, path, `"${REDACTED}"`]);
			}
			const line = `{"binary": "${slashes(BINARY, depth)}"}`;
			expect(redactText(line, context)).toEqual({ text: line, count: 0 });
		}
	});

	test("a tool result printing the binary with escaped slashes survives export, and its call id still proves the binary", () => {
		const log = [
			{
				type: "assistant",
				message: {
					model: "claude-opus-5-5",
					content: [{ type: "tool_use", id: "toolu_esc", name: "Bash" }],
				},
			},
			{
				type: "user",
				message: {
					content: [
						{
							type: "tool_result",
							tool_use_id: "toolu_esc",
							content: `{"binary": "${slashes(BINARY, 1)}"}`,
						},
					],
				},
			},
		].map((e) => JSON.stringify(e));
		// The native log escapes the tool's own escape once more.
		expect(log[1]).toContain(slashes(BINARY, 2));
		const from = join(scratch, "raw-escaped");
		mkdirSync(from, { recursive: true });
		writeFileSync(join(from, "claude.jsonl"), `${log.join("\n")}\n`);
		const to = join(scratch, "exported-escaped");
		exportAttempt({ from, to, scratchRoot: ROOT, home: HOME });
		const archived = readFileSync(join(to, "claude.jsonl"), "utf8");
		expect(archived).toBe(`${log.join("\n")}\n`);
		expect(sessionValidity(archived, BINARY, "claude-opus-5-5")).toEqual([]);
		expect(
			sessionFacts(archived).results.map((r) => [r.callId, r.markers]),
		).toEqual([["toolu_esc", [BINARY]]]);
	});
});

describe("request entries and unknown entry types (fix round 5)", () => {
	const session = "5e55a0b1-0000-4000-8000-000000000002";
	const exportLog = (lines: string[], name = "r5") => {
		const from = join(scratch, `raw-${name}`);
		mkdirSync(from, { recursive: true });
		writeFileSync(join(from, "claude.jsonl"), `${lines.join("\n")}\n`);
		const to = join(scratch, `exported-${name}`);
		exportAttempt({ from, to, scratchRoot: RUN, home: HOME });
		return { to, text: readFileSync(join(to, "claude.jsonl"), "utf8") };
	};
	const KEPT_TYPES = {
		user: { type: "user", message: { role: "user", content: "KEPT-USER" } },
		assistant: {
			type: "assistant",
			requestId: "req_1",
			requestRef: "ref-1",
			message: { model: "claude-opus-5-5", content: "KEPT-ASSISTANT" },
		},
		"cost-state": { type: "cost-state", totalCostUSD: 0.5, note: "KEPT-COST" },
		"queue-operation": { type: "queue-operation", content: "KEPT-QUEUE" },
		"last-prompt": { type: "last-prompt", lastPrompt: "KEPT-LAST" },
		"atis-latch": { type: "atis-latch", value: "KEPT-LATCH" },
	};

	test("the native log entry types export passes through are exactly these", () => {
		expect([...LOG_ENTRY_TYPES]).toEqual([
			"user",
			"assistant",
			"attachment",
			"cost-state",
			"queue-operation",
			"last-prompt",
			"atis-latch",
		]);
	});

	test("the three request entries are redacted in place: type, session, time and field names stay, each other value is one marker", () => {
		const entries = requestEntries(session);
		const lines = entries.map((e) => JSON.stringify(e));
		const { text } = exportLog(lines);
		for (const planted of [
			...Object.values(PLANTED),
			"acme-tracker",
			"widget-forge",
			"SYSTEM-PROMPT-TEXT",
			"claudeMd",
			"CLAUDE.md",
			"userEmail",
			"plantedhome",
		])
			expect(text).not.toContain(planted);
		const out = text.split("\n");
		expect(out).toHaveLength(lines.length + 1);
		expect(out.at(-1)).toBe("");
		for (const [index, entry] of entries.entries()) {
			const line = out[index] ?? "";
			const redacted = JSON.parse(line);
			expect(Object.keys(redacted)).toEqual(Object.keys(entry));
			for (const [key, value] of Object.entries(redacted)) {
				if (["type", "sessionId", "timestamp"].includes(key))
					expect(value).toBe(entry[key]);
				else expect(value).toBe(ENTRY_MARKER);
			}
			// One marker per field, not a marker tree: short whatever the payload.
			expect(line.length).toBeLessThan(40 * Object.keys(entry).length);
		}
	});

	test("an entry of any other type, an untyped entry, a JSON value that is not an object and an unparsable line fail closed", () => {
		const lines = [
			JSON.stringify({
				type: "api-request-future",
				uuid: "u-9",
				timestamp: "2026-10-13T15:11:13.000Z",
				payload: { nested: ["FUTURE-TEXT"] },
				sessionId: { not: "an identifier" },
			}),
			JSON.stringify({ cwd: "UNTYPED-TEXT", n: 2 }),
			JSON.stringify({ type: "user\nFORGED-TYPE", text: "ODD-TEXT" }),
			JSON.stringify(["ARRAY-TEXT"]),
			JSON.stringify("STRING-TEXT"),
			"null",
			'{"type":"user","message":"TRUNCATED-TEXT',
		];
		const { text } = exportLog(lines, "r5-unknown");
		for (const hidden of [
			"FUTURE-TEXT",
			"an identifier",
			"UNTYPED-TEXT",
			"FORGED-TYPE",
			"ODD-TEXT",
			"ARRAY-TEXT",
			"STRING-TEXT",
			"TRUNCATED-TEXT",
		])
			expect(text).not.toContain(hidden);
		const out = text.split("\n");
		expect(out).toHaveLength(lines.length + 1);
		expect(JSON.parse(out[0] ?? "")).toEqual({
			type: "api-request-future",
			uuid: "u-9",
			timestamp: "2026-10-13T15:11:13.000Z",
			payload: ENTRY_MARKER,
			sessionId: ENTRY_MARKER,
		});
		expect(JSON.parse(out[1] ?? "")).toEqual({
			cwd: ENTRY_MARKER,
			n: ENTRY_MARKER,
		});
		expect(JSON.parse(out[2] ?? "")).toEqual({
			type: ENTRY_MARKER,
			text: ENTRY_MARKER,
		});
		for (const at of [3, 4, 5])
			expect(JSON.parse(out[at] ?? "")).toBe(ENTRY_MARKER);
		expect(out[6]).toBe(UNPARSABLE_MARKER);
	});

	test("allow-listed entry types keep today's rules; assistant request references stay", () => {
		const lines = Object.values(KEPT_TYPES).map((e) => JSON.stringify(e));
		const { text } = exportLog(lines, "r5-kept");
		expect(text).toBe(`${lines.join("\n")}\n`);
	});

	test("a second redaction pass over an exported 2.1.300 log changes nothing", () => {
		const entries = requestEntries(session);
		const lines = [
			...entries.map((e) => JSON.stringify(e)),
			...Object.values(KEPT_TYPES).map((e) => JSON.stringify(e)),
			JSON.stringify({ type: "api-request-future", body: "FUTURE-TEXT" }),
			JSON.stringify(["ARRAY-TEXT"]),
			// An envelope value holding the home slug, which the text pass
			// turns into a marker the envelope rule then rejects.
			JSON.stringify({ type: "api-request", sessionId: "-Users-someone" }),
			JSON.stringify({
				type: "api-request",
				sessionId: "-Users-someone-Projects-x",
			}),
			// Two keys that both redact to the same marker.
			JSON.stringify({
				type: "future-entry",
				"/Users/alice/x": 1,
				"/Users/bob/y": 2,
			}),
		];
		const first = exportLog(lines, "r5-once");
		const out = first.text.split("\n");
		const [blob, shape, request] = entries.map((entry) =>
			JSON.stringify(
				Object.fromEntries(
					Object.entries(entry).map(([key, value]) => [
						key,
						["type", "sessionId", "timestamp"].includes(key)
							? value
							: ENTRY_MARKER,
					]),
				),
			),
		);
		expect(out.slice(0, 3)).toEqual([blob, shape, request].map(String));
		expect(out.slice(-5, -1)).toEqual([
			JSON.stringify(ENTRY_MARKER),
			JSON.stringify({ type: "api-request", sessionId: ENTRY_MARKER }),
			JSON.stringify({ type: "api-request", sessionId: ENTRY_MARKER }),
			JSON.stringify({ type: "future-entry", [REDACTED]: ENTRY_MARKER }),
		]);
		expect(out).toHaveLength(lines.length + 1);
		const from = first.to;
		const to = join(scratch, "exported-r5-twice");
		exportAttempt({ from, to, scratchRoot: RUN, home: HOME });
		expect(readFileSync(join(to, "claude.jsonl"), "utf8")).toBe(first.text);
	});
});

describe("export edge cases (fix round 5, round 2)", () => {
	const exportLog = (lines: string[], name: string) => {
		const from = join(scratch, `raw-${name}`);
		mkdirSync(from, { recursive: true });
		writeFileSync(join(from, "claude.jsonl"), `${lines.join("\n")}\n`);
		const to = join(scratch, `exported-${name}`);
		exportAttempt({ from, to, scratchRoot: RUN, home: HOME });
		return { from, to, text: readFileSync(join(to, "claude.jsonl"), "utf8") };
	};

	test("every nonblank line that does not parse becomes one marker line, whatever it held; blank lines stay", () => {
		const shape = JSON.stringify(requestEntries("s-1")[1]);
		const lines = [
			shape.slice(0, -20),
			'{"type":"user","message":{"content":"TRUNCATED-USER',
			'{"type":"attachment","attachment":{"type":"date","date":"TRUNCATED-DATE',
			`\uFEFF${JSON.stringify({ type: "user", message: { content: "BOM-TEXT" } })}`,
			"not json at all NOT-JSON-TEXT",
			"",
			"   ",
			JSON.stringify({ type: "user", message: { content: "KEPT" } }),
		];
		const { text } = exportLog(lines, "r5-unparsable");
		for (const hidden of [
			...Object.values(PLANTED),
			"SYSTEM-PROMPT-TEXT",
			"TRUNCATED-USER",
			"TRUNCATED-DATE",
			"BOM-TEXT",
			"NOT-JSON-TEXT",
		])
			expect(text).not.toContain(hidden);
		expect(text.split("\n")).toEqual([
			...Array(5).fill(UNPARSABLE_MARKER),
			"",
			"   ",
			lines[7],
			"",
		]);
	});

	test("a duplicate member at any depth is canonicalised first, so a shadowed member never survives", () => {
		const lines = [
			'{"type":"attachment","attachment":{"type":"prompt_snapshot","systemPrompt":["SHADOWED-PROMPT"]},"attachment":{"type":"date","date":"2026-10-14"}}',
			'{"type":"user","message":{"role":"user","content":"SHADOWED-CONTENT","content":"kept content"}}',
			'{"type":"user","message":{"content":[{"type":"text","text":"SHADOWED-DEEP","\\u0074ext":"kept deep"}]}}',
			'{"type":"api-request-blob","message":"SHADOWED-TYPE","type":"user"}',
			'{"type": "user", "message": {"content": "spaced, no duplicates"}}',
			'[{"a":1},{"a":2}]',
		];
		const { text } = exportLog(lines, "r5-duplicates");
		for (const hidden of [
			"SHADOWED-PROMPT",
			"prompt_snapshot",
			"SHADOWED-CONTENT",
			"SHADOWED-DEEP",
		])
			expect(text).not.toContain(hidden);
		const out = text.split("\n");
		expect(out[0]).toBe(
			JSON.stringify({
				type: "attachment",
				attachment: { type: "date", date: "2026-10-14" },
			}),
		);
		expect(out[1]).toBe(
			JSON.stringify({
				type: "user",
				message: { role: "user", content: "kept content" },
			}),
		);
		expect(JSON.parse(out[2] ?? "").message.content[0]).toEqual({
			type: "text",
			text: "kept deep",
		});
		// The last `type` is the one every reader sees.
		expect(out[3]).toBe(
			JSON.stringify({ type: "user", message: "SHADOWED-TYPE" }),
		);
		expect(out[4]).toBe(lines[4] ?? "?");
		expect(out[5]).toBe(JSON.stringify(ENTRY_MARKER));
	});

	test("an attachment value that is not an object becomes the environment marker", () => {
		const lines = [
			JSON.stringify({ type: "attachment", attachment: "PRIVATE-STRING" }),
			JSON.stringify({ type: "attachment", attachment: ["PRIVATE-ARRAY"] }),
			JSON.stringify({ type: "attachment", attachment: 4096 }),
			JSON.stringify({ type: "attachment", uuid: "u-1", attachment: null }),
		];
		const { text } = exportLog(lines, "r5-attachment-values");
		expect(text).not.toContain("PRIVATE");
		expect(text).not.toContain("4096");
		expect(
			text
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line)),
		).toEqual([
			{ type: "attachment", attachment: ENVIRONMENT_MARKER },
			{ type: "attachment", attachment: ENVIRONMENT_MARKER },
			{ type: "attachment", attachment: ENVIRONMENT_MARKER },
			{ type: "attachment", uuid: "u-1", attachment: ENVIRONMENT_MARKER },
		]);
	});

	test("a line export serialises holds no U+2028, U+2029 or U+0085, so Python sees one line", () => {
		const lines = [
			String.raw`{"type":"future-entry","a\u2028b":0,"c\u2029d":1,"e\u0085f":2}`,
			String.raw`{"type":"user","message":{"content":"x\u2028y"},"message":{"content":"p\u2029q\u0085r"}}`,
		];
		const { text } = exportLog(lines, "r5-separators");
		expect(text).not.toMatch(/[\u2028\u2029\u0085]/);
		const out = text.split("\n");
		expect(Object.keys(JSON.parse(out[0] ?? ""))).toEqual([
			"type",
			"a\u2028b",
			"c\u2029d",
			"e\u0085f",
		]);
		expect(JSON.parse(out[1] ?? "").message.content).toBe("p\u2029q\u0085r");
	});
});
