import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
	chmodSync,
	cpSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { MAIL_TOOLS, packageText } from "../lib/shepherd/test-support";
import { PACKAGE_ROOT } from "./shepherd-definition";

// O21: Shepherd package contract 1 selects one set of packages and
// offerings, and the prompt (composition), tool dispatch (`shepherd tool
// <package> <tool>` routing) and guide selection all agree on it, and the
// composed prompt carries each selected package's body and no refused
// one's. The
// packages are external fixtures: a scratch copy of the package whose base
// `packages/` holds only fixture packages, and enclosing workspaces'
// `.shepherd/packages/`. Fake workspaces and HOME only.

setDefaultTimeout(120_000);

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "connector-parity-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const copy = join(scratch, "shepherd");
cpSync(PACKAGE_ROOT, copy, {
	recursive: true,
	filter: (source) => {
		const first = relative(PACKAGE_ROOT, source).split("/")[0];
		return !["node_modules", "bin", "packages", "evals"].includes(first ?? "");
	},
});
symlinkSync(join(PACKAGE_ROOT, "node_modules"), join(copy, "node_modules"));
const home = join(scratch, "home");
mkdirSync(home, { recursive: true });

function write(path: string, text: string, mode?: number): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
	if (mode !== undefined) chmodSync(path, mode);
}

const TOOL = "#!/bin/sh\necho ran\n";

/** A package directory: MODULE.md, executable tools and guides. */
function pkg(
	dir: string,
	moduleText: string,
	tools: string[],
	guides: string[],
): void {
	write(join(dir, "MODULE.md"), moduleText);
	for (const tool of tools) write(join(dir, "tools", tool), TOOL, 0o755);
	for (const guide of guides) {
		write(join(dir, "guides", `${guide}.md`), `# ${guide}\n\nSteps.\n`);
	}
}

/** A provider of `slot`, with one read tool and one guide. */
const provider = (name: string, slot: string, isDefault: boolean) =>
	`---\nname: ${name}\ntype: domain\ndescription: ${name} provider\nprovides: ${slot}\n${isDefault ? "default: true\n" : ""}applies-when:\n  charter-declares: ${slot}\nbudget: 400\ncharter-keys: {}\ncontract: 1\ntools:\n  unread:\n    description: List unread threads\n    access: read\nguides:\n  triage:\n    description: How to triage\n---\n# Integration: ${name}\n\n${name} provider body.\n`;

const LIST =
	"tools:\n  list:\n    description: List notes\n    access: read\nguides:\n  howto:\n    description: How to take notes\n";

// Base location: fixture packages only.
const base = join(copy, "packages");
pkg(join(base, "notes"), packageText("notes", LIST), ["list"], ["howto"]);
pkg(join(base, "dup"), packageText("dup", LIST), ["list"], ["howto"]);
pkg(join(base, "jots"), packageText("jots", LIST), ["list"], ["howto"]);
pkg(join(base, "hey"), provider("hey", "inbox", true), ["unread"], ["triage"]);
pkg(
	join(base, "gmail"),
	provider("gmail", "inbox", false),
	["unread"],
	["triage"],
);
// Invalid metadata: an unsupported contract, and an unknown key.
pkg(
	join(base, "broken"),
	packageText("broken", LIST, undefined, "contract: 2\n"),
	["list"],
	["howto"],
);
pkg(
	join(base, "typo"),
	packageText("typo", `colour: red\n${LIST}`),
	["list"],
	["howto"],
);

interface Scenario {
	name: string;
	charter: string;
	/** Packages in the enclosing workspace's `.shepherd/packages/`. */
	enclosing?: (dir: string) => void;
	/** Files in the workspace's own `.shepherd/`. */
	local?: (state: string, parent: string) => void;
	/** The package offerings contract 1 selects: `<package> <tool|guide>`. */
	tools: string[];
	guides: string[];
	/** Problem codes the session header reports. */
	codes: string[];
}

const LOCAL_INBOX =
	"---\nname: inbox\ntype: domain\ndescription: Local inbox rules\nbudget: 100\napplies-when:\n  charter-declares: inbox\n---\nLocal inbox body.\n";

const SCENARIOS: Scenario[] = [
	{
		name: "inherited and local deduplication",
		charter: "Modules: mail notes\n",
		enclosing: (dir) =>
			pkg(
				join(dir, "mail"),
				packageText("mail", MAIL_TOOLS),
				["unread", "send"],
				["triage"],
			),
		// The workspace's own integration is the inherited package's MODULE.md.
		local: (state, parent) =>
			symlinkSync(
				join(parent, ".shepherd/packages/mail/MODULE.md"),
				join(state, "integrations/mail.md"),
			),
		tools: ["mail send", "mail unread", "notes list"],
		guides: ["mail triage", "notes howto"],
		codes: [],
	},
	{
		name: "a package in two locations loads in neither",
		charter: "Modules: dup notes\n",
		enclosing: (dir) =>
			pkg(join(dir, "dup"), packageText("dup", LIST), ["list"], ["howto"]),
		tools: ["notes list"],
		guides: ["notes howto"],
		codes: ["package-duplicate", "module-token-unknown"],
	},
	{
		name: "a slot selects its default provider",
		charter: "Modules: inbox\n",
		tools: ["hey unread"],
		guides: ["hey triage"],
		codes: [],
	},
	{
		name: "a slot conflicting with a module that provides nothing loads no provider",
		charter: "Modules: inbox\n",
		local: (state) => write(join(state, "integrations/inbox.md"), LOCAL_INBOX),
		tools: [],
		guides: [],
		codes: ["module-slot-conflict"],
	},
	{
		name: "invalid metadata excludes a package",
		charter: "Modules: broken typo notes\n",
		tools: ["notes list"],
		guides: ["notes howto"],
		codes: ["package-contract", "module-schema", "module-token-unknown"],
	},
	{
		name: "two explicit providers of one slot load neither",
		charter: "Modules: hey gmail\n",
		tools: [],
		guides: [],
		codes: ["module-slot-conflict"],
	},
	{
		name: "duplicate offerings stay per package",
		charter: "Modules: notes jots\n",
		tools: ["jots list", "notes list"],
		guides: ["jots howto", "notes howto"],
		codes: [],
	},
	{
		name: "unknown tokens select nothing",
		charter: "Modules: ghost notes\n",
		tools: ["notes list"],
		guides: ["notes howto"],
		codes: ["module-token-unknown"],
	},
];

const NAMES = [
	"notes",
	"dup",
	"jots",
	"hey",
	"gmail",
	"broken",
	"typo",
	"mail",
	"ghost",
	"inbox",
];
const TOOLS = ["unread", "send", "list", "nosuch"];
const GUIDES = ["triage", "howto", "nosuch"];

/** Each scenario's workspace, beneath an enclosing workspace. */
const workspaces = SCENARIOS.map((scenario, index) => {
	const parent = join(scratch, `scenario-${index}`, "parent");
	const ws = join(parent, "ws");
	write(join(parent, ".shepherd/charter.md"), "");
	mkdirSync(join(parent, ".shepherd/packages"), { recursive: true });
	scenario.enclosing?.(join(parent, ".shepherd/packages"));
	write(join(ws, ".shepherd/charter.md"), scenario.charter);
	mkdirSync(join(ws, ".shepherd/integrations"), { recursive: true });
	scenario.local?.(join(ws, ".shepherd"), parent);
	return ws;
});

// Run in the copy, so its base location is the copy's fixture `packages/`.
const PROBE = `
import { composeSession } from "./lib/shepherd/compose";
import { dispatchPackageTool } from "./lib/shepherd/dispatch";
import { fakeToolEnv } from "./lib/shepherd/test-support";
import { runTool } from "./lib/shepherd/tool";
import { findEnclosingWorkspace } from "./lib/shepherd/workspace";
const { home, workspaces, names, tools, guides } = JSON.parse(process.argv[2]);
const results = [];
for (const ws of workspaces) {
	let problems = "";
	const { fragments, packages } = composeSession(ws, "claude", findEnclosingWorkspace(ws), [], new Date(0), (details) => { problems = details; });
	const env = { HOME: home, SHEPHERD_WORKSPACE: ws };
	const dispatched = [];
	const guided = [];
	for (const name of names) {
		for (const tool of tools) {
			if (dispatchPackageTool(["tool", name, tool], { cwd: ws, env })?.exec) dispatched.push(name + " " + tool);
		}
		for (const guide of guides) {
			const result = await runTool(["guide", name, guide], {}, fakeToolEnv({ home, cwd: ws, env }));
			if (result.code === 0) guided.push(name + " " + guide);
		}
	}
	const listed = (await runTool(["guide"], {}, fakeToolEnv({ home, cwd: ws, env }))).text
		.split("\\n")
		.map((line) => line.split(":")[0])
		.filter((head) => names.some((name) => head.startsWith(name + " ")));
	results.push({
		composed: fragments.join("\\n"),
		selected: packages.map((p) => ({ name: p.name, tools: Object.keys(p.tools), guides: Object.keys(p.guides) })),
		dispatched,
		guided,
		listed,
		problems,
	});
}
console.log(JSON.stringify(results));
`;
writeFileSync(join(copy, "parity-probe.ts"), PROBE);

interface Outcome {
	/** The composed prompt text. */
	composed: string;
	/** The package records composition returns. */
	selected: { name: string; tools: string[]; guides: string[] }[];
	dispatched: string[];
	guided: string[];
	listed: string[];
	problems: string;
}

const child = Bun.spawnSync(
	[
		process.execPath,
		"--no-install",
		"parity-probe.ts",
		JSON.stringify({
			home,
			workspaces,
			names: NAMES,
			tools: TOOLS,
			guides: GUIDES,
		}),
	],
	{
		cwd: copy,
		env: {
			...process.env,
			HOME: home,
			XDG_CONFIG_HOME: join(scratch, "xdg"),
			NODE_PATH: join(copy, "node_modules"),
		},
		stdout: "pipe",
		stderr: "pipe",
	},
);
if (child.exitCode !== 0) throw new Error(child.stderr.toString());
const outcomes = JSON.parse(child.stdout.toString()) as Outcome[];

const sorted = (values: string[]) => [...values].sort();

/** Each fixture package's distinctive body line. */
const BODIES: Record<string, string> = Object.fromEntries([
	...["notes", "dup", "jots", "broken", "typo", "mail"].map((name) => [
		name,
		`${name} package body.`,
	]),
	...["hey", "gmail"].map((name) => [name, `${name} provider body.`]),
]);

describe("contract 1 selection agrees across prompts, tools and guides (O21)", () => {
	SCENARIOS.forEach((scenario, index) => {
		test(scenario.name, () => {
			const outcome = outcomes[index] as Outcome;
			const promptTools = outcome.selected.flatMap((p) =>
				p.tools.map((tool) => `${p.name} ${tool}`),
			);
			const promptGuides = outcome.selected.flatMap((p) =>
				p.guides.map((guide) => `${p.name} ${guide}`),
			);
			const context = { scenario: scenario.name, problems: outcome.problems };
			const codes = [
				...outcome.problems.matchAll(/: ([a-z]+(?:-[a-z]+)+): /g),
			].map((match) => match[1]);
			expect(sorted([...new Set(codes)] as string[])).toEqual(
				sorted(scenario.codes),
			);
			expect({ ...context, tools: sorted(promptTools) }).toEqual({
				...context,
				tools: sorted(scenario.tools),
			});
			expect({ ...context, tools: sorted(outcome.dispatched) }).toEqual({
				...context,
				tools: sorted(scenario.tools),
			});
			expect({ ...context, guides: sorted(promptGuides) }).toEqual({
				...context,
				guides: sorted(scenario.guides),
			});
			expect({ ...context, guides: sorted(outcome.guided) }).toEqual({
				...context,
				guides: sorted(scenario.guides),
			});
			expect({ ...context, guides: sorted(outcome.listed) }).toEqual({
				...context,
				guides: sorted(scenario.guides),
			});
			// The composed prompt carries a selected package's body, not a refused one's.
			const chosen = new Set(
				[...scenario.tools, ...scenario.guides].map(
					(each) => each.split(" ")[0],
				),
			);
			const lines = outcome.composed.split("\n");
			const bodies = Object.fromEntries(
				Object.entries(BODIES).map(([name, line]) => [
					name,
					lines.includes(line),
				]),
			);
			expect({ ...context, bodies }).toEqual({
				...context,
				bodies: Object.fromEntries(
					Object.keys(BODIES).map((name) => [name, chosen.has(name)]),
				),
			});
		});
	});
});
