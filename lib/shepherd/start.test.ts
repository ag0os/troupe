import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { checkWorkspace } from "./check";
import {
	captureState,
	commitCheckpoint,
	nextCheckpoint,
} from "./checkpoint-write";
import { loadConfig } from "./config";
import { TEMPLATES } from "./guides";
import { renderStart, runStart, startJson } from "./start";
import { collectStart } from "./start-collect";
import { fakeToolEnv, makeTree } from "./test-support";
import { words } from "./text";
import { discoverTree } from "./tree";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});
function fixture(files: Record<string, string> = {}) {
	const f = makeTree(
		Object.fromEntries(
			Object.entries({
				"CURRENT.md":
					"# Current\nUpdated: 2026-10-05\nKeep the important line\n",
				"charter.md": "charter",
				"pending.md": "",
				"MEMORY.md": "memory index",
				"docs/INDEX.md": "docs index",
				"journal.md":
					"## 2026-10-04\n- 09:00 first entry\n- 10:00 second entry\n## 2026-10-05\n- 11:00 newest entry\n",
				...files,
			}).map(([path, text]) => [`.shepherd/${path}`, text]),
		),
	);
	cleanups.push(f.cleanup);
	const tree = discoverTree(f.root);
	const workspace = tree.root;
	const env = fakeToolEnv({ home: f.root });
	const config = loadConfig({
		home: f.root,
		env: {},
		workspaceChain: [f.root],
	});
	const collect = (budget?: number) =>
		collectStart(workspace, env, config, budget);
	const put = (path: string, text: string) => {
		const full = join(workspace.state, path);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, text);
	};
	const certify = () => {
		const held = captureState(workspace, env);
		commitCheckpoint(
			workspace.state,
			held,
			nextCheckpoint(held, {
				written: env.now.toISOString(),
				session: "test-session",
			}),
		);
	};
	return { tree, workspace, env, config, collect, certify, put };
}

test("no checkpoint prints fallback section dates and RECONCILE", () => {
	const f = fixture();
	const text = renderStart(f.collect(), []);
	expect(text).toContain("RECONCILE");
	expect(text).toContain("last two sections (2026-10-04, 2026-10-05)");
});
test("certified unchanged workspace prints CLEAN", () => {
	const f = fixture();
	f.certify();
	expect(renderStart(f.collect(), [])).toContain("\nCLEAN\n");
});
test("budget retains a contiguous newest suffix and exact cut words and lines", () => {
	const f = fixture();
	const d = f.collect(8);
	expect(d.journal.entries.map((e) => e.line)).toEqual([3, 5]);
	expect(d.journal.cut).toEqual({
		entries: 1,
		words: 4,
		from: "journal.md:2",
		to: "journal.md:2",
	});
	expect(d.journal.text).toStartWith(
		"[cut: 1 earlier entries, 4 words, journal.md lines 2 to 2:",
	);
});
test("zero budget prints the cut notice and uncertified count without entries", () => {
	const d = fixture().collect(0);
	expect(d.journal.entries).toEqual([]);
	expect(d.journal.text.split("\n")).toHaveLength(2);
	expect(d.journal.text.split("\n")[1]).toBe(
		`${d.journal.uncertified} uncertified entries before the reviewed range`,
	);
	expect(d.journal.cut?.entries).toBe(3);
});
test("newest entry over budget is whole including continuation", () => {
	const d = fixture({
		"journal.md":
			"## 2026-10-05\n- old\n- a very long newest entry\n  with a continuation\n",
	}).collect(2);
	expect(d.journal.entries).toHaveLength(1);
	expect(d.journal.text).toContain(
		"a very long newest entry with a continuation",
	);
	expect(d.journal.text).toContain("printed whole");
});
test("stops at an oversized predecessor instead of filling from older entries", () => {
	const d = fixture({
		"journal.md":
			"## 2026-10-05\n- tiny\n- a very large middle entry taking many words\n- newest\n",
	}).collect(5);
	expect(d.journal.entries.map((e) => e.line)).toEqual([4]);
	expect(d.journal.cut?.entries).toBe(2);
});
test("cross file cut reports both file and line endpoints", () => {
	const d = fixture({
		"archive/journal/2026-10.md": "## 2026-10-04\n- archived first\n",
		"journal.md": "## 2026-10-05\n- second\n- newest\n",
	}).collect(2);
	expect(d.journal.text).toContain(
		"archive/journal/2026-10.md:2 to journal.md:2",
	);
});
test("CURRENT over 5000 words and This week section are printed whole", () => {
	const current = `## This week\n${"word ".repeat(5001)}`;
	const f = fixture({ "CURRENT.md": current });
	expect(renderStart(f.collect(0), [])).toContain(current);
});
test("pending non-bullet warnings are printed", () => {
	expect(
		renderStart(
			fixture({ "pending.md": "Warning: preserve this work" }).collect(),
			[],
		),
	).toContain("Warning: preserve this work");
});
const pendingTemplate =
	"# Pending\n\nDiscoveries not yet in their place: one bullet each, date first, then what, then `->` where it goes. Shown whole at\nevery session start. Remove a line when its destination carries it, and journal the move.\n";

test("exact 4.4 pending template prints none when registered", () => {
	const registered = TEMPLATES.find(
		(template) => String(template.path) === "pending.md",
	);
	if (registered) expect(registered.text).toBe(pendingTemplate);
	expect(fixture({ "pending.md": pendingTemplate }).collect().pending).toBe(
		registered ? "none" : pendingTemplate,
	);
	expect(
		fixture({ "pending.md": `${pendingTemplate}Warning\n` }).collect().pending,
	).toBe(`${pendingTemplate}Warning\n`);
});
test("empty and whitespace pending are explicit when a template is registered", () => {
	const registered = TEMPLATES.some(
		(template) => String(template.path) === "pending.md",
	);
	for (const pending of ["", " \t\n"])
		expect(fixture({ "pending.md": pending }).collect().pending).toBe(
			registered ? "(empty file)" : "none",
		);
	const f = fixture();
	rmSync(join(f.workspace.state, "pending.md"));
	expect(f.collect().pending).toBe("none");
});
test("missing CURRENT forces reconciliation", () => {
	const f = fixture();
	f.certify();
	rmSync(join(f.workspace.state, "CURRENT.md"));
	const d = f.collect();
	expect(d.assessment.verdict).toBe("RECONCILE");
	expect(d.current).toBe("CURRENT.md is missing");
});
test("fallback findings warn of misfiled headings", () => {
	const f = fixture();
	expect(
		renderStart(f.collect(), [
			{
				level: "warn",
				code: "journal-heading-order",
				file: "journal.md",
				message: "slip",
			},
		]),
	).toContain("headings may be misfiled; see check findings");
});
test("orphans follow the slice and remain visible at zero budget", () => {
	const d = fixture({
		"journal.md": "- orphan warning\n## 2026-10-05\n- dated\n",
	}).collect(0);
	expect(d.journal.text).toContain(
		"entries without a heading (not certified: give them a heading)\njournal.md:1 orphan warning",
	);
});
function findingsFixture() {
	return fixture({
		"MEMORY.md": "[missing](memories/missing.md)",
		"docs/INDEX.md": "[missing](missing.md)",
		"HANDOFF.md": "legacy briefing",
	});
}

test("check body and JSON match error and warn findings from a certified full fixture", () => {
	const f = findingsFixture();
	f.certify();
	const data = f.collect();
	expect(data.assessment.status).toBe("ok");
	expect(data.assessment.boundary.state).toBe("found");
	expect(data.assessment.dropped).toBeDefined();
	const findings = checkWorkspace(
		f.workspace,
		f.tree,
		f.config,
		f.env.now,
		f.env.home,
		f.env,
	);
	for (const level of ["error", "warn", "info"])
		expect(findings.some((finding) => finding.level === level)).toBe(true);
	const expected = findings
		.filter(({ level }) => level !== "info")
		.sort(
			(a, b) =>
				Number(a.level === "warn") - Number(b.level === "warn") ||
				a.file.localeCompare(b.file),
		);
	const expectedBody = [
		`${expected.filter(({ level }) => level === "error").length} errors, ${expected.filter(({ level }) => level === "warn").length} warnings`,
		...expected.map(
			(finding) =>
				`  ${finding.level.toUpperCase().padEnd(5)} ${finding.file}${finding.line ? `:${finding.line}` : ""}  ${finding.message}`,
		),
	].join("\n");
	const result = runStart(f.workspace, f.tree, f.env, f.config, {
		json: true,
		today: f.env.now,
	});
	expect(result.code).toBe(0);
	expect(JSON.parse(result.text).findings).toEqual(expected);
	const human = runStart(f.workspace, f.tree, f.env, f.config, {
		json: false,
		today: f.env.now,
	}).text;
	const body = human.split("## Check\n")[1]?.split("\n\n## Next")[0];
	expect(body).toBe(expectedBody);
	for (const finding of findings.filter(({ level }) => level === "info"))
		expect(body).not.toContain(finding.message);
});
test("JSON counts each printed source body and findings and sums sources", () => {
	const f = findingsFixture();
	const d = f.collect(4);
	const findings = checkWorkspace(
		f.workspace,
		f.tree,
		f.config,
		f.env.now,
		f.env.home,
		f.env,
	);
	const human = renderStart(d, findings);
	const json = startJson(d, findings);
	expect(json.findings.length).toBeGreaterThan(1);
	expect(json.words.findings).toBeGreaterThan(1);
	for (const [key, heading, next] of [
		["current", "CURRENT.md", "Pending"],
		["pending", "Pending", "Journal"],
		["journal", "Journal", "MEMORY.md"],
		["memoryIndex", "MEMORY.md", "docs/INDEX.md"],
		["docsIndex", "docs/INDEX.md", "Check"],
		["findings", "Check", "Next"],
	] as const) {
		const body =
			human
				.split(`## ${heading}`)[1]
				?.split("\n")
				.slice(1)
				.join("\n")
				.split(`\n\n## ${next}`)[0] ?? "";
		expect(json.words[key]).toBe(words(body));
	}
	expect(json.words.start).toBe(
		json.words.current +
			json.words.pending +
			json.words.journal +
			json.words.memoryIndex +
			json.words.docsIndex,
	);
});

test("configuration supplies budget and explicit budget overrides it", () => {
	const f = fixture();
	f.config.start.journalWords = 4;
	expect(f.collect().journal.entries).toHaveLength(1);
	expect(f.collect(12).journal.entries).toHaveLength(3);
	expect(f.collect(12).journal.cut).toBeUndefined();
});
test("single oversized entry has no cut and binary override is recorded", () => {
	const f = fixture({
		"journal.md": "## 2026-10-05\n- oversized newest entry\n",
	});
	f.env.execPath = "/test/shepherd";
	const d = f.collect(1);
	expect(d.journal.entries).toHaveLength(1);
	expect(d.journal.cut).toBeUndefined();
	expect(d.binary).toBe("/test/shepherd");
	expect(renderStart(d, [])).toContain("binary: /test/shepherd");
});
test("invalid checkpoint is printed and falls back", () => {
	const f = fixture({ "checkpoint.json": "{" });
	const d = f.collect();
	expect(d.journal.mode).toBe("fallback");
	expect(renderStart(d, [])).toContain("invalid checkpoint:");
});
test("nonempty pending remains visible without a registered template", () => {
	const f = fixture({ "pending.md": "# Pending\nWarning: never hide this" });
	expect(f.collect().pending).toBe("# Pending\nWarning: never hide this");
});

test("cut range includes the last cut entry's two continuation lines", () => {
	const d = fixture({
		"journal.md":
			"## 2026-10-05\n- 09:00 aaa\n- 10:00 bbb long\n  first continuation\n\tsecond continuation\n- 11:00 ccc\n",
	}).collect(3);
	expect(d.journal.entries.map((entry) => entry.line)).toEqual([6]);
	expect(d.journal.cut).toEqual({
		entries: 2,
		words: 11,
		from: "journal.md:2",
		to: "journal.md:5",
	});
	expect(d.journal.text).toContain("journal.md lines 2 to 5:");
	expect(startJson(d, []).journal.cut?.to).toBe("journal.md:5");
});
test("cut continuation range stops at blank lines and fenced blocks", () => {
	for (const stop of ["\n  unrelated", "  ```\n  fenced\n  ```"]) {
		const d = fixture({
			"journal.md": `## 2026-10-05\n- cut entry\n  continuation\n${stop}\n- newest\n`,
		}).collect(2);
		expect(d.journal.cut?.to).toBe("journal.md:3");
	}
});
test("no unreviewed entries prints none before orphan warnings", () => {
	const d = fixture({ "journal.md": "- orphan warning\n" }).collect(0);
	expect(d.journal.text).toStartWith("none\nentries without a heading");
	expect(d.journal.text).toContain(
		`${d.journal.uncertified} uncertified entries before the reviewed range`,
	);
});

test("registered pending template distinguishes identical, empty and whitespace in isolation", () => {
	const f = fixture();
	const script = `
		import { mock } from "bun:test";
		import { writeFileSync } from "node:fs";
		import { join } from "node:path";
		const template = ${JSON.stringify(pendingTemplate)};
		mock.module(${JSON.stringify(join(import.meta.dir, "guides.ts"))}, () => ({
			TEMPLATES: [{ path: "pending.md", master: false, text: template }],
		}));
		const { collectStart } = await import(${JSON.stringify(join(import.meta.dir, "start-collect.ts"))});
		const { fakeToolEnv } = await import(${JSON.stringify(join(import.meta.dir, "test-support.ts"))});
		const workspace = ${JSON.stringify(f.workspace)};
		const config = ${JSON.stringify(f.config)};
		const env = fakeToolEnv({ home: workspace.dir });
		const result = [];
		for (const text of [template, "", " \\t\\n"]) {
			writeFileSync(join(workspace.state, "pending.md"), text);
			result.push(collectStart(workspace, env, config).pending);
		}
		console.log(JSON.stringify(result));
	`;
	const child = Bun.spawnSync([process.execPath, "-e", script]);
	expect(child.exitCode).toBe(0);
	expect(JSON.parse(child.stdout.toString())).toEqual([
		"none",
		"(empty file)",
		"(empty file)",
	]);
});
