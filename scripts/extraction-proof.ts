/** Shared, fail-closed filesystem and evidence helpers for PR 5 proofs. */
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { childEnv, type Ran, run } from "./extraction-continuity";
import { isWithin } from "./path-within";

export const digest = (bytes: string | Uint8Array): string =>
	createHash("sha256").update(bytes).digest("hex");

/** Sorted manifest binds file bytes, modes, directories and link targets. Never follows links. */
export function treeManifest(root: string): string[] {
	const rows: string[] = [];
	function walk(dir: string): void {
		for (const name of readdirSync(dir).sort()) {
			const file = join(dir, name);
			const path = relative(root, file);
			const stat = lstatSync(file);
			const mode = (stat.mode & 0o777).toString(8);
			if (stat.isSymbolicLink())
				rows.push(`${path} link ${readlinkSync(file)}`);
			else if (stat.isDirectory()) {
				rows.push(`${path}/ ${mode}`);
				walk(file);
			} else if (stat.isFile())
				rows.push(`${path} ${stat.size} ${mode} ${digest(readFileSync(file))}`);
			else throw new Error(`nonregular proof input: ${file}`);
		}
	}
	walk(root);
	return rows;
}

export function assertEqual(
	actual: unknown,
	expected: unknown,
	label: string,
): void {
	if (JSON.stringify(actual) !== JSON.stringify(expected))
		throw new Error(
			`${label} differs:\nactual ${JSON.stringify(actual)}\nexpected ${JSON.stringify(expected)}`,
		);
}

/** No Git, workspace or node_modules ancestor may contribute to a replay. */
export function assertOutside(parent: string, checkout: string): string[] {
	const dir = realpathSync(parent);
	if (
		isWithin(realpathSync(checkout), dir) ||
		isWithin(join(homedir(), "shepherds"), dir)
	)
		throw new Error(`not outside: ${dir}`);
	const ancestors: string[] = [];
	for (let at = dir; ; at = dirname(at)) {
		ancestors.push(at);
		for (const name of [".git", ".shepherd", "node_modules"]) {
			if (existsSync(join(at, name)))
				throw new Error(`prohibited ancestor ${join(at, name)}`);
		}
		if (at === dirname(at)) break;
	}
	if (run(["git", "rev-parse", "--git-dir"], dir).code === 0)
		throw new Error(`inside Git: ${dir}`);
	return ancestors;
}

export function copyArtifact(source: string, target: string): string[] {
	const before = treeManifest(source);
	cpSync(source, target, { recursive: true, preserveTimestamps: true });
	assertEqual(treeManifest(target), before, "copied artifact bytes and modes");
	assertEqual(treeManifest(source), before, "source artifact remained stable");
	return before;
}

/** Preserve package sources, not generated installations, outputs or Git metadata. */
export function copyPackage(source: string, target: string): void {
	cpSync(source, target, {
		recursive: true,
		preserveTimestamps: true,
		filter: (path) =>
			!["node_modules", "bin", ".git"].includes(
				relative(source, path).split("/")[0] ?? "",
			),
	});
}

/** Raw observation only. Paths and clocks are never rewritten. */
export function sameObservation(a: Ran, b: Ran): boolean {
	return a.code === b.code && a.stdout === b.stdout && a.stderr === b.stderr;
}

/** Persist raw byte streams separately from the annotated command record. */
export function saveRun(evidence: string, name: string, result: Ran): void {
	mkdirSync(evidence, { recursive: true });
	writeFileSync(join(evidence, `${name}.stdout`), result.stdout);
	writeFileSync(join(evidence, `${name}.stderr`), result.stderr);
	writeFileSync(
		join(evidence, `${name}.json`),
		`${JSON.stringify({ bun: Bun.version, ...result }, null, 2)}\n`,
	);
}

export function proofArgs(argv: string[]): Record<string, string> {
	const args: Record<string, string> = {};
	for (let i = 0; i < argv.length; i += 2) {
		const flag = argv[i];
		const value = argv[i + 1];
		if (!flag?.startsWith("--") || value === undefined)
			throw new Error("Expected --name value pairs");
		args[flag.slice(2)] = value;
	}
	return args;
}

/** Deny checkout reads in every outside consumer process, including spawned compilers. */
export function checkoutDenial(checkout: string): string[] {
	if (process.platform !== "darwin")
		throw new Error("This proof's checkout denial requires macOS sandbox-exec");
	return [
		"/usr/bin/sandbox-exec",
		"-p",
		`(version 1)(allow default)(deny file-read* (subpath ${JSON.stringify(realpathSync(checkout))}))`,
	];
}

export function checkedRun(argv: string[], cwd: string, env = childEnv()): Ran {
	const result = run(argv, cwd, env);
	if (result.code !== 0)
		throw new Error(
			`${argv.join(" ")} exit ${result.code}\n${result.stdout}${result.stderr}`,
		);
	return result;
}
