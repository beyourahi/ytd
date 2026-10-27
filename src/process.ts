import { spawn } from "node:child_process";

export interface CommandResult {
	stdout: string;
	stderr: string;
	code: number;
	timedOut: boolean;
	cancelled: boolean;
	overflow: boolean;
}

export interface StreamResult {
	stderr: string;
	code: number;
	timedOut: boolean;
	cancelled: boolean;
	/** A single line exceeded the line ceiling and was dropped instead of buffered. */
	overflow: boolean;
	/** Lines handed to the consumer. */
	lines: number;
}

/**
 * A single pathologically long line must not be able to exhaust memory, so the pending-line
 * buffer is capped. Real listing rows are a few kilobytes.
 */
const MAX_LINE_BYTES = 4 * 1024 * 1024;

/**
 * Run a command and hand its stdout to the caller line by line instead of buffering it.
 *
 * A channel listing can dwarf the buffered capture limit, and `runCommand` kills what it cannot
 * hold — so discovery reads its output as it arrives and commits each batch before the next one
 * is in memory. Cancellation, timeouts and process-group cleanup behave exactly as in
 * `runCommand`; only stdout is discarded from the result because the consumer already saw it.
 */
export async function streamCommand(
	argv: string[],
	options: {
		input?: string;
		cwd?: string;
		env?: NodeJS.ProcessEnv;
		timeoutMs?: number;
		signal?: AbortSignal;
	},
	onLine: (line: string) => void
): Promise<StreamResult> {
	const result: StreamResult = {
		stderr: "",
		code: -1,
		timedOut: false,
		cancelled: false,
		overflow: false,
		lines: 0
	};
	if (options.signal?.aborted) return { ...result, cancelled: true };
	const stderrLimit = 1024 * 1024;
	return new Promise((resolve) => {
		const child = spawn(argv[0], argv.slice(1), {
			cwd: options.cwd,
			env: options.env,
			stdio: ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32"
		});
		let force: ReturnType<typeof setTimeout> | undefined;
		const kill = (signal: NodeJS.Signals) => {
			try {
				if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
				else child.kill(signal);
			} catch {
				/* the owned process may have just exited */
			}
		};
		const stop = () => {
			kill("SIGTERM");
			force ??= setTimeout(() => kill("SIGKILL"), 1000);
		};
		const cancel = () => {
			result.cancelled = true;
			stop();
		};
		const timer = setTimeout(
			() => {
				result.timedOut = true;
				stop();
			},
			options.timeoutMs ?? 15 * 60 * 1000
		);
		options.signal?.addEventListener("abort", cancel, { once: true });
		let pending = "";
		let dropped = false;
		let stderrBytes = 0;
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			pending += chunk;
			let index = pending.indexOf("\n");
			if (index < 0) {
				// No complete line yet: bound what is held, and keep consuming the stream.
				if (pending.length > MAX_LINE_BYTES) {
					pending = "";
					dropped = true;
					result.overflow = true;
				}
				return;
			}
			const lines: string[] = [];
			while (index >= 0) {
				const line = pending.slice(0, index);
				pending = pending.slice(index + 1);
				if (line.length <= MAX_LINE_BYTES) lines.push(line.replace(/\r$/, ""));
				else {
					dropped = true;
					result.overflow = true;
				}
				index = pending.indexOf("\n");
			}
			if (pending.length > MAX_LINE_BYTES) {
				pending = "";
				dropped = true;
				result.overflow = true;
			}
			for (const line of lines) {
				result.lines++;
				try {
					onLine(line);
				} catch (error) {
					// A failing consumer is a real failure of this run, not a child-process problem.
					result.stderr += `\n${error instanceof Error ? error.message : String(error)}`;
					stop();
				}
			}
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderrBytes += Buffer.byteLength(chunk);
			if (stderrBytes <= stderrLimit) result.stderr += chunk;
		});
		child.on("error", (error) => {
			result.stderr = error.message;
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			clearTimeout(force);
			options.signal?.removeEventListener("abort", cancel);
			result.code = code !== null && code >= 0 ? code : -1;
			// A final line without a trailing newline is still a line.
			if (pending.length && !dropped) {
				result.lines++;
				try {
					onLine(pending);
				} catch {
					/* already reported through stop() */
				}
			}
			resolve(result);
		});
		child.stdin.on("error", () => {}); // early harness failure can close stdin first
		child.stdin.end(options.input ?? "");
		if (options.signal?.aborted) cancel();
	});
}

/** Drain both pipes even after their capture limit; stop only our own process group. */
export async function runCommand(
	argv: string[],
	options: {
		input?: string;
		cwd?: string;
		env?: NodeJS.ProcessEnv;
		timeoutMs?: number;
		signal?: AbortSignal;
		maxOutputBytes?: number;
	} = {}
): Promise<CommandResult> {
	const result: CommandResult = {
		stdout: "",
		stderr: "",
		code: -1,
		timedOut: false,
		cancelled: false,
		overflow: false
	};
	if (options.signal?.aborted) return { ...result, cancelled: true };
	const limit = options.maxOutputBytes ?? 32 * 1024 * 1024;
	return new Promise((resolve) => {
		const child = spawn(argv[0], argv.slice(1), {
			cwd: options.cwd,
			env: options.env,
			stdio: ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32"
		});
		let force: ReturnType<typeof setTimeout> | undefined;
		const kill = (signal: NodeJS.Signals) => {
			try {
				if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
				else child.kill(signal);
			} catch {
				/* the owned process may have just exited */
			}
		};
		const stop = () => {
			kill("SIGTERM");
			force ??= setTimeout(() => kill("SIGKILL"), 1000);
		};
		const cancel = () => {
			result.cancelled = true;
			stop();
		};
		const timer = setTimeout(
			() => {
				result.timedOut = true;
				stop();
			},
			options.timeoutMs ?? 15 * 60 * 1000
		);
		options.signal?.addEventListener("abort", cancel, { once: true });
		for (const key of ["stdout", "stderr"] as const) {
			let bytes = 0;
			child[key].setEncoding("utf8");
			child[key].on("data", (data: string) => {
				bytes += Buffer.byteLength(data);
				if (bytes <= limit) result[key] += data;
				else {
					result.overflow = true;
					stop();
				}
			});
		}
		child.on("error", (error) => {
			result.stderr = error.message;
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			clearTimeout(force);
			options.signal?.removeEventListener("abort", cancel);
			result.code = code !== null && code >= 0 ? code : -1;
			resolve(result);
		});
		child.stdin.on("error", () => {}); // early harness failure can close stdin first
		child.stdin.end(options.input ?? "");
		if (options.signal?.aborted) cancel();
	});
}
