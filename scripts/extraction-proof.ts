/** Shared, fail-closed filesystem and evidence helpers for PR 5 proofs. */
import { createHash } from "node:crypto";
import {
	chmodSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	symlinkSync,
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

/** The generated stage is trustworthy only while its driving worktree is clean. */
export function committedRevision(repo: string): string {
	const status = checkedRun(
		["git", "status", "--porcelain", "--untracked-files=all"],
		repo,
	);
	assertEqual(status.stdout, "", "committed replay requires a clean worktree");
	return checkedRun(["git", "rev-parse", "HEAD"], repo).stdout.trim();
}

function committedFiles(repo: string, prefix: string) {
	return checkedRun(["git", "ls-tree", "-rz", "HEAD", "--", prefix], repo)
		.stdout.split("\0")
		.filter(Boolean)
		.map((row) => {
			const match = /^(100644|100755|120000) blob ([a-f0-9]+)\t(.+)$/.exec(row);
			if (!match)
				throw new Error(`Unsupported committed package member: ${row}`);
			const mode = match[1] ?? "";
			const oid = match[2] ?? "";
			const path = match[3] ?? "";
			const blob = Bun.spawnSync(["git", "cat-file", "blob", oid], {
				cwd: repo,
			});
			if (blob.exitCode !== 0)
				throw new Error(`Cannot read committed blob ${oid}`);
			return { path: path.slice(prefix.length + 1), mode, bytes: blob.stdout };
		});
}

/** Bind every source path, byte and executable bit to HEAD, including link targets. */
export function assertCommittedPackage(
	repo: string,
	prefix: string,
	target: string,
	installed = false,
): string[] {
	const expected = committedFiles(repo, prefix)
		.map((file) =>
			file.mode === "120000"
				? `${file.path} link ${file.bytes.toString()}`
				: `${file.path} ${file.bytes.length} ${file.mode === "100755" ? "755" : "644"} ${digest(file.bytes)}`,
		)
		.sort();
	const actual = treeManifest(target)
		.filter((row) => !/^\S+\/ [0-7]+$/.test(row))
		.filter(
			(row) =>
				!installed ||
				![".git", "node_modules", "bin"].includes(row.split(/[ /]/)[0] ?? ""),
		)
		.map((row) => {
			if (row.includes(" link ")) return row;
			const match = /^(.*) (\d+) ([0-7]+) ([a-f0-9]+)$/.exec(row);
			if (!match) throw new Error(`Unsupported package member: ${row}`);
			return `${match[1]} ${match[2]} ${Number.parseInt(match[3] ?? "0", 8) & 0o111 ? "755" : "644"} ${match[4]}`;
		})
		.sort();
	assertEqual(
		actual,
		expected,
		"copied package matches committed HEAD bytes and executable bits",
	);
	return expected;
}

/** Never copy uncommitted source bytes into an acceptance candidate. */
export function copyPackage(
	repo: string,
	prefix: string,
	target: string,
): string[] {
	mkdirSync(target, { recursive: true });
	for (const file of committedFiles(repo, prefix)) {
		const path = join(target, file.path);
		mkdirSync(dirname(path), { recursive: true });
		if (file.mode === "120000") symlinkSync(file.bytes.toString(), path);
		else {
			writeFileSync(path, file.bytes);
			chmodSync(path, file.mode === "100755" ? 0o755 : 0o644);
		}
	}
	return assertCommittedPackage(repo, prefix, target);
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

/** Inspect bundled module markers separately from build-time dependency resolution. */
export function bundledVersions(binary: string): {
	zod: string;
	typescript: string | null;
} {
	const bytes = readFileSync(binary);
	const zodAt = bytes.indexOf("zod/v4/core/versions.js");
	const version =
		zodAt < 0
			? null
			: /major:\s*(\d+),\s*minor:\s*(\d+),\s*patch:\s*(\d+)/.exec(
					bytes.subarray(zodAt, zodAt + 600).toString(),
				);
	if (!version) throw new Error(`No bundled Zod version marker in ${binary}`);
	const tsAt = bytes.indexOf("typescript/lib/typescript.js");
	const tsVersion =
		tsAt < 0
			? null
			: /version(?:\w*)\s*=\s*"(\d+\.\d+\.\d+)"/.exec(
					bytes.subarray(tsAt, tsAt + 200000).toString(),
				)?.[1];
	if (tsAt >= 0 && !tsVersion)
		throw new Error(
			`TypeScript is bundled but its version is unreadable: ${binary}`,
		);
	return { zod: version.slice(1, 4).join("."), typescript: tsVersion ?? null };
}
