import { mkdirSync } from "node:fs";
import { RUN_DIR } from "./config.ts";

export interface ClaudeResult {
	ok: boolean;
	text?: string;
	limited?: boolean; // hit the Max-plan usage window — pause and resume later
	error?: string;
}

/**
 * Run a single-turn, tool-free `claude -p` on Opus and return the text result. Bills
 * Rahi's Claude Max subscription (not the API). `--output-format json` emits an ARRAY
 * of events; the answer is the element with type === "result".
 *
 * Runs from a neutral cwd so it never inherits a project/palace CLAUDE.md that would
 * bias the distillation.
 */
export async function claudePrompt(prompt: string): Promise<ClaudeResult> {
	mkdirSync(RUN_DIR, { recursive: true });

	const proc = Bun.spawn(
		[
			"claude",
			"-p",
			"--model",
			"opus",
			"--output-format",
			"json",
			"--max-turns",
			"1",
			"--allowedTools",
			"" // pure text transform — no tools, no side effects
		],
		{ cwd: RUN_DIR, stdin: "pipe", stdout: "pipe", stderr: "pipe" }
	);
	proc.stdin.write(prompt);
	proc.stdin.end();

	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const code = await proc.exited;

	const blob = (stdout + stderr).toLowerCase();
	if (
		/usage limit|rate limit|limit reached|exceeded your|too many requests|5-hour limit/.test(blob)
	) {
		return { ok: false, limited: true, error: "Claude usage limit reached" };
	}
	if (!stdout.trim()) {
		return { ok: false, error: stderr.trim() || `claude exited ${code}` };
	}

	try {
		const parsed = JSON.parse(stdout);
		const arr = Array.isArray(parsed) ? parsed : [parsed];
		const result = arr.find((x) => x?.type === "result") ?? arr.at(-1);
		if (!result) return { ok: false, error: "no result block in claude output" };
		if (result.is_error) {
			return { ok: false, error: String(result.subtype ?? result.result ?? "claude error") };
		}
		return { ok: true, text: String(result.result ?? "") };
	} catch (e) {
		return { ok: false, error: `could not parse claude output: ${(e as Error).message}` };
	}
}
