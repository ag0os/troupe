import { describe, expect, test } from "bun:test";
import { parseModule } from "./module-format";
import { MAIL_TOOLS, packageText } from "./test-support";

const fields = "name: sample\ntype: domain\ndescription: A sample\nbudget: 3\n";
const annotated = (yaml = fields, body = "one two three\n") =>
	`---\n${yaml}---\n${body}`;

test("recognition preserves legacy thematic breaks and exact LF/CRLF body bytes", () => {
	for (const raw of [
		"plain\n",
		"---\n# Title\n",
		"---\n# Title\n---\nbody\n",
		"---\n# Title\nname: x\n---\nbody\n",
		"---\nprose\n---\nbody\n",
		" ---\nname: sample\n",
		"---\nunknown: value\n---\nbody",
	]) {
		expect(parseModule(raw, "sample.md")).toMatchObject({
			kind: "legacy",
			body: raw,
			problems: [],
		});
	}
	for (const newline of ["\n", "\r\n"]) {
		const body = `${newline}body  ${newline}${newline}`;
		const raw = annotated(fields, body).replaceAll("\n", newline);
		expect(parseModule(raw, "sample.md").body).toBe(
			raw.slice(raw.indexOf(`---${newline}`, 4) + 3 + newline.length),
		);
	}
	expect(
		parseModule("---\n\nname: sample\n# comment\nbody", "sample.md"),
	).toMatchObject({
		kind: "malformed",
		body: undefined,
		problems: [{ code: "module-schema" }],
	});
});

test("strict schema accepts predicates, owned keys, numeric names and defaults", () => {
	const result = parseModule(
		annotated(
			`${fields}provides: craft\ndefault: true\napplies-when:\n  enclosing-modules: false\n  has-children: true\n  charter-declares: craft\ncharter-keys:\n  sample.value: required\n  craft.value: optional\n  core.done: optional\n`,
		),
		"sample.md",
	);
	expect(result.problems).toEqual([]);
	expect(result.metadata).toMatchObject({ default: true, budget: 3 });
	expect(
		parseModule(annotated(fields.replace("sample", "00-flock")), "00-flock.md")
			.problems,
	).toEqual([]);
	expect(parseModule(annotated(), "sample.md").metadata).toMatchObject({
		default: false,
		"charter-keys": {},
	});
});

for (const yaml of [
	`${fields}extra: true\n`,
	`${fields}applies-when:\n  other: true\n`,
	fields.replace("budget: 3", "budget: '3'"),
	...["1e3", "0x10", "0o10", "10.0", "+10"].map((value) =>
		fields.replace("budget: 3", `budget: ${value}`),
	),
	fields.replace("budget: 3", "budget: 0"),
	fields.replace("budget: 3", "budget: 1.5"),
	fields.replace("budget: 3", "budget: 9007199254740992"),
	fields.replace("description: A sample", "description: null"),
	fields.replace("description: A sample", "description: '   '"),
	fields.replace("description: A sample", "description: |\n  two\n  lines"),
	fields.replace("type: domain", "type: other"),
	fields.replace("type: domain\n", ""),
	`${fields}default: false\n`,
	`${fields}provides: slot1\n`,
	`${fields}provides: craft\ndefault: 'true'\n`,
	`${fields}applies-when:\n  has-children: null\n`,
	`${fields}applies-when:\n  charter-declares: code2\n`,
	`${fields}charter-keys:\n  other.value: optional\n`,
	`${fields}charter-keys:\n  core.unknown: optional\n`,
	`${fields}charter-keys:\n  sample.value: true\n`,
	`${fields}budget: 3\n`,
	`${fields}description: &anchor text\n`,
	`${fields}extra: *anchor\n`,
	fields.replace("description: A sample", "description: !!str text"),
	`${fields}<<: {}\n`,
	`${fields}1: value\n`,
	`${fields}? [a, b]\n: value\n`,
	`${fields}%YAML 1.2\n`,
	`${fields}applies-when: []\n`,
	"name: sample\n- broken\n",
	"name: sample\n...\n%YAML 1.2\n",
]) {
	test(`strict YAML rejects ${JSON.stringify(yaml)}`, () => {
		const result = parseModule(annotated(yaml, "body  \n"), "sample.md");
		expect(result.body).toBe("body  \n");
		expect(result.metadata).toBeUndefined();
		expect(result.problems[0]?.code).toBe("module-schema");
		expect(result.problems[0]?.line).toBeGreaterThanOrEqual(2);
	});
}

test("name mismatch is separate and symlink filename is authoritative", () => {
	expect(parseModule(annotated(), "alias.md").problems).toMatchObject([
		{
			code: "module-name",
			message: 'name "sample" must equal file stem "alias"',
		},
	]);
});

test("reserved signature requires whitespace or end of line after colon", () => {
	expect(parseModule("---\nname:sample\n---\nbody", "sample.md")).toMatchObject(
		{ kind: "legacy", body: "---\nname:sample\n---\nbody", problems: [] },
	);
	expect(parseModule(`---\n${fields}---`, "sample.md").body).toBe("");
});

for (const [name, extra] of [
	["00-flock", "provides: craft\n"],
	["00-flock", "charter-keys:\n  00-flock.value: optional\n"],
	["sample", "applies-when: null\n"],
	["sample", "charter-keys: null\n"],
	["sample", "provides: null\n"],
	["sample", "charter-keys:\n  sample.key--name: optional\n"],
	["sample", "name: sample\n"],
	[
		"sample",
		"applies-when:\n  has-children: &flag true\n  enclosing-modules: *flag\n",
	],
	["sample", "applies-when:\n  has-children: true\n  has-children: false\n"],
] as const) {
	test(`rejects numeric ownership, nulls and nested YAML constructs: ${name} ${extra}`, () => {
		expect(
			parseModule(
				annotated(`${fields.replace("sample", name)}${extra}`),
				`${name}.md`,
			).problems[0]?.code,
		).toBe("module-schema");
	});
}

test("schema problems are ordered by source line including owned keys", () => {
	const result = parseModule(
		annotated(
			`${fields}charter-keys:\n  other.key: optional\n  sample.valid: broken\n`,
		),
		"sample.md",
	);
	expect(result.problems.map((p) => p.line)).toEqual([7, 8]);
});

test("closing delimiter must occupy an exact complete line", () => {
	const raw = `---\n${fields} ---\nbody`;
	expect(parseModule(raw, "sample.md")).toMatchObject({
		kind: "malformed",
		body: undefined,
	});
});
test("comments after the first field remain valid YAML", () => {
	expect(
		parseModule(
			annotated(fields.replace("type:", "# comment\ntype:")),
			"sample.md",
		).problems,
	).toEqual([]);
});

describe("package fields (O6)", () => {
	const pkg = (extra: string, contract = "contract: 1\n") =>
		parseModule(packageText("mail", extra, "body\n", contract), "mail.md", {
			package: true,
		});
	const codes = (parsed: ReturnType<typeof parseModule>) =>
		parsed.problems.map((p) => `${p.code}: ${p.message}`);

	test("the contract's mail example parses", () => {
		const parsed = pkg(MAIL_TOOLS);
		expect(parsed.problems).toEqual([]);
		expect(parsed.metadata?.contract).toBe(1);
		expect(parsed.metadata?.tools?.unread?.access).toBe("read");
		expect(parsed.metadata?.guides?.triage?.description).toBe(
			"How to triage the inbox, in order",
		);
	});

	test.each([
		[
			"access: execute",
			"tools:\n  unread:\n    description: List\n    access: execute\n",
			"tools.unread.access",
		],
		[
			"a missing tool description",
			"tools:\n  unread:\n    access: read\n",
			"tools.unread.description",
		],
		[
			"a tool name with uppercase",
			"tools:\n  Unread:\n    description: List\n    access: read\n",
			"tools",
		],
		[
			"an unknown tool key",
			"tools:\n  unread:\n    description: List\n    access: read\n    shell: true\n",
			"tools.unread.shell",
		],
		[
			"a non-boolean network",
			"tools:\n  unread:\n    description: List\n    access: read\n    network: yes\n",
			"tools.unread.network",
		],
		[
			"requires that is not a list of names",
			"tools:\n  unread:\n    description: List\n    access: read\n    requires: hey\n",
			"tools.unread.requires",
		],
		[
			"a guide without a description",
			"guides:\n  triage: {}\n",
			"guides.triage.description",
		],
	])("rejects %s", (_, extra, field) => {
		const parsed = pkg(extra);
		expect(parsed.metadata).toBeUndefined();
		// The field is known in a package; only its value is wrong.
		for (const key of ["tools", "guides"])
			expect(codes(parsed)).not.toContain(`module-schema: ${key}: unknown key`);
		expect(
			codes(parsed).some((c) => c.startsWith(`module-schema: ${field}`)),
		).toBe(true);
	});

	test("contract other than the integer 1 is package-contract", () => {
		for (const contract of ["contract: 2\n", 'contract: "1"\n', ""]) {
			const parsed = pkg("", contract);
			expect(parsed.body).toBeUndefined();
			expect(parsed.problems.map((p) => p.code)).toEqual(["package-contract"]);
		}
	});

	test("contract, tools and guides are module-schema errors in an integrations file", () => {
		for (const extra of [
			"contract: 1\n",
			"tools:\n  unread:\n    description: List\n    access: read\n",
			"guides:\n  triage:\n    description: Triage\n",
		]) {
			const parsed = parseModule(
				annotated(
					`name: mail\ntype: domain\ndescription: Mail\nbudget: 3\n${extra}`,
				),
				"mail.md",
			);
			const key = extra.split(":")[0];
			expect(codes(parsed)).toContain(
				`module-schema: ${key}: allowed only in a package MODULE.md`,
			);
		}
		// An integrations file that opens with a package key is annotated, not legacy.
		const opening = parseModule("---\ncontract: 1\n---\nbody\n", "x.md");
		expect(opening.kind).toBe("annotated");
	});
});
