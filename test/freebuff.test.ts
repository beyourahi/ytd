import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentPrompt, discoverModels, preflight, type AgentProfile } from "../src/agents.ts";
import { agentJson } from "../src/distill.ts";
import { catalogNote, FREEBUFF, launchGuide, markedJob } from "../src/freebuff.ts";
import {
	loadSettings,
	parseArgs,
	profileFromArgs,
	resolveCli,
	type Picker
} from "../src/settings.ts";

const saved = { ...FREEBUFF };
const oldPath = process.env.PATH;
let root = "";
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "ytd-freebuff-"));
	Object.assign(FREEBUFF, { dir: join(root, "exchange"), pollMs: 10, settleMs: 400 });
	// A fake launcher proves ytd never executes Freebuff: running it leaves a marker.
	const bin = join(root, "bin");
	Bun.spawnSync(["mkdir", "-p", bin]);
	writeFileSync(
		join(bin, "freebuff"),
		`#!/bin/sh\necho ran > ${JSON.stringify(join(root, "executed"))}\n`
	);
	chmodSync(join(bin, "freebuff"), 0o755);
	process.env.PATH = `${bin}:${oldPath}`;
});
afterEach(() => {
	Object.assign(FREEBUFF, saved);
	process.env.PATH = oldPath;
	rmSync(root, { recursive: true, force: true });
});

const deepseek: AgentProfile = {
	agent: "freebuff",
	model: "deepseek-v4.1-flash-10-17",
	effort: "high"
};

/** Mock Freebuff session: answers each pending job file the way the instructions ask. */
/** What a session that read the whole job writes: the proof line, then the answer. */
const proof = (job: string) =>
	`ytd-proof: ${[...job.matchAll(/^\[\[ytd-check (\w+)\]\]$/gm)].map((m) => m[1]).join(" ")}\n`;
const proved = (dir: string, id: string, text: string) =>
	writeFileSync(
		join(dir, "responses", `${id}.txt`),
		proof(readFileSync(join(dir, "jobs", `${id}.prompt.txt`), "utf8")) + text
	);

function worker(
	dir: string,
	answer: (prompt: string, note?: string) => { file?: string; text: string; delayMs?: number }
) {
	let running = true;
	const seen: string[] = [];
	const done = (async () => {
		while (running) {
			for (const name of existsSync(join(dir, "jobs")) ? readdirSync(join(dir, "jobs")) : []) {
				if (!name.endsWith(".prompt.txt")) continue;
				const id = name.slice(0, -".prompt.txt".length);
				const responses = join(dir, "responses");
				if (
					existsSync(join(responses, `${id}.txt`)) ||
					existsSync(join(responses, `${id}.error.txt`))
				)
					continue;
				let prompt: string;
				try {
					prompt = readFileSync(join(dir, "jobs", name), "utf8");
				} catch {
					continue;
				}
				const notePath = join(dir, "jobs", `${id}.note.txt`);
				const reply = answer(
					prompt,
					existsSync(notePath) ? readFileSync(notePath, "utf8") : undefined
				);
				seen.push(id);
				const target = join(responses, reply.file ?? `${id}.txt`);
				const text = proof(prompt) + reply.text;
				if (reply.delayMs) {
					// A slow, partial write must not be imported before it settles.
					writeFileSync(target, text.slice(0, 5));
					await Bun.sleep(reply.delayMs);
				}
				writeFileSync(target, text);
			}
			await Bun.sleep(5);
		}
	})();
	return {
		seen,
		async stop() {
			running = false;
			await done;
		}
	};
}

test("catalog lists DeepSeek V4.1 Flash 10/17 as advertised, never account-confirmed", async () => {
	const models = await discoverModels("freebuff");
	expect(models.find((m) => m.id === "deepseek-v4.1-flash-10-17")).toMatchObject({
		label: "DeepSeek V4.1 Flash 10/17",
		variants: ["low", "high", "max"],
		contextTokens: 131072
	});
	expect(models.find((m) => m.id === "mimo-v2.6-flash-fast")?.variants).toEqual([]);
	expect(models.find((m) => m.id === "gemini-3.8-flash")?.hint).toContain("paid plan");
	expect(models.every((m) => !/(^|; )available|confirmed/i.test(m.hint ?? ""))).toBe(true);
	expect(catalogNote("0.2.34")).toContain("Access is confirmed only in Freebuff");
	expect(catalogNote("0.3.0")).toContain("installed 0.3.0, list may be outdated");
});

test("preflight prepares a private job folder without running Freebuff", async () => {
	const selected = await preflight(deepseek);
	expect(selected.routing).toMatchObject({ protocol: "freebuff-handoff" });
	const dir = selected.routing!.workspace!;
	expect(dir.startsWith(FREEBUFF.dir)).toBe(true);
	expect(readFileSync(join(dir, "INSTRUCTIONS.md"), "utf8")).toContain(
		"Keep DeepSeek V4.1 Flash 10/17 selected with high effort"
	);
	expect(existsSync(join(root, "executed"))).toBe(false);
	const guide = launchGuide(deepseek.model, deepseek.effort, dir).join("\n");
	expect(guide).toContain(`freebuff --cwd ${dir}`);
	expect(guide).toContain("Send: Follow INSTRUCTIONS.md");
	expect(guide).toContain("Freebuff's own tools are not restricted by ytd.");
	expect(guide).toContain("DeepSeek V4.1 Flash 10/17 may use data for AI training");
	// A different model or effort is a separate Freebuff session and folder.
	expect((await preflight({ ...deepseek, effort: "max" })).routing!.workspace).not.toBe(dir);
});

test("each source gets its own stable folder, so concurrent terminals never share jobs", async () => {
	const channel = "https://www.youtube.com/@some-creator";
	const one = (await preflight(deepseek, channel)).routing!.workspace!;
	const video = (await preflight(deepseek, "https://www.youtube.com/watch?v=abc_DEF-123")).routing!
		.workspace!;
	expect(one).not.toBe(video);
	expect(one).not.toBe((await preflight(deepseek)).routing!.workspace);
	expect(one).toMatch(/\/deepseek-v4\.1-flash-10-17-@some-creator-[0-9a-f]{8}$/);
	expect(video).toMatch(/-abc_DEF-123-[0-9a-f]{8}$/);
	// A rerun of the same source resumes in the same folder.
	expect((await preflight(deepseek, channel)).routing!.workspace).toBe(one);
	// Only a folder preflight could have made is used.
	const elsewhere = await preflight(deepseek, channel);
	for (const workspace of [join(root, "elsewhere"), join(FREEBUFF.dir, "other-model-1234abcd")])
		expect(
			await agentPrompt("x", { ...elsewhere, routing: { ...elsewhere.routing!, workspace } })
		).toMatchObject({ ok: false, kind: "restriction" });
});

test("answers are imported once settled, unverified, and the job is retired", async () => {
	const selected = await preflight(deepseek);
	const dir = selected.routing!.workspace!;
	const mock = worker(dir, () => ({ text: '{"ok":true}', delayMs: 60 }));
	try {
		const result = await agentPrompt('Return {"ok":true}', selected);
		expect(result).toEqual({ ok: true, text: '{"ok":true}', requestedModel: deepseek.model });
		expect(readdirSync(join(dir, "jobs"))).toEqual([]);
		expect(readdirSync(join(dir, "responses"))).toEqual([]);
	} finally {
		await mock.stop();
	}
	expect(existsSync(join(root, "executed"))).toBe(false);
});

test("an invalid answer is rejected and the same job is asked again with a note", async () => {
	const selected = await preflight(deepseek);
	const notes: (string | undefined)[] = [];
	const mock = worker(selected.routing!.workspace!, (_prompt, note) => {
		notes.push(note);
		return { text: note ? '{"ok":true}' : '{"ok":' };
	});
	try {
		const result = await agentJson(
			"Return a JSON flag",
			(value): value is { ok: boolean } => (value as { ok?: unknown })?.ok === true,
			"flag",
			{ profile: selected, diagnosticsDir: join(root, "diagnostics") }
		);
		expect(result).toEqual({ obj: { ok: true } });
		expect(notes[0]).toBeUndefined();
		expect(notes[1]).toContain("could not use your previous answer");
		expect(mock.seen[0]).toBe(mock.seen[1]);
	} finally {
		await mock.stop();
	}
});

test("Freebuff-reported limits pause like quota; error text is sanitized", async () => {
	const selected = await preflight(deepseek);
	const dir = selected.routing!.workspace!;
	const pending = agentPrompt("Quota prompt", selected);
	let job = "";
	while (!job) {
		job = readdirSync(join(dir, "jobs")).find((n) => n.endsWith(".prompt.txt")) ?? "";
		await Bun.sleep(5);
	}
	writeFileSync(
		join(dir, "responses", job.replace(".prompt.txt", ".error.txt")),
		"Daily usage limit reached\u001b[31m\n"
	);
	const result = await pending;
	expect(result).toMatchObject({ ok: false, kind: "quota", limited: true });
	expect(result.error).toBe("Freebuff reported: Daily usage limit reached [31m");
});

test("cancellation keeps the job; an answer written while ytd was stopped resumes it", async () => {
	const selected = await preflight(deepseek);
	const dir = selected.routing!.workspace!;
	const controller = new AbortController();
	const pending = agentPrompt("Resume prompt", selected, controller.signal);
	let job = "";
	while (!job) {
		job = readdirSync(join(dir, "jobs")).find((n) => n.endsWith(".prompt.txt")) ?? "";
		await Bun.sleep(5);
	}
	controller.abort();
	expect(await pending).toMatchObject({ ok: false, kind: "cancelled" });
	expect(readFileSync(join(dir, "jobs", job), "utf8")).toMatch(
		/^Resume prompt\n\[\[ytd-check \w{6}\]\]\n$/
	);
	proved(dir, job.replace(".prompt.txt", ""), "saved answer");
	expect(await agentPrompt("Resume prompt", selected)).toMatchObject({
		ok: true,
		text: "saved answer"
	});
});

const pendingJob = async (dir: string) => {
	for (;;) {
		const job = readdirSync(join(dir, "jobs")).find((n) => n.endsWith(".prompt.txt"));
		if (job) return job.slice(0, -".prompt.txt".length);
		await Bun.sleep(5);
	}
};

test("unusable answer files are moved aside unread and the job is asked again", async () => {
	const selected = await preflight(deepseek);
	const dir = selected.routing!.workspace!;
	writeFileSync(join(root, "secret"), "do not read");
	const pending = agentPrompt("Link prompt", selected);
	const id = await pendingJob(dir);
	const response = join(dir, "responses", `${id}.txt`);
	symlinkSync(join(root, "secret"), response);
	const note = join(dir, "jobs", `${id}.note.txt`);
	while (!existsSync(note)) await Bun.sleep(5);
	expect(readFileSync(note, "utf8")).toContain("not a regular file");
	expect(readdirSync(join(dir, "rejected"))).toHaveLength(1);
	writeFileSync(response, "");
	while (!readFileSync(note, "utf8").includes("empty")) await Bun.sleep(5);
	proved(dir, id, "real answer");
	expect(await pending).toMatchObject({ ok: true, text: "real answer" });
	expect(readFileSync(join(root, "secret"), "utf8")).toBe("do not read");
	expect(
		await agentPrompt("x", { ...selected, routing: { ...selected.routing!, protocol: undefined } })
	).toMatchObject({ ok: false, kind: "restriction" });
});

test("a settled answer wins over a reported failure for the same job", async () => {
	const selected = await preflight(deepseek);
	const dir = selected.routing!.workspace!;
	const pending = agentPrompt("Both prompt", selected);
	const id = await pendingJob(dir);
	proved(dir, id, "answer");
	writeFileSync(join(dir, "responses", `${id}.error.txt`), "usage limit");
	expect(await pending).toMatchObject({ ok: true, text: "answer" });
	expect(readdirSync(join(dir, "responses"))).toEqual([]);
});

test("jobs of exited ytd processes are retired; their answers stay importable", async () => {
	const selected = await preflight(deepseek);
	const dir = selected.routing!.workspace!;
	const dead = Bun.spawnSync(["true"]).pid;
	writeFileSync(join(dir, "jobs", "stale.prompt.txt"), "old prompt");
	writeFileSync(join(dir, "jobs", "stale.owner"), String(dead));
	writeFileSync(join(dir, "jobs", "orphan.prompt.txt"), "no owner");
	writeFileSync(join(dir, "jobs", "live.prompt.txt"), "live prompt");
	writeFileSync(join(dir, "jobs", "live.owner"), String(process.pid));
	writeFileSync(join(dir, "responses", "stale.txt"), "kept answer");
	await preflight(deepseek);
	expect(readdirSync(join(dir, "jobs")).sort()).toEqual(["live.owner", "live.prompt.txt"]);
	expect(readdirSync(join(dir, "responses"))).toEqual(["stale.txt"]);
});

test("picker shows Freebuff capabilities, display names and model-specific effort", async () => {
	const path = join(root, "config.json");
	const seen: Record<string, { value: string; label: string; hint?: string }[]> = {};
	const pick = (model: string, effort?: string): Picker => ({
		async select(message, choices) {
			seen[message.split(" ·")[0]] = choices;
			if (message === "Agent") return "freebuff";
			if (message.startsWith("Model")) {
				expect(message).toContain("Freebuff 0.2.34 list");
				return model;
			}
			if (!effort) throw new Error("effort step shown for a model without efforts");
			return effort;
		},
		async text() {
			throw new Error("unused");
		}
	});
	const options = { path, interactive: true, installed: (name: string) => name === "freebuff" };
	await resolveCli(["settings"], {
		...options,
		ui: pick("deepseek-v4.1-flash-10-17", "high")
	});
	expect(seen.Agent.find((c) => c.value === "freebuff")?.hint).toBe(
		"interactive handoff; no headless mode; login not checked"
	);
	expect(seen.Model.find((c) => c.value === "deepseek-v4.1-flash-10-17")?.label).toBe(
		"DeepSeek V4.1 Flash 10/17"
	);
	expect(seen.Effort.map((c) => c.value)).toEqual(["__default__", "low", "high", "max"]);
	expect(loadSettings(path).selected).toEqual({ ...deepseek, contextTokens: 131072 });
	await resolveCli(["settings"], { ...options, ui: pick("mimo-v2.6-flash-fast") });
	expect(loadSettings(path).selected).toEqual({ agent: "freebuff", model: "mimo-v2.6-flash-fast" });
	expect(seen.Model.find((c) => c.value === "deepseek-v4.1-flash-10-17")?.hint).toBe(
		"recent; all modes; may use data for AI training; Freebuff may answer on GLM 5.3 Flash when it is unavailable"
	);
});

test("command-line Freebuff selection uses the catalog handoff budget unless overridden", () => {
	const settings = { version: 1 as const, recent: [], adapters: {} };
	const args = ["https://youtu.be/abcdefghijk", "--agent", "freebuff", "--model", deepseek.model];
	expect(profileFromArgs(parseArgs(args), settings)?.contextTokens).toBe(131072);
	expect(
		profileFromArgs(parseArgs([...args, "--context-tokens", "8192"]), settings)?.contextTokens
	).toBe(8192);
	expect(
		profileFromArgs(parseArgs([...args.slice(0, -1), "unlisted-model"]), settings)
	).not.toHaveProperty("contextTokens");
});

test("command-line effort must exist in the Freebuff catalog", () => {
	const settings = { version: 1 as const, recent: [], adapters: {} };
	const run = (model: string, effort: string) =>
		profileFromArgs(
			parseArgs(["u", "--agent", "freebuff", "--model", model, "--effort", effort]),
			settings
		);
	expect(() => run(deepseek.model, "xhigh")).toThrow("offers effort low, high, max");
	expect(() => run("mimo-v2.6-flash-fast", "high")).toThrow("has no effort setting");
	expect(run(deepseek.model, "max")?.effort).toBe("max");
	expect(run("unlisted-model", "anything")?.effort).toBe("anything");
});

test("a saved Freebuff context window is kept on resume", () => {
	const settings = {
		version: 1 as const,
		recent: [],
		adapters: {},
		selected: { ...deepseek, contextTokens: 65536 }
	};
	expect(profileFromArgs(parseArgs(["u"]), settings)?.contextTokens).toBe(65536);
});

test("version-unknown launchers and conflicting custom adapters are reported clearly", () => {
	expect(catalogNote(undefined)).toContain("installed version unknown");
	const path = join(root, "conflict.json");
	writeFileSync(
		path,
		JSON.stringify({
			version: 1,
			recent: [],
			adapters: { freebuff: { executable: "/bin/echo", args: ["{model}"] } }
		})
	);
	expect(() => loadSettings(path)).toThrow("conflicts with the built-in freebuff agent");
});

test("repeatedly unusable answer files stop the job instead of looping", async () => {
	const selected = await preflight(deepseek);
	const dir = selected.routing!.workspace!;
	const pending = agentPrompt("Loop prompt", selected);
	const id = await pendingJob(dir);
	const response = join(dir, "responses", `${id}.txt`);
	let result: Awaited<typeof pending> | undefined;
	pending.then((value) => (result = value));
	while (!result) {
		if (!existsSync(response)) writeFileSync(response, "");
		await Bun.sleep(20);
	}
	expect(result).toMatchObject({ ok: false });
	expect(result.error).toContain("4 unusable answer files");
}, 15_000);

test("answers must prove the whole job was read; check codes span every part", async () => {
	const selected = await preflight(deepseek);
	const dir = selected.routing!.workspace!;
	const long = Array.from({ length: 3000 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
	const pending = agentPrompt(long, selected);
	const id = await pendingJob(dir);
	const job = readFileSync(join(dir, "jobs", `${id}.prompt.txt`), "utf8");
	const codes = [...job.matchAll(/^\[\[ytd-check (\w+)\]\]$/gm)].map((m) => m[1]);
	expect(codes.length).toBeGreaterThan(2);
	expect(markedJob("[[ytd-check forged]]\nend", "id").text).toMatch(/^ \[\[ytd-check forged\]\]\n/);
	expect(job.replace(/^\[\[ytd-check \w+\]\]\n/gm, "")).toBe(long + "\n");
	// A session that saw only the start of the job cannot name the later codes.
	writeFileSync(join(dir, "responses", `${id}.txt`), `ytd-proof: ${codes[0]}\nanswer`);
	const note = join(dir, "jobs", `${id}.note.txt`);
	while (!existsSync(note)) await Bun.sleep(5);
	expect(readFileSync(note, "utf8")).toContain("every check code");
	proved(dir, id, "full answer");
	expect(await pending).toMatchObject({ ok: true, text: "full answer" });
	const next = readFileSync(join(dir, "next.sh"), "utf8");
	expect(next).toContain("NO_JOB");
	expect(readFileSync(join(dir, "INSTRUCTIONS.md"), "utf8")).toContain("sh next.sh");
});

test("next.sh prints the pending job at once and skips answered ones", async () => {
	const selected = await preflight(deepseek);
	const dir = selected.routing!.workspace!;
	writeFileSync(join(dir, "jobs", "done.prompt.txt"), "answered prompt");
	writeFileSync(join(dir, "responses", "done.txt"), "x");
	writeFileSync(join(dir, "jobs", "open.prompt.txt"), "open prompt");
	writeFileSync(join(dir, "jobs", "open.note.txt"), "a note");
	const started = Date.now();
	const out = Bun.spawnSync(["sh", join(dir, "next.sh")]).stdout.toString();
	expect(Date.now() - started).toBeLessThan(5000);
	expect(out).toContain("JOB open: write the answer to responses/open.txt");
	expect(out).toContain("--- NOTE ---\na note");
	expect(out).toContain("open prompt");
	expect(out).not.toContain("answered prompt");
});

test("saved first-release 32k Freebuff caps are upgraded on load", () => {
	const path = join(root, "legacy.json");
	writeFileSync(
		path,
		JSON.stringify({
			version: 1,
			selected: { ...deepseek, contextTokens: 32768 },
			recent: [
				{ ...deepseek, contextTokens: 32768 },
				{ agent: "claude", model: "opus", contextTokens: 32768 }
			],
			adapters: {}
		})
	);
	const config = loadSettings(path);
	expect(config.selected?.contextTokens).toBe(131072);
	expect(config.recent.map((p) => p.contextTokens)).toEqual([131072, 32768]);
});
