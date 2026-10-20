// contract diff: the Contract changes between head and its merge base with
// base, read from committed trees and blobs only. A report with no policy:
// it lints neither snapshot and attaches no patch.
import {
	type ContractDoc,
	type Obligation,
	type ProductSection,
	parseContract,
	parseProduct,
} from "./parse";
import { CONTRACTS_DIR, git, PRODUCT, README, ToolError } from "./repo";

type Place = { file: string; line: number };

export type Change = {
	kind: string;
	file: string;
	component?: string;
	section?: string;
	obligationId?: string;
	before: Place | null;
	after: Place | null;
	fields?: Record<string, { before: unknown; after: unknown }>;
	obligationKind?: string;
	rewordedLine?: { present: boolean; new: boolean };
};

type Snapshot = {
	docs: Map<string, ContractDoc>;
	sections: ProductSection[];
};

const LIMITS =
	"PRODUCT.md sections are compared by name and ID only; a section moved to a Contract file shows as a removal and an addition";

function resolve(top: string, which: "base" | "head", ref: string): string {
	const result = git(top, [
		"rev-parse",
		"--verify",
		"--quiet",
		"--end-of-options",
		`${ref}^{commit}`,
	]);
	if (!result.ok)
		throw new ToolError("ref-missing", `${which} not found: ${ref}`);
	return result.stdout.trim();
}

function snapshot(top: string, commit: string, label: string): Snapshot {
	const tree = git(top, [
		"ls-tree",
		"-r",
		"-z",
		"--full-tree",
		commit,
		"--",
		CONTRACTS_DIR,
		PRODUCT,
	]);
	if (!tree.ok)
		throw new ToolError(
			"object-missing",
			`git could not read the tree of ${label} ${commit.slice(0, 12)}`,
		);
	const docs = new Map<string, ContractDoc>();
	let sections: ProductSection[] = [];
	for (const entry of tree.stdout.split("\0")) {
		if (!entry) continue;
		const [meta = "", path = ""] = entry.split("\t");
		const [mode, type, oid = ""] = meta.split(" ");
		const contract =
			path.startsWith(`${CONTRACTS_DIR}/`) &&
			path.split("/").length === 3 &&
			path.endsWith(".md") &&
			path !== README;
		if (type !== "blob" || mode === "120000" || !(contract || path === PRODUCT))
			continue;
		const blob = git(top, ["cat-file", "blob", oid]);
		if (!blob.ok)
			throw new ToolError(
				"object-missing",
				`${path} at ${label}: object ${oid.slice(0, 12)} is not available locally`,
			);
		if (path === PRODUCT) sections = parseProduct(blob.stdout);
		else {
			const doc = parseContract(blob.stdout);
			const ambiguity = ambiguous(doc);
			if (ambiguity)
				throw new ToolError(
					"ambiguous",
					`${path}:${ambiguity.line} at ${label}: ${ambiguity.message}`,
				);
			docs.set(path, doc);
		}
	}
	return { docs, sections };
}

/** What keeps a snapshot from comparing reliably: bad metadata or a reused identity. */
function ambiguous(doc: ContractDoc): { line: number; message: string } | null {
	if (doc.yamlError)
		return {
			line: doc.yamlError.line,
			message: `unsupported front matter: ${doc.yamlError.message}`,
		};
	const seen = new Map<string, Obligation>();
	for (const o of doc.obligations) {
		const key = `${o.prefix}-${o.number}`;
		const earlier = seen.get(key);
		if (earlier)
			return {
				line: o.line,
				message: `${o.id} has the identity of ${earlier.id} at line ${earlier.line}`,
			};
		seen.set(key, o);
	}
	return null;
}

const normalize = (text: string | null) =>
	text === null ? null : text.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "");

function fieldsOf(o: Obligation) {
	return {
		id: o.id,
		title: normalize(o.title),
		statement: normalize(o.statement),
		reason: normalize(o.reason),
		kind: o.kind,
		proof: normalize(o.proof?.text ?? null),
		retired: o.retired,
	};
}

function metadataOf(doc: ContractDoc) {
	const out: Record<string, unknown> = { format: doc.format };
	for (const [key, field] of doc.fields ?? []) out[key] = field.value;
	return out;
}

function compareFile(
	file: string,
	before: ContractDoc | undefined,
	after: ContractDoc | undefined,
): Change[] {
	const component = file.slice(CONTRACTS_DIR.length + 1, -3);
	const at = (doc: ContractDoc | undefined, line: number) =>
		doc ? { file, line } : null;
	const changes: Change[] = [];
	if (!before || !after)
		changes.push({
			kind: before ? "component-removed" : "component-added",
			file,
			component,
			before: at(before, 1),
			after: at(after, 1),
		});
	if (before && after) {
		const fields: Change["fields"] = {};
		const a = metadataOf(before);
		const b = metadataOf(after);
		for (const key of new Set([...Object.keys(a), ...Object.keys(b)]))
			if (JSON.stringify(a[key]) !== JSON.stringify(b[key]))
				fields[key] = { before: a[key] ?? null, after: b[key] ?? null };
		if (Object.keys(fields).length)
			changes.push({
				kind: "metadata-changed",
				file,
				component,
				before: at(before, 1),
				after: at(after, 1),
				fields,
			});
		const lineOf = (doc: ContractDoc) =>
			doc.coverage.problem === "missing" ? null : doc.coverage;
		const ca = lineOf(before);
		const cb = lineOf(after);
		if ((ca?.text ?? null) !== (cb?.text ?? null))
			changes.push({
				kind: "coverage-line-changed",
				file,
				component,
				before: ca ? { file, line: ca.line } : null,
				after: cb ? { file, line: cb.line } : null,
				fields: {
					coverage: { before: ca?.text ?? null, after: cb?.text ?? null },
				},
			});
	}
	const key = (o: Obligation) => `${o.prefix}-${o.number}`;
	const olds = new Map((before?.obligations ?? []).map((o) => [key(o), o]));
	const news = new Map((after?.obligations ?? []).map((o) => [key(o), o]));
	for (const id of new Set([...olds.keys(), ...news.keys()])) {
		const o = olds.get(id);
		const n = news.get(id);
		const base = { file, component, obligationId: (n ?? o)?.id };
		if (!o && n) {
			changes.push({
				...base,
				kind: "obligation-added",
				before: null,
				after: { file, line: n.line },
				obligationKind: n.kind ?? "unknown",
			});
			continue;
		}
		if (o && !n) {
			changes.push({
				...base,
				kind: "obligation-removed",
				before: { file, line: o.line },
				after: null,
			});
			continue;
		}
		if (!o || !n) continue;
		const fa = fieldsOf(o);
		const fb = fieldsOf(n);
		const fields: NonNullable<Change["fields"]> = {};
		for (const k of Object.keys(fa) as (keyof typeof fa)[])
			if (JSON.stringify(fa[k]) !== JSON.stringify(fb[k]))
				fields[k] = { before: fa[k], after: fb[k] };
		if (Object.keys(fields).length === 0) continue;
		const reworded = "title" in fields || "statement" in fields;
		const kind =
			o.retired && !n.retired
				? "obligation-reactivated"
				: !o.retired && n.retired
					? "obligation-retired"
					: reworded
						? "obligation-reworded"
						: "obligation-changed";
		changes.push({
			...base,
			kind,
			before: { file, line: o.line },
			after: { file, line: n.line },
			fields,
			...(kind === "obligation-reworded"
				? {
						obligationKind: n.kind ?? "unknown",
						rewordedLine: {
							present: n.reworded.length > 0,
							new: n.reworded.some((line) => !o.reworded.includes(line)),
						},
					}
				: {}),
		});
	}
	return changes;
}

function compareProduct(
	before: ProductSection[],
	after: ProductSection[],
): Change[] {
	const changes: Change[] = [];
	const olds = new Map(before.map((s) => [s.name, s]));
	const news = new Map(after.map((s) => [s.name, s]));
	const place = (line: number) => ({ file: PRODUCT, line });
	for (const name of new Set([...olds.keys(), ...news.keys()])) {
		const o = olds.get(name);
		const n = news.get(name);
		if (!o || !n) {
			changes.push({
				kind: o ? "product-section-removed" : "product-section-added",
				file: PRODUCT,
				section: name,
				before: o ? place(o.line) : null,
				after: n ? place(n.line) : null,
			});
			continue;
		}
		const oldIds = new Map(o.ids.map((i) => [i.id, i.line]));
		const newIds = new Map(n.ids.map((i) => [i.id, i.line]));
		for (const [id, line] of oldIds)
			if (!newIds.has(id))
				changes.push({
					kind: "product-id-removed",
					file: PRODUCT,
					section: name,
					obligationId: id,
					before: place(line),
					after: null,
				});
		for (const [id, line] of newIds)
			if (!oldIds.has(id))
				changes.push({
					kind: "product-id-added",
					file: PRODUCT,
					section: name,
					obligationId: id,
					before: null,
					after: place(line),
				});
	}
	return changes;
}

function rank(c: Change): number {
	if (c.file === PRODUCT) return (c.after ?? c.before)?.line ?? 0;
	if (!c.obligationId) return -1;
	return Number(/-(\d+)$/.exec(c.obligationId)?.[1] ?? 0);
}

export function diff(
	top: string,
	requestedBase: string | undefined,
	requestedHead: string | undefined,
) {
	const baseRef =
		requestedBase ??
		(git(top, ["rev-parse", "--verify", "--quiet", "origin/HEAD^{commit}"]).ok
			? "origin/HEAD"
			: "main");
	const headRef = requestedHead ?? "HEAD";
	const base = resolve(top, "base", baseRef);
	const head = resolve(top, "head", headRef);
	const merge = git(top, ["merge-base", "--all", base, head]);
	const bases = merge.stdout.split("\n").filter(Boolean);
	if (bases.length === 0)
		throw new ToolError(
			"unrelated-histories",
			`${baseRef} and ${headRef} share no history`,
		);
	if (bases.length > 1)
		throw new ToolError(
			"multiple-merge-bases",
			`${baseRef} and ${headRef} have ${bases.length} merge bases: ${bases.map((b) => b.slice(0, 12)).join(", ")}`,
		);
	const mergeBase = bases[0] as string;
	const before = snapshot(top, mergeBase, "the merge base");
	const after = snapshot(top, head, "head");
	const files = [...new Set([...before.docs.keys(), ...after.docs.keys()])];
	const changes = [
		...compareProduct(before.sections, after.sections),
		...files.flatMap((f) =>
			compareFile(f, before.docs.get(f), after.docs.get(f)),
		),
	].sort((a, b) =>
		a.file === b.file ? rank(a) - rank(b) : a.file < b.file ? -1 : 1,
	);
	const text = [
		`diff: base ${baseRef} ${base.slice(0, 12)}, head ${headRef} ${head.slice(0, 12)}, merge base ${mergeBase.slice(0, 12)}`,
		...changes.map((c) => {
			const what = c.obligationId ?? (c.section ? `"${c.section}"` : "");
			const fields = Object.keys(c.fields ?? {});
			return `${c.kind} ${c.file}${what ? ` ${what}` : ""}${fields.length ? `: ${fields.join(", ")}` : ""}`;
		}),
	]
		.map((l) => `${l}\n`)
		.join("");
	return {
		result: {
			base: { requested: baseRef, commit: base },
			head: { requested: headRef, commit: head },
			mergeBase,
			changes,
			limits: LIMITS,
			complete: true,
		},
		text,
	};
}
