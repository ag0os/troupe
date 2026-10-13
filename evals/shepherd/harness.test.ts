import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { EVALS_DIR } from "./run";

/**
 * The Python self-checks that need no compiled Shepherd, model or fixture
 * clock. Checks that build real fixtures run under
 * `bun run evals:shepherd --check` instead.
 */
describe("Python harness self-checks on handmade data (8.4)", () => {
	test("check-harness.py passes without a scratch-compiled subject", () => {
		const child = Bun.spawnSync(
			["python3", "-I", join(EVALS_DIR, "check-harness.py")],
			{ cwd: EVALS_DIR, stdout: "pipe", stderr: "pipe", timeout: 120_000 },
		);
		const output = `${child.stdout.toString()}${child.stderr.toString()}`;
		if (child.exitCode !== 0) console.error(output);
		expect(child.exitCode).toBe(0);
		expect(output).toMatch(/\nOK/);
		// The handmade checks ran; only subject-dependent ones were skipped.
		expect(output).toMatch(/Ran \d{2,} tests/);
		expect(output).toMatch(/skipped=4\)/);
	}, 120_000);

	test("shell wrappers pass a syntax check", () => {
		for (const name of ["run-trial.sh", "fixtures.sh"]) {
			const child = Bun.spawnSync(["bash", "-n", join(EVALS_DIR, name)]);
			expect(child.exitCode).toBe(0);
		}
	});
});
