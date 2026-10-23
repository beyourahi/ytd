import { spawn } from "node:child_process";

export interface CommandResult {
	stdout: string;
	stderr: string;
	code: number;
	timedOut: boolean;
	cancelled: boolean;
	overflow: boolean;
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
