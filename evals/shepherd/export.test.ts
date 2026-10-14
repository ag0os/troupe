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
import { exportAttempt, REDACTED, redactText } from "./export";
import { pythonChecks } from "./gate";

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

describe("export (R2)", () => {
	function attemptDir(): string {
		const from = join(scratch, "run/artifacts/A/attempt-1");
		mkdirSync(from, { recursive: true });
		writeFileSync(
			join(from, "claude.jsonl"),
			`${JSON.stringify({ cwd: `${RUN}/A/workspace`, text: `${HOME}/x` })}\n${JSON.stringify({ n: 2 })}\n`,
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
		});
	}
});
