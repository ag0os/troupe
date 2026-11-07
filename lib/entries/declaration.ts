/** `troupe/declaration`: read and materialize Markdown agent declarations. */
export {
	AgentSourceError,
	formatIssue,
	type SourceIssue,
} from "../agent-format/errors";
export {
	type IncludeText,
	materializeAgentSpec,
	type ParsedAgent,
	PROMPT_SEPARATOR,
	parseAgentMarkdown,
} from "../agent-format/schema";
