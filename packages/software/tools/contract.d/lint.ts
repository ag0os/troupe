// Analysis for lint, coverage and map: discovery, parsing and validation of
// the Contract index in the worktree.
import {
	CONTRACTS_DIR,
	contractFiles,
	isDirectory,
	PRODUCT,
	readText,
} from "./repo";

export type Finding = {
	code: string;
	severity: "error" | "warning";
	file: string;
	line?: number;
	obligationId?: string;
	message: string;
};

export function analyze(top: string, _cwd: string, _files: string[]) {
	const findings: Finding[] = [];
	const files = contractFiles(top);
	const product = readText(top, PRODUCT);
	const hasSections = product !== undefined && /^## Contract:/m.test(product);
	if (!isDirectory(top, CONTRACTS_DIR) && !hasSections)
		findings.push({
			code: "contracts-absent",
			severity: "warning",
			file: CONTRACTS_DIR,
			message: "no docs/contracts/ and no PRODUCT.md Contract sections",
		});
	return { findings, result: { files, complete: false } };
}
