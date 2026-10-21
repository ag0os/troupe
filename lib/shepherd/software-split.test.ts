import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packageLocations, packageModules } from "./package-resolution";

const POINTER =
	"The rest of steps 3 to 8 is in guides, read when the plan reaches the step and before any brief for it: `shepherd tool guide software build` holds the shape table's Contract timing and Checks rows, steps 3 to 5 and the skills rule; `software check` steps 6 and 7; `software ship` step 8, the grants' journal, and a task that waits on the user, read also when a task parks or resumes; `software hooks` the builder hooks runbook, read before launching a Claude Code builder.";
const SHAPES_POINTER =
	"The table's Contract timing and Checks rows are in `shepherd tool guide software build`, read before briefing a builder.";
const TABLE_HEAD = ["| | Bug | Feature | Chore |", "|---|---|---|---|"];

const STEPS = [
	"Story straight.",
	"The One Question.",
	"The Contract.",
	"Inhale.",
	"Exhale, same PR.",
	"Checks before done.",
	"Review by blast radius.",
	"The pull request.",
	"Merge under a grant, otherwise present.",
];

/** The opening words of each part that moves out. */
const MOVED = [
	"| Contract timing |",
	"| Checks |",
	"Red first stays for bugs and for pins",
	"Grow it per change into the component's file",
	"Where mutation cannot run, each new test is shown red",
	"Its brief names the base revision",
	"The builder folds the build back",
	"Mutation and the health checks",
	"A finding that the Contract was wrong or silent",
	"The pull request lets the user assess",
	"Journal what bears on widening or narrowing the grants",
	"A task that waits on the user, for a reserved decision",
	"The delegate's output is still held",
];

/**
 * Sentences the split review ruled must stay loaded (F1, F2, F3, F5, D2).
 * Three are the draft's successors to the sentences first pinned: the merge
 * grant, the one line plan and scoped mutation.
 */
const KEPT = [
	"where data matters, authorized representative records, read only, in a safe environment",
	"A merge grant the user wrote, in the plan or in charter slot `software.merge-grant`",
	"A chore's or a bug's one line (Shapes, above) in `CURRENT.md` serves as its plan",
	"mutation wherever the project can run it, on every subject where that runs in reasonable time, otherwise scoped to the changed code",
	"The builder stops only for a decision the plan reserves",
	"where the question is one the user reserved, put throwaway prototypes in front of them",
];

/** What the module must hold because a mistake on it happens before anyone opens a guide (K1 to K4). */
const KEEPERS = {
	shape: [
		"Every change takes one shape, chosen by rule 9's definition and by whether behavior changes. When the choice is unclear, ask the user.",
		"each change's shape, blast radius and size go with its entry",
	],
	merge: [
		"When a grant covers this pull request and every condition it names holds",
		"merge only with the user's explicit permission for this pull request, its open choices settled and the project's required checks satisfied",
		"Green checks alone authorize no merge.",
		"A grant covers small blast radius only, unless its text names the large kinds it covers.",
		"or a check the project lacks that the grant's text does not name as accepted, is presented",
	],
	bug: "A production bug enters first: its sentence, its test failing on the unfixed code, then the fix.",
};

const software = packageModules(packageLocations(undefined)).find(
	(m) => m.package?.name === "software",
);
const remainder = software?.body ?? "";
const guideNames = Object.keys(software?.package?.guides ?? {});
const guides = guideNames.map((name) =>
	readFileSync(
		join(software?.package?.dir ?? "", "guides", `${name}.md`),
		"utf8",
	),
);
const guide = (name: string) => guides[guideNames.indexOf(name)] ?? "";
const step = (n: number) =>
	remainder.split("\n").find((line) => line.startsWith(`${n}. **`)) ?? "";

function inNoGuide(literal: string) {
	for (const [index, text] of guides.entries())
		expect({
			guide: guideNames[index],
			literal,
			found: text.includes(literal),
		}).toEqual({ guide: guideNames[index], literal, found: false });
}

describe("software's guide split keeps steps whole and safety rules loaded (O4)", () => {
	test("software declares exactly the build, check, ship and hooks guides", () => {
		expect(software?.problems).toEqual([]);
		expect(guideNames).toEqual(["build", "check", "ship", "hooks"]);
	});

	test("the pointer sits between the core preamble and step 1 and names the guide for steps 3, 6 and 8, step 9 whole in the module (K2)", () => {
		expect(remainder.split(POINTER).length - 1).toBe(1);
		expect(remainder).toContain(
			`keep it current.\n\n${POINTER}\n\n1. **Story straight.**`,
		);
		for (const pointer of [
			"`shepherd tool guide software build` holds",
			"steps 3 to 5",
			"`software check` steps 6 and 7",
			"`software ship` step 8",
			"`software hooks` the builder hooks runbook",
		])
			expect(POINTER).toContain(pointer);
	});

	test("each step keeps its number, name, criterion and the user's part", () => {
		for (const [index, name] of STEPS.entries()) {
			const items = remainder
				.split("\n")
				.filter((line) => line.startsWith(`${index + 1}. **${name}**`));
			expect({ name, items: items.length }).toEqual({ name, items: 1 });
			expect(items[0]).toContain("Complete when");
			expect(items[0]).toContain("The user's part");
		}
		for (const marker of [
			...STEPS.map((name) => `**${name}**`),
			"Complete when",
			"The user's part",
		])
			inNoGuide(marker);
	});

	test("moved sentences leave the module and land in one guide", () => {
		for (const literal of MOVED) {
			expect({ literal, inModule: remainder.includes(literal) }).toEqual({
				literal,
				inModule: false,
			});
			expect({
				literal,
				guides: guides.filter((g) => g.includes(literal)).length,
			}).toEqual({ literal, guides: 1 });
		}
	});

	test("the safety sentences the split review ruled on stay loaded", () => {
		for (const literal of KEPT) {
			expect(remainder).toContain(literal);
			inNoGuide(literal);
		}
	});

	test("each guide holds its own sections, in order", () => {
		const headings = (text: string) =>
			text.split("\n").filter((line) => line.startsWith("## "));
		expect(headings(guide("build"))).toEqual([
			"## Shapes: the Contract and the checks",
			"## 3. The Contract",
			"## 4. Inhale: the delegate's brief and backbrief",
			"## 5. Exhale, same PR",
			"## Skills are the delegate's craft",
		]);
		expect(headings(guide("check"))).toEqual([
			"## 6. Checks before done",
			"## 7. Review by blast radius",
		]);
		expect(headings(guide("ship"))).toEqual([
			"## 8. The pull request",
			"## Widening or narrowing the grants",
			"## A task that waits on the user",
		]);
		expect(headings(guide("hooks"))).toEqual([]);
	});
});

describe("software's shapes keep what acts before a guide in the module (K1 to K4)", () => {
	test("the shape is chosen and recorded at step 1, asking the user when unclear (K1)", () => {
		expect(remainder).toContain(`## Shapes\n\n${KEEPERS.shape[0]}`);
		expect(step(1)).toContain(KEEPERS.shape[1]);
		for (const literal of KEEPERS.shape) inNoGuide(literal);
	});

	test("step 9 merges only under a covering grant or the user's explicit permission (K3)", () => {
		for (const literal of KEEPERS.merge) {
			expect(step(9)).toContain(literal);
			inNoGuide(literal);
		}
		for (const text of guides) expect(text).not.toContain("\n## 9.");
	});

	test("a production bug goes red first, in step 3 (K4)", () => {
		expect(step(3)).toContain(KEEPERS.bug);
		expect(step(3).indexOf(KEEPERS.bug)).toBeLessThan(
			step(3).indexOf("Complete when"),
		);
		inNoGuide(KEEPERS.bug);
	});

	test("the two axes and the three shape names are in the module", () => {
		for (const literal of [
			"## Two axes: blast radius and size",
			"- **Bug:** a defect in code that is live in production.",
			"- **Feature:** behavior is added or changed.",
			"- **Chore:** no behavior changes",
			"Review depth and the merge follow the axes, not the shape.",
		]) {
			expect(remainder).toContain(literal);
			inNoGuide(literal);
		}
	});

	test("the table's first two rows stay in the module and its last two are in build", () => {
		const rows = (text: string) =>
			text.split("\n").filter((line) => line.startsWith("|"));
		const labels = (text: string) =>
			rows(text)
				.slice(2)
				.map((line) => line.split("|")[1]?.trim());
		expect(rows(remainder).slice(0, 2)).toEqual(TABLE_HEAD);
		expect(labels(remainder)).toEqual(["Agreement", "One Question"]);
		expect(rows(guide("build")).slice(0, 2)).toEqual(TABLE_HEAD);
		expect(labels(guide("build"))).toEqual(["Contract timing", "Checks"]);
		expect(rows(guide("check"))).toEqual([]);
		expect(rows(guide("ship"))).toEqual([]);
		expect(remainder).toContain(`|\n\n${SHAPES_POINTER} Review depth`);
	});
});
