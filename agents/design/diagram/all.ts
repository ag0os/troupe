/**
 * Project-wide event flow diagrams into ai/diagrams/.
 *
 * The system prompt lives in `all.md`. This extension computes the diagrams
 * directory, creates it outside preview, builds the task prompt and hands
 * the banners to the runner (D-016, D-019).
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
	PrepareContext,
	PrepareResult,
} from "../../../lib/agent-format/types";

export function prepare(ctx: PrepareContext): PrepareResult {
	// The project to analyze
	const targetProject = ctx.cwd;
	const diagramsDir = join(targetProject, "ai", "diagrams");

	// Ensure the ai/diagrams directory exists; never in preview (D-012)
	let directoryMessage = `✅ Created/verified directory: ${diagramsDir}`;
	if (!ctx.preview) {
		try {
			mkdirSync(diagramsDir, { recursive: true });
		} catch (error) {
			const failure = `Failed to create diagrams directory: ${error}`;
			// Print mode has no banner to carry the failure, so it stops here.
			if (ctx.mode === "print") {
				return { exit: { message: `${failure}\n`, code: 1, stream: "stderr" } };
			}
			directoryMessage = failure;
		}
	}

	// Optional free-form focus filter from args
	const focusArea = ctx.args.join(" ");

	// Build the user prompt
	const userPrompt = `Analyze the codebase at ${targetProject} and generate comprehensive, project-wide event flow diagrams.

Target output directory: ${diagramsDir}

Instructions:
1. Scan the ENTIRE codebase to identify ALL event flows, data flows, and interaction patterns
2. Look for:
   - User interaction flows (click handlers, form submissions, etc.)
   - API request/response flows
   - WebSocket/real-time event flows
   - State management flows (Redux, Zustand, Context, etc.)
   - File system operations and I/O flows
   - Background job/worker flows
   - Authentication/authorization flows
   - Data transformation pipelines
   - Message queue/pub-sub patterns
   - Database query flows
   - Component communication patterns
   - Navigation/routing flows
   - Error handling cascades
   - Lifecycle event flows
   - Custom event emitters

3. For each identified flow, create a markdown file in ${diagramsDir} with:
   - Descriptive filename: {flow-type}-{specific-name}.md (e.g., auth-login-flow.md, api-user-crud-flow.md)
   - Mermaid diagram showing the complete flow
   - Brief description of the flow
   - Key files and functions involved
   - Trigger points and conditions

4. Diagrams should include:
   - All actors/components involved
   - Direction of data flow
   - Decision points and branches
   - Error paths
   - Async operations
   - External service calls
   - State mutations

5. Be EXHAUSTIVE - every possible event flow should have its own diagram

${focusArea ? `\nFocus Area (optional filter): ${focusArea}` : "\nAnalyze ALL flows comprehensively"}

Start by scanning the project structure to understand the architecture, then systematically identify and document every event flow.`;

	// Print mode's stdout is the payload, so the runner refuses banners there.
	if (ctx.mode === "print") return { initialPrompt: userPrompt };
	return {
		initialPrompt: userPrompt,
		beforeRunMessages: [
			directoryMessage,
			"🔍 Starting project-wide diagram generation...",
			`📁 Target project: ${targetProject}`,
			`📊 Diagrams will be saved to: ${diagramsDir}`,
		],
		afterRunMessages: [
			"\n✨ Event flow diagram generation complete!",
			`📁 Diagrams saved to: ${diagramsDir}`,
		],
	};
}
