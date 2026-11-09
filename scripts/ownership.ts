/**
 * The phase 2 ownership inventory (design.md section 8, obligation O19):
 * every Shepherd and compatibility location still in Troupe, by exact path
 * or named tree. Generic framework code outside it imports nothing inside
 * it; the wrappers hand Shepherd policy to the compiler only through
 * `BuildStampPolicy`. `scripts/ownership.test.ts` enforces this. From PR 4
 * the list also names the extracted package tree and the transitional
 * extraction verification code; phase 3 deletes what it names.
 */

/** Legacy command and re-export wrappers. */
export const WRAPPERS = [
	"scripts/agent-compiler.ts",
	"scripts/binary-name.ts",
	"scripts/compile-all.ts",
	"scripts/compile.ts",
	"scripts/shepherd-definition.ts",
	"scripts/watch-agents.ts",
] as const;

/** Shepherd source policy: the v1 adapter, v2 membership and the v1 test fixture. */
export const POLICIES = [
	"scripts/shepherd-source-fixture.ts",
	"scripts/shepherd-source-v2.ts",
	"scripts/shepherd-source.ts",
] as const;

/** The Shepherd agent and its tests. */
export const AGENT_FILES = [
	"agents/shepherd-module-matrix.test.ts",
	"agents/shepherd.md",
	"agents/shepherd.test.ts",
	"agents/shepherd.ts",
] as const;

/** Fixture and snapshot files of the Shepherd agent tests, enumerated. */
export const AGENT_FIXTURES = [
	"agents/__fixtures__/shepherd-module-matrix/builtin-bodies/herdr.md.txt",
	"agents/__fixtures__/shepherd-module-matrix/builtin-bodies/integrations-shared.md.txt",
	"agents/__fixtures__/shepherd-module-matrix/builtin-bodies/inter-agent.md.txt",
	"agents/__fixtures__/shepherd-module-matrix/builtin-bodies/nested.md.txt",
	"agents/__fixtures__/shepherd-module-matrix/builtin-bodies/root.md.txt",
	"agents/__fixtures__/shepherd-module-matrix/builtin-bodies/software-guides/build.md.txt",
	"agents/__fixtures__/shepherd-module-matrix/builtin-bodies/software-guides/check.md.txt",
	"agents/__fixtures__/shepherd-module-matrix/builtin-bodies/software-guides/ship.md.txt",
	"agents/__fixtures__/shepherd-module-matrix/builtin-bodies/software.md.txt",
	"agents/__fixtures__/shepherd-module-matrix/nested-0.root-0.software-0.claude.prompt.txt",
	"agents/__fixtures__/shepherd-module-matrix/nested-0.root-0.software-0.codex.prompt.txt",
	"agents/__fixtures__/shepherd-module-matrix/nested-0.root-0.software-1.claude.prompt.txt",
	"agents/__fixtures__/shepherd-module-matrix/nested-0.root-0.software-1.codex.prompt.txt",
	"agents/__fixtures__/shepherd-module-matrix/nested-0.root-1.software-0.claude.prompt.txt",
	"agents/__fixtures__/shepherd-module-matrix/nested-0.root-1.software-0.codex.prompt.txt",
	"agents/__fixtures__/shepherd-module-matrix/nested-0.root-1.software-1.claude.prompt.txt",
	"agents/__fixtures__/shepherd-module-matrix/nested-0.root-1.software-1.codex.prompt.txt",
	"agents/__fixtures__/shepherd-module-matrix/nested-1.root-0.software-0.claude.prompt.txt",
	"agents/__fixtures__/shepherd-module-matrix/nested-1.root-0.software-0.codex.prompt.txt",
	"agents/__fixtures__/shepherd-module-matrix/nested-1.root-0.software-1.claude.prompt.txt",
	"agents/__fixtures__/shepherd-module-matrix/nested-1.root-0.software-1.codex.prompt.txt",
	"agents/__fixtures__/shepherd-module-matrix/nested-1.root-1.software-0.claude.prompt.txt",
	"agents/__fixtures__/shepherd-module-matrix/nested-1.root-1.software-0.codex.prompt.txt",
	"agents/__fixtures__/shepherd-module-matrix/nested-1.root-1.software-1.claude.prompt.txt",
	"agents/__fixtures__/shepherd-module-matrix/nested-1.root-1.software-1.codex.prompt.txt",
	"agents/__fixtures__/shepherd-module-matrix/no-enclosing.claude.prompt.txt",
	"agents/__fixtures__/shepherd-module-matrix/no-enclosing.codex.prompt.txt",
	"agents/__fixtures__/shepherd/enclosing-with-space.claude.prompt.txt",
	"agents/__fixtures__/shepherd/enclosing-with-space.codex.prompt.txt",
	"agents/__fixtures__/shepherd/enclosing-with-space.settings.txt",
	"agents/__fixtures__/shepherd/nearest-parent.claude.prompt.txt",
	"agents/__fixtures__/shepherd/nearest-parent.codex.prompt.txt",
	"agents/__fixtures__/shepherd/nearest-parent.settings.txt",
	"agents/__fixtures__/shepherd/nested-inherited.claude.prompt.txt",
	"agents/__fixtures__/shepherd/nested-inherited.codex.prompt.txt",
	"agents/__fixtures__/shepherd/nested-inherited.settings.txt",
	"agents/__fixtures__/shepherd/nested-local.claude.prompt.txt",
	"agents/__fixtures__/shepherd/nested-local.codex.prompt.txt",
	"agents/__fixtures__/shepherd/nested-local.settings.txt",
	"agents/__fixtures__/shepherd/nested-symlink-dedupe.claude.prompt.txt",
	"agents/__fixtures__/shepherd/nested-symlink-dedupe.codex.prompt.txt",
	"agents/__fixtures__/shepherd/nested-symlink-dedupe.settings.txt",
	"agents/__fixtures__/shepherd/plain.claude.prompt.txt",
	"agents/__fixtures__/shepherd/plain.codex.prompt.txt",
	"agents/__fixtures__/shepherd/plain.settings.txt",
	"agents/__fixtures__/shepherd/uninitiated.claude.prompt.txt",
	"agents/__fixtures__/shepherd/uninitiated.codex.prompt.txt",
	"agents/__fixtures__/shepherd/uninitiated.settings.txt",
	"agents/__fixtures__/shepherd/workspaces.json",
	"agents/__snapshots__/shepherd.test.ts.snap",
] as const;

/**
 * Transitional verification code for the extraction: continuity evidence,
 * setup of the extracted package, its gate proof and its copy check, with
 * their tests. Phase 3 retires them with the original layout.
 */
export const TRANSITIONAL = [
	"scripts/check-extraction-commits.ts",
	"scripts/check-extraction-gates.test.ts",
	"scripts/check-extraction-gates.ts",
	"scripts/compare-extraction-slice.ts",
	"scripts/extraction-continuity.test.ts",
	"scripts/extraction-continuity.ts",
	"scripts/extraction-proof.ts",
	"scripts/extraction-proof.test.ts",
	"scripts/prove-shepherd-parity.ts",
	"scripts/prove-extraction-harness.ts",
	"scripts/replay-extraction-outside.ts",
	"scripts/setup-extractions.test.ts",
	"scripts/setup-extractions.ts",
	"scripts/shepherd-copy.test.ts",
] as const;

/** Trees owned whole. */
export const OWNED_TREES = [
	"evals/shepherd/",
	"extractions/shepherd/",
	"lib/shepherd/",
	"packages/software/",
	"system-prompts/shepherd/",
] as const;

/**
 * Shepherd documentation. The extracted package owns these from PR 4; each
 * root copy carries one transitional line naming its package location.
 */
export const DOCUMENTS = [
	"docs/PACKAGES.md",
	"docs/SETUP.md",
	"docs/SHEPHERD-EVALS.md",
	"docs/SHEPHERD.md",
] as const;

/**
 * Tests that verify compatibility wrappers or legacy policy, classified
 * beside what they verify. Each may import into the inventory.
 */
export const COMPATIBILITY_TESTS: Readonly<Record<string, string>> = {
	"scripts/agent-compiler-publish.test.ts":
		"publication through the legacy wrappers, including the real roster (C2)",
	"scripts/agent-compiler-stamp.test.ts":
		"the v1 Shepherd stamp through the legacy wrappers and legacyStampPolicy",
	"scripts/agent-compiler.test.ts":
		"the legacy wrappers' call shapes and repository defaults",
	"scripts/shepherd-source.test.ts": "the v1 source adapter",
	"scripts/shepherd-source-v2.test.ts": "v2 Shepherd membership",
	"scripts/source-layout.test.ts":
		"explicit Git root and prefix for v1 source and evaluation identity",
	"lib/agent-format/legacy-closure.test.ts":
		"the O31 guard: the compiler and generated entry closure inside v1 membership",
	"agents/design/diagram-audit.test.ts":
		"a legacy-roster agent built through the repository wrappers",
	"agents/git-review.test.ts":
		"a legacy-roster agent built through the repository wrappers",
	"agents/ordinary.test.ts":
		"legacy-roster agents built through the repository wrappers",
	"agents/tools/webfetch.test.ts":
		"a legacy-roster agent built through the repository wrappers",
	"agents/tutors/coach.test.ts":
		"a legacy-roster agent built through the repository wrappers",
};

const EXACT = new Set<string>([
	...WRAPPERS,
	...POLICIES,
	...AGENT_FILES,
	...AGENT_FIXTURES,
	...DOCUMENTS,
	...TRANSITIONAL,
]);

/** Whether a repository-relative path is in the ownership inventory. */
export function isOwned(path: string): boolean {
	return EXACT.has(path) || OWNED_TREES.some((tree) => path.startsWith(tree));
}

/** Whether a file outside the inventory may import into it. */
export function mayImportOwned(path: string): boolean {
	return isOwned(path) || Object.hasOwn(COMPATIBILITY_TESTS, path);
}
