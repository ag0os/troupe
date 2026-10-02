/**
 * Consolidates the diagrams under ai/diagrams/ by topic.
 *
 * The system prompt lives in `consolidate.md`. This extension computes the
 * diagrams directory, creates it outside preview, builds the task prompt and
 * hands the banners to the runner (D-016, D-019).
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
	PrepareContext,
	PrepareResult,
} from "../../../lib/agent-format/types";

export function prepare(ctx: PrepareContext): PrepareResult {
	const targetProject = ctx.cwd;
	const diagramsRoot = join(targetProject, "ai", "diagrams");
	const consolidatedDir = diagramsRoot;

	// Optional scope filters provided as free-form positionals
	const filters = ctx.args.join(" ");

	// Ensure consolidated directory exists; never in preview (D-012)
	let directoryMessage = `✅ Created/verified directory: ${consolidatedDir}`;
	if (!ctx.preview) {
		try {
			mkdirSync(consolidatedDir, { recursive: true });
		} catch (error) {
			const failure = `Failed to create consolidated directory: ${error}`;
			// Print mode has no banner to carry the failure, so it stops here.
			if (ctx.mode === "print") {
				return { exit: { message: `${failure}\n`, code: 1, stream: "stderr" } };
			}
			directoryMessage = failure;
		}
	}

	const userPrompt = `Consolidate and optimize all diagram markdown files found under: ${diagramsRoot}

Goals:
1) Verify: Check that each diagram plausibly reflects the referenced code paths and components (based on file/function references and patterns). Flag any questionable items in a short note inline.
2) Deduplicate: Identify near-duplicates or overlapping flows and merge them.
3) Grouping: Cluster by topic/theme and produce one consolidated markdown per topic under: ${consolidatedDir}
4) Cleanup: Normalize naming, remove redundancy, and streamline diagrams while preserving completeness and correctness.

Scope filters: ${filters || "(none)"}

Instructions:
- Read all diagram files under ${diagramsRoot} (no subdirectories required).
- Derive topics from filename prefixes before the first dash (e.g., "auth-login-flow.md" => topic "auth"). If no clear prefix, infer topic heuristically.
- For each topic, produce a single consolidated file in ${consolidatedDir}: {topic}-consolidated.md
- Within each consolidated file, include:
  - A refined, comprehensive Mermaid diagram (or multiple sections if needed)
  - A brief overview of included subflows
  - Key components and their roles
  - Noted assumptions or verification concerns
- Create an index file at ${consolidatedDir}/diagrams-index.md listing topics, file counts, and short summaries.

Verification heuristics:
- Ensure nodes and edges match named files/functions/types mentioned in the flow descriptions
- Confirm external calls and state mutations are plausible given the stack
- If a diagram lacks clear anchors to the codebase, mark it for review

Output only the final consolidated markdown files in ${consolidatedDir} plus the index.`;

	// Print mode's stdout is the payload, so the runner refuses banners there.
	if (ctx.mode === "print") return { initialPrompt: userPrompt };
	return {
		initialPrompt: userPrompt,
		beforeRunMessages: [
			directoryMessage,
			"🧹 Starting diagram consolidation...",
			`📁 Diagrams root: ${diagramsRoot}`,
			`📦 Consolidated output: ${consolidatedDir}`,
		],
		afterRunMessages: [
			"\n✨ Consolidation complete!",
			`📁 Consolidated diagrams saved to: ${consolidatedDir}`,
		],
	};
}
