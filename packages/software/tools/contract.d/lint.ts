// Analysis for lint, coverage and map: discovery, parsing and validation of
// the Contract index in the worktree.
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
	type ContractDoc,
	type Obligation,
	type ProductSection,
	parseContract,
	parseProduct,
	pointerPrefix,
	pointers,
} from "./parse";
import {
	CONTRACTS_DIR,
	contractFiles,
	git,
	isDirectory,
	PRODUCT,
	README,
	readText,
	ToolError,
} from "./repo";

export type Finding = {
	code: string;
	severity: "error" | "warning";
	file: string;
	line?: number;
	obligationId?: string;
	message: string;
};

const WARNINGS = new Set([
	"dependency-missing",
	"directory-nested",
	"covers-unmatched",
	"mixed-proof",
	"legacy-format",
	"legacy-proof-unclassified",
	"contracts-absent",
	"coverage-incomplete",
]);

/** Codes a legacy file reports as warnings: the gaps migration fills. */
const LEGACY_GAPS = new Set([
	"coverage-missing",
	"coverage-format",
	"coverage-position",
	"statement-missing",
	"reason-missing",
	"kind-invalid",
	"decisions-missing",
	"decision-entry-invalid",
	"decision-unlisted",
	"decision-target-missing",
]);

const SLUG = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const FIELDS = ["component", "covers", "depends_on", "tests"] as const;

export type Category =
	| "test"
	| "prEvidence"
	| "mixed"
	| "unproved"
	| "unclassified";

export type CheckedObligation = Obligation & { category: Category | null };

export type Metadata = {
	covers: string[];
	depends_on: string[];
	tests: string[];
};

/** A path a component's covers name or match, and whether it is a directory. */
export type Claim = {
	path: string;
	directory: boolean;
	pattern: string;
	line?: number;
};

export type Counts = {
	obligations: number;
	test: number;
	prEvidence: number;
	mixed: number;
	unproved: number;
	retired: number;
	unclassified: number;
};

export type FileReport = {
	file: string;
	format: "canonical" | "legacy-file";
	component: string;
	doc: ContractDoc;
	metadata: Metadata | null;
	claims: Claim[];
	obligations: CheckedObligation[];
	computed: Counts;
	/** The coverage sentence the counts give, when they and the suite target are known. */
	computedLine: string | null;
	complete: boolean;
};

function count(obligations: CheckedObligation[]): Counts {
	const c: Counts = {
		obligations: 0,
		test: 0,
		prEvidence: 0,
		mixed: 0,
		unproved: 0,
		retired: 0,
		unclassified: 0,
	};
	for (const o of obligations) {
		if (o.retired || o.retiredProblem) c.retired++;
		else {
			c.obligations++;
			c[o.category ?? "unproved"]++;
		}
	}
	return c;
}

const TARGET =
	/Suite runs against (this implementation|any implementation behind \S.*?)\.\s*$/;

function sentence(c: Counts, target: string): string {
	return `Coverage: ${c.obligations} obligations; ${c.test} proved by test, ${c.prEvidence} by PR evidence, ${c.mixed} mixed, ${c.unproved} unproved. Suite runs against ${target}.`;
}

/** Compare the claimed coverage line with the computed counts. */
function checkCoverage(report: FileReport, add: Add) {
	const coverage = report.doc.coverage;
	const c = report.computed;
	if (coverage.problem === "missing") return;
	const claimed = coverage.claimed;
	const target = TARGET.exec(coverage.text)?.[1];
	if (report.complete && c.unclassified === 0 && target)
		report.computedLine = sentence(c, target);
	if (!claimed) return;
	const numbers = (x: Omit<Counts, "retired" | "unclassified">) =>
		[x.obligations, x.test, x.prEvidence, x.mixed, x.unproved] as const;
	const drift =
		c.unclassified === 0
			? numbers(claimed).some((n, i) => n !== numbers(c)[i])
			: claimed.obligations !== c.obligations;
	if (drift)
		add(
			"coverage-drift",
			`the coverage line claims ${claimed.obligations} obligations, ${claimed.test} by test, ${claimed.prEvidence} by PR evidence, ${claimed.mixed} mixed, ${claimed.unproved} unproved; computed ${numbers(c).join(", ")}`,
			coverage.line,
		);
	if (c.unclassified > 0)
		add(
			"coverage-incomplete",
			`${c.unclassified} obligations have unclassified proof, so only the obligation count is compared`,
			coverage.line,
		);
}

export type Conflict = {
	kind: "duplicate" | "nested";
	path: string;
	other: string;
	components: string[];
};

export type Analysis = {
	files: FileReport[];
	sections: ProductSection[];
	selected: Set<string>;
	findings: Finding[];
	conflicts: Conflict[];
	result: { files: unknown[]; complete: boolean };
};

/** What the worktree holds, for glob matching: files, directories, boundaries. */
type Inventory = { files: string[]; dirs: string[]; boundaries: string[] };

function inventory(top: string): Inventory {
	const tracked = git(top, ["ls-files", "-z", "-s", "--full-name"]);
	const untracked = git(top, [
		"ls-files",
		"-z",
		"-o",
		"--exclude-standard",
		"--full-name",
	]);
	if (!tracked.ok || !untracked.ok)
		throw new ToolError("git", "git could not list the worktree's files");
	const files: string[] = [];
	const boundaries: string[] = [];
	for (const entry of tracked.stdout.split("\0")) {
		if (!entry) continue;
		const path = entry.slice(entry.indexOf("\t") + 1);
		if (entry.startsWith("160000 ")) boundaries.push(path);
		else files.push(path);
	}
	for (const path of untracked.stdout.split("\0")) {
		if (!path) continue;
		if (path.endsWith("/")) boundaries.push(path.slice(0, -1));
		else files.push(path);
	}
	const dirs = new Set<string>();
	for (const f of files) {
		const parts = f.split("/");
		for (let i = 1; i < parts.length; i++)
			dirs.add(parts.slice(0, i).join("/"));
	}
	return {
		files: [...new Set(files)].sort(),
		dirs: [...dirs].sort(),
		boundaries,
	};
}

type PathCheck =
	| { ok: true; kind: "file" | "dir" | "missing"; path: string }
	| { ok: false; code: "path-invalid" | "path-symlink"; message: string };

/** A root-relative path, checked without following symlinks or entering submodules. */
function checkPath(
	top: string,
	raw: string,
	boundaries: string[] = [],
): PathCheck {
	if (raw === "" || raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw))
		return {
			ok: false,
			code: "path-invalid",
			message: `${raw || "an empty path"} is not root-relative`,
		};
	const segments = raw.split("/").filter((s) => s !== "" && s !== ".");
	if (segments.includes(".."))
		return {
			ok: false,
			code: "path-invalid",
			message: `${raw} leaves the repository root`,
		};
	const path = segments.join("/");
	for (const b of boundaries)
		if (path === b || path.startsWith(`${b}/`))
			return {
				ok: false,
				code: "path-invalid",
				message: `${raw} is inside a submodule`,
			};
	let current = top;
	for (const [i, segment] of segments.entries()) {
		current = join(current, segment);
		const stat = lstatSync(current, { throwIfNoEntry: false });
		if (!stat) return { ok: true, kind: "missing", path };
		if (stat.isSymbolicLink())
			return {
				ok: false,
				code: "path-symlink",
				message: `${raw} goes through a symlink`,
			};
		if (stat.isDirectory() && existsSync(join(current, ".git")))
			return {
				ok: false,
				code: "path-invalid",
				message: `${raw} is inside a submodule or nested repository`,
			};
		if (i === segments.length - 1)
			return {
				ok: true,
				kind: stat.isDirectory() ? "dir" : stat.isFile() ? "file" : "missing",
				path,
			};
	}
	return { ok: true, kind: "dir", path };
}

const GLOB = /[*?[]/;

function globRegex(pattern: string): RegExp {
	let out = "";
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i] as string;
		if (ch === "*" && pattern[i + 1] === "*") {
			const slash = pattern[i + 2] === "/";
			out += slash ? "(?:.*/)?" : ".*";
			i += slash ? 2 : 1;
		} else if (ch === "*") out += "[^/]*";
		else if (ch === "?") out += "[^/]";
		else if (ch === "[") {
			const end = pattern.indexOf("]", i + 2);
			if (end < 0) out += "\\[";
			else {
				let cls = pattern.slice(i + 1, end);
				if (cls.startsWith("!")) cls = `^${cls.slice(1)}`;
				out += `[${cls.replace(/\\/g, "\\\\")}]`;
				i = end;
			}
		} else out += ch.replace(/[.+^${}()|\\]/g, "\\$&");
	}
	return new RegExp(`^${out}$`);
}

function refusedPattern(pattern: string): string | null {
	if (pattern.startsWith("!")) return "negation";
	if (/[{}]/.test(pattern)) return "brace expansion";
	if (/[?*+@!]\(/.test(pattern)) return "an extglob";
	return null;
}

function finding(
	file: string,
	code: string,
	message: string,
	line?: number,
	obligationId?: string,
	legacy = false,
): Finding {
	const severity =
		WARNINGS.has(code) || (legacy && LEGACY_GAPS.has(code))
			? "warning"
			: "error";
	return {
		code,
		severity,
		file,
		...(line ? { line } : {}),
		...(obligationId ? { obligationId } : {}),
		message,
	};
}

type Context = {
	top: string;
	inventory: () => Inventory;
	components: Set<string>;
	prefixes: Set<string>;
};

type Add = (code: string, message: string, line?: number) => void;

function categorize(
	o: Obligation,
	legacy: boolean,
	check: (path: string, line: number) => boolean,
	add: Add,
): Category {
	const proof = o.proof;
	const standardized = proof?.clauses.some((c) => c.type !== null) ?? false;
	if (legacy && !standardized) {
		for (const path of [
			...(proof?.clauses.flatMap((c) => c.paths) ?? []),
			...(o.test?.clauses[0]?.paths ?? []),
		])
			check(path, proof?.line ?? o.line);
		add(
			"legacy-proof-unclassified",
			`${o.id} has no standardized Kind and Proof line; its proof is unclassified`,
			o.line,
		);
		return "unclassified";
	}
	if (!proof) {
		add("proof-invalid", `${o.id} has no Proof`, o.kindLine ?? o.line);
		return "unproved";
	}
	const types = new Set(proof.clauses.map((c) => c.type));
	const invalid = (message: string) => {
		add("proof-invalid", `${o.id}: ${message}`, proof.line);
		return "unproved" as const;
	};
	if (proof.clauses.length === 0)
		return invalid("Proof names test, pr-evidence or none");
	if (types.has(null))
		return invalid("each proof clause starts with test, pr-evidence or none");
	if (types.has("none") && types.size > 1)
		return invalid("none is not mixed with another proof");
	if (types.has("none")) return "unproved";
	const test = o.test?.clauses[0];
	for (const c of proof.clauses) {
		if (c.type === "test") {
			const paths = [...c.paths, ...(test?.paths ?? [])];
			const refs = [
				...c.names,
				...c.ids,
				...(test?.names ?? []),
				...(test?.ids ?? []),
			];
			if (paths.length === 0)
				return invalid("a test proof names its file in backticks");
			if (refs.length === 0)
				return invalid("a test proof names its test or obligation ID");
		} else if (
			c.prs.some((n) => n < 1) ||
			(c.prs.length === 0 && c.paths.length === 0)
		)
			return invalid(
				"PR evidence names #<number> or a record path in backticks",
			);
	}
	const paths = new Set([
		...proof.clauses.flatMap((c) => c.paths),
		...(types.has("test") ? (test?.paths ?? []) : []),
	]);
	let ok = true;
	for (const path of paths) if (!check(path, proof.line)) ok = false;
	if (types.has("test") && types.has("pr-evidence")) {
		add(
			"mixed-proof",
			`${o.id} is proved partly by test and partly by PR evidence; split it when next touched`,
			proof.line,
		);
		return ok ? "mixed" : "unproved";
	}
	if (!ok) return "unproved";
	return types.has("test") ? "test" : "prEvidence";
}

function checkObligations(
	doc: ContractDoc,
	legacy: boolean,
	ctx: Context,
	add: (code: string, message: string, line?: number, id?: string) => void,
): CheckedObligation[] {
	const out: CheckedObligation[] = [];
	const seen = new Map<number, Obligation>();
	const prefix = doc.obligations[0]?.prefix;
	const check = (path: string, line: number) => {
		const result = checkPath(ctx.top, path, ctx.inventory().boundaries);
		if (!result.ok) add(result.code, result.message, line);
		else if (result.kind !== "file")
			add("proof-file-missing", `${path} is not a file`, line);
		return result.ok && result.kind === "file";
	};
	for (const o of doc.obligations) {
		const one: Add = (code, message, line) => add(code, message, line, o.id);
		const earlier = o.prefix === prefix ? seen.get(o.number) : undefined;
		if (earlier)
			one(
				"obligation-id-duplicate",
				`${o.id} has the identity of ${earlier.id} at line ${earlier.line}`,
				o.line,
			);
		else if (o.prefix === prefix) seen.set(o.number, o);
		if (o.prefix !== prefix)
			one(
				"obligation-prefix",
				`${o.id}: this component's prefix is ${prefix}`,
				o.line,
			);
		const checked: CheckedObligation = { ...o, category: null };
		out.push(checked);
		if (o.retiredProblem || o.retired) {
			if (o.retiredProblem)
				one("retired-invalid", `${o.id}: ${o.retiredProblem}`, o.line);
			else if (o.proof)
				one(
					"retired-invalid",
					`${o.id} is retired and carries no Proof`,
					o.line,
				);
			continue;
		}
		if (!o.statement)
			one("statement-missing", `${o.id} has no statement`, o.line);
		if (o.reason === null)
			one("reason-missing", `${o.id} has no reason`, o.line);
		const standardized = o.proof?.clauses.some((c) => c.type) ?? false;
		if (
			o.kind !== null &&
			o.kind !== "functional" &&
			o.kind !== "non-functional"
		)
			one(
				"kind-invalid",
				`${o.id}: Kind is functional or non-functional, not ${o.kind}`,
				o.kindLine ?? o.line,
			);
		else if (o.kind === null && !(legacy && !standardized))
			one("kind-invalid", `${o.id} has no Kind`, o.line);
		checked.category = categorize(o, legacy, check, one);
	}
	return out;
}

function checkDecisions(
	doc: ContractDoc,
	ctx: Context,
	add: (code: string, message: string, line?: number, id?: string) => void,
) {
	const listed = new Set((doc.decisions?.entries ?? []).map((e) => e.id));
	let missingReported = false;
	for (const o of doc.obligations) {
		if (o.reason === null || o.retired) continue;
		const line = o.reasonLine ?? o.line;
		for (const token of pointers(o.reason)) {
			if (ctx.prefixes.has(pointerPrefix(token)) || listed.has(token)) continue;
			if (doc.decisions)
				add(
					"decision-unlisted",
					`${token} is not listed in ## Decisions`,
					line,
					o.id,
				);
			else if (!missingReported) {
				add(
					"decisions-missing",
					`${o.id} points to ${token}; the file closes with a ## Decisions section listing each pointer`,
					line,
					o.id,
				);
				missingReported = true;
			}
		}
	}
	if (!doc.decisions) return;
	if (!doc.decisions.closing)
		add(
			"decision-entry-invalid",
			"the ## Decisions section closes the file",
			doc.decisions.line,
		);
	for (const bad of doc.decisions.invalid)
		add(
			"decision-entry-invalid",
			`a Decisions entry reads - <ID>, \`<path>\`: <title>, not ${bad.text}`,
			bad.line,
		);
	for (const entry of doc.decisions.entries) {
		const result = checkPath(ctx.top, entry.path, ctx.inventory().boundaries);
		if (!result.ok) add(result.code, result.message, entry.line);
		else if (result.kind !== "file")
			add(
				"decision-target-missing",
				`${entry.id}'s record ${entry.path} does not exist`,
				entry.line,
			);
	}
}

function checkFile(
	file: string,
	doc: ContractDoc,
	ctx: Context,
	findings: Finding[],
): FileReport {
	const legacy = doc.format === "legacy-file";
	const add = (code: string, message: string, line?: number, id?: string) =>
		findings.push(finding(file, code, message, line, id, legacy));
	const stem = file.slice(CONTRACTS_DIR.length + 1, -3);
	const report: FileReport = {
		file,
		format: doc.format,
		component: stem,
		doc,
		metadata: null,
		claims: [],
		obligations: [],
		computed: count([]),
		computedLine: null,
		complete: false,
	};
	if (!SLUG.test(stem))
		add(
			"contract-path",
			`${stem} is not a component slug (lowercase letters, digits and single underscores)`,
		);
	if (doc.yamlError)
		add(
			"frontmatter-yaml",
			`unsupported front matter: ${doc.yamlError.message}`,
			doc.yamlError.line,
		);
	if (!doc.bodyParsed) return report;
	if (legacy)
		add(
			"legacy-format",
			"a legacy Contract with no front matter; migrate it when the component is next touched",
			1,
		);
	else if (doc.frontMatter === "absent")
		add(
			"frontmatter-missing",
			"a Contract file opens with its front matter",
			1,
		);
	if (doc.fields) report.metadata = checkFields(doc, stem, ctx, add, report);

	const coverage = doc.coverage;
	if (coverage.problem === "missing")
		add("coverage-missing", "the first body line is the coverage line");
	else if (coverage.problem === "position")
		add(
			"coverage-position",
			"the coverage line is the first line of the body",
			coverage.line,
		);
	if (coverage.problem !== "missing" && !coverage.claimed)
		add(
			"coverage-format",
			`the coverage line does not read as counts: ${coverage.text}`,
			coverage.line,
		);

	for (const p of doc.problems) add(p.code, p.message, p.line, p.obligationId);
	report.obligations = checkObligations(doc, legacy, ctx, add);
	checkDecisions(doc, ctx, add);
	report.complete = !legacy && report.metadata !== null;
	report.computed = count(report.obligations);
	checkCoverage(report, add);
	return report;
}

function checkFields(
	doc: ContractDoc,
	stem: string,
	ctx: Context,
	add: Add,
	report: FileReport,
): Metadata | null {
	const fields = doc.fields as NonNullable<ContractDoc["fields"]>;
	let ok = true;
	const refuse = (message: string, line: number) => {
		add("frontmatter-fields", message, line);
		ok = false;
	};
	for (const [key, field] of fields)
		if (!(FIELDS as readonly string[]).includes(key))
			refuse(`unknown front matter key: ${key}`, field.line);
	for (const key of FIELDS) {
		const field = fields.get(key);
		if (!field) refuse(`missing front matter key: ${key}`, 1);
		else if (key === "component") {
			if (typeof field.value !== "string" || field.value === "")
				refuse("component is one slug", field.line);
			else if (!SLUG.test(field.value))
				add(
					"component-name",
					`${field.value} is not a component slug`,
					field.line,
				);
			else if (field.value !== stem)
				add(
					"component-name",
					`component ${field.value} does not match the file name ${stem}`,
					field.line,
				);
		} else if (!Array.isArray(field.value))
			refuse(`${key} is a list of strings`, field.line);
	}
	if (!ok) return null;
	const list = (key: string) =>
		fields.get(key) as { value: string[]; line: number; lines: number[] };
	const lineOf = (key: string, i: number) =>
		list(key).lines[i] ?? list(key).line;
	const meta: Metadata = {
		covers: list("covers").value,
		depends_on: list("depends_on").value,
		tests: list("tests").value,
	};
	const inv = ctx.inventory();
	meta.tests.forEach((path, i) => {
		const result = checkPath(ctx.top, path, inv.boundaries);
		if (!result.ok) add(result.code, result.message, lineOf("tests", i));
		else if (result.kind === "missing")
			add("tests-missing", `${path} does not exist`, lineOf("tests", i));
	});
	meta.covers.forEach((pattern, i) => {
		const line = lineOf("covers", i);
		const claims = coverClaims(ctx.top, inv, pattern);
		if ("code" in claims) add(claims.code, claims.message, line);
		else report.claims.push(...claims.map((c) => ({ ...c, line })));
	});
	meta.depends_on.forEach((slug, i) => {
		if (!SLUG.test(slug))
			add(
				"frontmatter-fields",
				`depends_on names ${slug}, which is not a component slug`,
				lineOf("depends_on", i),
			);
		else if (!ctx.components.has(slug))
			add(
				"dependency-missing",
				`depends on ${slug}, which has no Contract file`,
				lineOf("depends_on", i),
			);
	});
	return meta;
}

/** The paths one covers pattern claims, or the finding it earns. */
function coverClaims(
	top: string,
	inv: Inventory,
	pattern: string,
): Claim[] | { code: string; message: string } {
	const refused = refusedPattern(pattern);
	if (refused)
		return {
			code: "path-invalid",
			message: `${pattern} uses ${refused}; covers take positive globs`,
		};
	const literal = !GLOB.test(pattern);
	const base = checkPath(
		top,
		literal ? pattern : pattern.replace(/[^/]*[*?[].*$/, ""),
		inv.boundaries,
	);
	if (!base.ok && (literal || base.code === "path-invalid")) return base;
	if (literal) {
		if (!base.ok) return base;
		if (base.kind === "missing")
			return {
				code: "covers-unmatched",
				message: `${pattern} matches nothing`,
			};
		return [{ path: base.path, directory: base.kind === "dir", pattern }];
	}
	const dirOnly = pattern.endsWith("/");
	const regex = globRegex(pattern.replace(/\/+$/, ""));
	const matches = [
		...(dirOnly ? [] : inv.files.map((path) => ({ path, directory: false }))),
		...inv.dirs.map((path) => ({ path, directory: true })),
	].filter((m) => regex.test(m.path));
	if (matches.length === 0)
		return { code: "covers-unmatched", message: `${pattern} matches nothing` };
	for (const m of matches) {
		const result = checkPath(top, m.path, inv.boundaries);
		if (!result.ok)
			return {
				code: result.code,
				message: `${pattern} matches ${result.message}`,
			};
	}
	return matches.map((m) => ({ ...m, pattern }));
}

/** Resolve explicit file arguments against the caller's directory. */
function select(
	top: string,
	cwd: string,
	args: string[],
	index: Set<string>,
): Set<string> {
	const base = realpathSync(cwd);
	const out = new Set<string>();
	for (const arg of args) {
		const rel = relative(top, resolve(base, arg)).split("\\").join("/");
		if (rel.startsWith("..") || rel === "")
			throw new ToolError("usage", `${arg} is outside the repository`);
		const candidate =
			rel === PRODUCT ||
			(rel.startsWith(`${CONTRACTS_DIR}/`) &&
				rel.endsWith(".md") &&
				rel !== README);
		if (!candidate)
			throw new ToolError(
				"usage",
				`${arg} is not a Contract file under ${CONTRACTS_DIR}/ or ${PRODUCT}`,
			);
		if (!index.has(rel)) throw new ToolError("usage", `${arg} does not exist`);
		out.add(rel);
	}
	return out;
}

export function analyze(top: string, cwd: string, args: string[]): Analysis {
	const files = contractFiles(top);
	const productText = readText(top, PRODUCT);
	const sections = productText === undefined ? [] : parseProduct(productText);
	const index = new Set(files);
	if (productText !== undefined) index.add(PRODUCT);
	const selected = args.length ? select(top, cwd, args, index) : new Set(index);
	const all: Finding[] = [];
	if (!isDirectory(top, CONTRACTS_DIR) && sections.length === 0)
		all.push(
			finding(
				CONTRACTS_DIR,
				"contracts-absent",
				"no docs/contracts/ and no PRODUCT.md Contract sections",
			),
		);

	const docs = new Map<string, ContractDoc>();
	const prefixes = new Set<string>();
	for (const file of files) {
		const stat = lstatSync(join(top, file));
		if (file.split("/").length !== 3)
			all.push(
				finding(
					file,
					"contract-path",
					"a Contract file sits directly in docs/contracts/",
				),
			);
		else if (stat.isSymbolicLink() || !stat.isFile())
			all.push(
				finding(
					file,
					"contract-path",
					"a Contract file is a regular file, not a symlink",
				),
			);
		else {
			const doc = parseContract(readText(top, file) as string);
			docs.set(file, doc);
			for (const o of doc.obligations) prefixes.add(o.prefix);
		}
	}
	for (const s of sections)
		for (const { id } of s.ids) prefixes.add(id.replace(/-\d+$/, ""));
	let cached: Inventory | null = null;
	const ctx: Context = {
		top,
		inventory: () => {
			cached ??= inventory(top);
			return cached;
		},
		components: new Set(
			[...docs.keys()].map((f) => f.slice(CONTRACTS_DIR.length + 1, -3)),
		),
		prefixes,
	};
	const reports = [...docs].map(([file, doc]) =>
		checkFile(file, doc, ctx, all),
	);
	for (const s of sections)
		all.push(
			finding(
				PRODUCT,
				"legacy-format",
				`section "${s.name}" is not yet a Contract file; it is read by name and ID only, and its proof coverage is unknown`,
				s.line,
			),
		);
	all.push(...sharedPrefixes(reports, sections));
	const conflicts = directoryConflicts(reports);
	for (const c of conflicts) all.push(...c.findings);

	const findings = all.filter(
		(f) => selected.has(f.file) || (f.file === CONTRACTS_DIR && !args.length),
	);
	const resultFiles = [
		...(productText !== undefined && selected.has(PRODUCT)
			? [
					{
						file: PRODUCT,
						format: "product",
						sections: sections.map((s) => ({
							name: s.name,
							line: s.line,
							ids: s.ids.map((i) => i.id),
						})),
						complete: false,
					},
				]
			: []),
		...reports.filter((r) => selected.has(r.file)).map(fileResult),
	].sort((a, b) => (a.file < b.file ? -1 : 1));
	const complete =
		reports.length > 0 &&
		sections.length === 0 &&
		docs.size === files.length &&
		reports.every((r) => r.complete);
	return {
		files: reports,
		sections,
		selected,
		findings,
		conflicts: conflicts.map(({ findings: _, ...c }) => c),
		result: { files: resultFiles, complete },
	};
}

/** Directories two components both claim, or one claims inside another's. */
function directoryConflicts(
	reports: FileReport[],
): (Conflict & { findings: Finding[] })[] {
	const out = new Map<string, Conflict & { findings: Finding[] }>();
	const dirs = reports.map((r) => ({
		r,
		claims: r.claims
			.filter((c) => c.directory)
			.map((c) => ({ ...c, path: c.path.replace(/\/+$/, "") })),
	}));
	const sorted = [...dirs].sort((a, b) =>
		a.r.component < b.r.component ? -1 : 1,
	);
	for (const [i, a] of sorted.entries())
		for (const b of sorted.slice(i + 1))
			for (const ca of a.claims)
				for (const cb of b.claims) {
					const nested = (x: string, y: string) => y.startsWith(`${x}/`);
					let conflict: Conflict | null = null;
					let lines: [typeof ca, typeof cb] = [ca, cb];
					if (ca.path === cb.path)
						conflict = {
							kind: "duplicate",
							path: ca.path,
							other: cb.path,
							components: [a.r.component, b.r.component],
						};
					else if (nested(ca.path, cb.path))
						conflict = {
							kind: "nested",
							path: ca.path,
							other: cb.path,
							components: [a.r.component, b.r.component],
						};
					else if (nested(cb.path, ca.path)) {
						conflict = {
							kind: "nested",
							path: cb.path,
							other: ca.path,
							components: [b.r.component, a.r.component],
						};
						lines = [cb, ca];
					}
					if (!conflict) continue;
					const key = `${conflict.kind} ${conflict.path} ${conflict.other} ${conflict.components.join(" ")}`;
					if (out.has(key)) continue;
					const [outer, inner] = conflict.components;
					const fileOf = (component: string | undefined) =>
						(reports.find((r) => r.component === component) as FileReport).file;
					const code =
						conflict.kind === "duplicate"
							? "directory-duplicate"
							: "directory-nested";
					out.set(key, {
						...conflict,
						findings: [
							finding(
								fileOf(outer),
								code,
								conflict.kind === "duplicate"
									? `${conflict.path} is also claimed by ${inner}`
									: `${conflict.path} contains ${conflict.other}, claimed by ${inner}`,
								lines[0].line,
							),
							finding(
								fileOf(inner),
								code,
								conflict.kind === "duplicate"
									? `${conflict.path} is also claimed by ${outer}`
									: `${conflict.other} is inside ${conflict.path}, claimed by ${outer}`,
								lines[1].line,
							),
						],
					});
				}
	return [...out.values()];
}

function sharedPrefixes(
	reports: FileReport[],
	sections: ProductSection[],
): Finding[] {
	const users = new Map<string, Map<string, boolean>>();
	const use = (prefix: string, file: string, legacy: boolean) => {
		const files = users.get(prefix) ?? new Map<string, boolean>();
		files.set(file, (files.get(file) ?? false) || legacy);
		users.set(prefix, files);
	};
	for (const r of reports)
		for (const o of r.obligations)
			use(o.prefix, r.file, r.format !== "canonical");
	for (const s of sections)
		for (const { id } of s.ids) use(id.replace(/-\d+$/, ""), PRODUCT, true);
	const out: Finding[] = [];
	for (const [prefix, files] of users) {
		const list = [...files].sort(([a], [b]) => (a < b ? -1 : 1));
		for (const [i, [a, legacyA]] of list.entries())
			for (const [b, legacyB] of list.slice(i + 1)) {
				const severity = legacyA || legacyB ? "warning" : "error";
				for (const [file, other] of [
					[a, b],
					[b, a],
				])
					out.push({
						code: "prefix-shared",
						severity,
						file: file as string,
						message: `prefix ${prefix} is also used by ${other}`,
					});
			}
	}
	return out;
}

function fileResult(r: FileReport) {
	const coverage = r.doc.coverage;
	return {
		file: r.file,
		format: r.format,
		component: r.component,
		metadata: r.metadata,
		coverage:
			coverage.problem === "missing"
				? null
				: {
						line: coverage.line,
						text: coverage.text,
						claimed: coverage.claimed,
					},
		obligations: r.obligations.map((o) => ({
			id: o.id,
			line: o.line,
			title: o.title,
			statement: o.statement,
			reason: o.reason,
			kind: o.kind,
			proof: o.proof ? { text: o.proof.text, clauses: o.proof.clauses } : null,
			test: o.test ? { text: o.test.text } : null,
			category: o.retired ? "retired" : o.category,
			...(o.retired ? { retired: o.retired } : {}),
			reworded: o.reworded,
		})),
		complete: r.complete,
	};
}
