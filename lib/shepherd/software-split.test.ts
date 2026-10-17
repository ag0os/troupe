import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packageLocations, packageModules } from "./package-resolution";

const POINTER =
	"The rest of steps 3 to 9 is in guides, read when the plan reaches the step and before any brief for it: `shepherd tool guide software build` holds steps 3 to 5 and the skills rule; `software check` steps 6 and 7; `software ship` steps 8 and 9, automatic merging, and a task that waits on the user, read also when a task parks or resumes.";
const KEEPS =
	"The module keeps each step's name, completion criterion, the user's part and its safety rules, which a brief that sends a delegate here must state itself.";

/** Every word the split adds: the pointer, then each guide's title, pointer paragraph and headings. */
const NEW_TEXT = [
	POINTER,
	"# Guide: the software cycle, steps 3 to 5",
	KEEPS,
	"This guide holds the rest of steps 3 to 5, in order, and the rest of the skills rule.",
	"## 3. The Contract",
	"## 4. Inhale: the delegate's brief and backbrief",
	"## 5. Exhale, same PR",
	"## Skills are the delegate's craft",
	"# Guide: the software cycle, steps 6 and 7",
	KEEPS,
	"This guide holds the rest of steps 6 and 7, in order.",
	"## 6. Checks before done",
	"## 7. Review by blast radius",
	"# Guide: the software cycle, steps 8 and 9",
	KEEPS,
	"This guide holds the rest of steps 8 and 9, in order, then automatic merging and the task that waits on the user.",
	"## 8. Present the PR",
	"## 9. Revise and merge",
	"## Automatic merging",
	"## A task that waits on the user",
];

const STEPS = [
	"Story straight.",
	"The One Question.",
	"The Contract.",
	"Inhale.",
	"Exhale, same PR.",
	"Checks before done.",
	"Review by blast radius.",
	"Present the PR.",
	"Revise and merge.",
];

/** The opening words of the first sentence each part moves out. */
const MOVED = [
	"Grow it per change into the docs that exist",
	"Its brief names the base revision",
	"The builder folds the build back",
	"Mutation and the health checks",
	"A finding that the Contract was wrong or silent",
	"The pull request lets the user assess",
	"Address the feedback",
	"Broader automatic merging",
	"A task that waits on the user, for a reserved decision",
	"The delegate's output is still held",
];

/** Sentences the split review ruled must stay loaded (F1, F2, F3, F5, D2). */
const KEPT = [
	"where data matters, authorized representative records, read only, in a safe environment",
	"The user may grant automated merges, written in the plan or in charter slot `software.merge-grant`",
	"A one off chore's agreement can be a line in `CURRENT.md`",
	"mutation wherever the project can run it, scoped to the changed code",
	"The builder stops only for a decision the plan reserves",
	"where the question is one the user reserved, put throwaway prototypes in front of them",
];

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

function counts(texts: string[]): Map<string, number> {
	const tally = new Map<string, number>();
	for (const word of texts.join(" ").split(/\s+/).filter(Boolean))
		tally.set(word, (tally.get(word) ?? 0) + 1);
	return tally;
}

function missing(from: Map<string, number>, in_: Map<string, number>) {
	return [...from].flatMap(([word, n]) =>
		Array(Math.max(0, n - (in_.get(word) ?? 0))).fill(word),
	);
}

describe("software's guide split keeps steps whole and safety rules loaded (O4)", () => {
	test("software declares exactly the build, check and ship guides", () => {
		expect(software?.problems).toEqual([]);
		expect(guideNames).toEqual(["build", "check", "ship"]);
	});

	test("the pointer sits between the cycle preamble and step 1", () => {
		expect(remainder.split(POINTER).length - 1).toBe(1);
		expect(remainder).toContain(
			`keep it current.\n\n${POINTER}\n\n1. **Story straight.**`,
		);
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
		for (const [index, guide] of guides.entries()) {
			for (const marker of [
				...STEPS.map((name) => `**${name}**`),
				"Complete when",
				"The user's part",
			])
				expect({
					guide: guideNames[index],
					marker,
					found: guide.includes(marker),
				}).toEqual({ guide: guideNames[index], marker, found: false });
		}
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
		for (const literal of KEPT) expect(remainder).toContain(literal);
		for (const guide of guides)
			for (const literal of KEPT) expect(guide).not.toContain(literal);
	});
});

/** The fixture paragraph each non-step guide section moves out of. */
const SOURCES: Record<string, string> = {
	"Skills are the delegate's craft": "- **Skills are the delegate's craft.**",
	"Automatic merging": "Broader automatic merging",
	"A task that waits on the user": "Each step ends at its completion criterion",
};

// Lifetime: the tests in this block and __fixtures__/software-body-d2c1fe6.md
// hold the split to d2c1fe6's words. Delete the block and the fixture in the
// first change that edits the user's software text on purpose; the tests
// above stay.
describe("software's guide split moves d2c1fe6's words without rewriting them (O3)", () => {
	const before = readFileSync(
		join(import.meta.dir, "__fixtures__/software-body-d2c1fe6.md"),
		"utf8",
	);

	test("before plus the new text equals the remainder plus the guides, word for word", () => {
		const words = counts([before, ...NEW_TEXT]);
		const after = counts([remainder, ...guides]);
		expect({
			lost: missing(words, after),
			invented: missing(after, words),
		}).toEqual({ lost: [], invented: [] });
	});

	test("each guide sentence comes, in order, from its own part's paragraph", () => {
		const paragraphs = before.split("\n");
		for (const [index, guide] of guides.entries())
			for (const section of guide.split("\n## ").slice(1)) {
				const [heading = "", text = ""] = section.split("\n\n");
				const step = heading.match(/^(\d)\. /)?.[1];
				const start = step ? `${step}. **` : SOURCES[heading];
				const source = paragraphs.filter((p) => start && p.startsWith(start));
				expect({ heading, sources: source.length }).toEqual({
					heading,
					sources: 1,
				});
				let at = 0;
				for (const sentence of text.trim().split(/(?<=[.:])\s+(?=[A-Z`*(])/)) {
					const found = source[0]?.indexOf(sentence, at) ?? -1;
					expect({
						guide: guideNames[index],
						sentence,
						found: found >= 0,
					}).toEqual({ guide: guideNames[index], sentence, found: true });
					at = found + sentence.length;
				}
			}
	});
});
