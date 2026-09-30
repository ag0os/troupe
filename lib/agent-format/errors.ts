export interface SourceIssue {
	file: string;
	/** 1-based line in `file`, when the offending text can be located. */
	line?: number;
	/** Dotted field path, e.g. `flags.focus.default`, or `frontmatter`/`body`. */
	field: string;
	message: string;
}

export function formatIssue(issue: SourceIssue): string {
	const location = issue.line ? `${issue.file}:${issue.line}` : issue.file;
	return `${location}: ${issue.field}: ${issue.message}`;
}

export class AgentSourceError extends Error {
	readonly issues: readonly SourceIssue[];

	constructor(issues: SourceIssue[]) {
		super(issues.map(formatIssue).join("\n"));
		this.name = "AgentSourceError";
		this.issues = issues;
	}
}
