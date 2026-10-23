import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PALACE_DIR } from "../src/config.ts";

const syncScript =
	process.env.YTD_TEST_PALACE_SYNC ?? join(PALACE_DIR, "scripts", "mind-palace-sync");
export const hasPalacePrerequisite =
	existsSync(syncScript) && readFileSync(syncScript, "utf8").includes("--require-unchanged-base");

export function fixtureGit(cwd: string, ...args: string[]): string {
	const p = Bun.spawnSync(["git", "-C", cwd, ...args], {
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "ytd fixture",
			GIT_AUTHOR_EMAIL: "ytd@example.invalid",
			GIT_COMMITTER_NAME: "ytd fixture",
			GIT_COMMITTER_EMAIL: "ytd@example.invalid"
		}
	});
	if (p.exitCode !== 0) throw new Error(p.stderr.toString());
	return p.stdout.toString().trimEnd();
}

export function createPalaceFixture(options: { root?: string; source?: string } = {}) {
	const root = options.root ?? mkdtempSync(join(tmpdir(), "ytd-palace-test-"));
	const remote = join(root, "remote.git");
	const source = options.source ?? join(root, "source");
	mkdirSync(source, { recursive: true });
	fixtureGit(root, "init", "--bare", remote);
	fixtureGit(remote, "symbolic-ref", "HEAD", "refs/heads/main");
	fixtureGit(source, "init", "-b", "main");
	mkdirSync(join(source, "scripts"));
	copyFileSync(syncScript, join(source, "scripts", "mind-palace-sync"));
	chmodSync(join(source, "scripts", "mind-palace-sync"), 0o755);
	mkdirSync(join(source, ".githooks"));
	for (const hook of ["pre-commit", "pre-push", "post-commit"]) {
		const original = join(PALACE_DIR, ".githooks", hook);
		copyFileSync(original, join(source, ".githooks", hook));
		chmodSync(join(source, ".githooks", hook), 0o755);
	}
	mkdirSync(join(source, "content"));
	mkdirSync(join(source, "unrelated-room"));
	writeFileSync(
		join(source, "content", "field-notes.md"),
		'# Existing\n- **[M7]** "Earlier" — Creator · YouTube `aaaaaaaaaaa` · logged 2026-01-01\n'
	);
	writeFileSync(join(source, "unrelated-room", "field-notes.md"), "# Existing [M52]\n");
	fixtureGit(source, "add", ".");
	fixtureGit(source, "commit", "-m", "test: seed isolated palace");
	fixtureGit(source, "remote", "add", "origin", remote);
	fixtureGit(source, "push", "origin", "main");
	return {
		root,
		source,
		remote,
		options: {
			palaceDir: source,
			syncRoot: join(root, "transactions"),
			lockRoot: join(root, "locks"),
			runDir: join(root, "run")
		}
	};
}
