import { expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	LOCAL_TRANSCRIPTION_MARKER,
	localTranscript,
	localTranscriptionPath,
	resolveEngine,
	transcribeVideo
} from "../src/transcribe.ts";

const id = "dQw4w9WgXcQ";

/** A fake yt-dlp that writes the audio file it was asked to produce, and counts its calls. */
function fakeYtDlp(bin: string, options: { fail?: boolean } = {}): void {
	writeFileSync(
		join(bin, "yt-dlp"),
		`#!/usr/bin/env bun
import {appendFileSync, writeFileSync} from "node:fs";
appendFileSync(process.env.YTD_TRANSCRIBE_CALLS,"yt-dlp\\n");
const args=process.argv.slice(2), template=args[args.indexOf("-o")+1];
if (${options.fail ? "true" : "false"}) { console.error("ERROR: ffmpeg not found"); process.exit(1); }
writeFileSync(template.replace("%(ext)s","wav"),Buffer.alloc(1024));
`
	);
	chmodSync(join(bin, "yt-dlp"), 0o755);
}

/** A fake whisper.cpp engine: writes the `-of` text file with timestamped segments. */
function fakeWhisper(bin: string, options: { exitCode?: number; empty?: boolean } = {}): string {
	const executable = join(bin, "whisper-cli");
	writeFileSync(
		executable,
		`#!/usr/bin/env bun
import {appendFileSync, writeFileSync} from "node:fs";
appendFileSync(process.env.YTD_TRANSCRIBE_CALLS,"whisper\\n");
const args=process.argv.slice(2), out=args[args.indexOf("-of")+1];
writeFileSync(out+".txt",${options.empty ? '""' : '"[00:00:00.000 --> 00:00:04.000]  Recover the knowledge.\\n[00:00:04.000 --> 00:00:08.000]  Then publish it.\\n"'});
process.exit(${options.exitCode ?? 0});
`
	);
	chmodSync(executable, 0o755);
	return executable;
}

function fixture(): {
	root: string;
	bin: string;
	cache: string;
	calls: () => string[];
	model: string;
} {
	const root = mkdtempSync(join(tmpdir(), "ytd-transcribe-"));
	const bin = join(root, "bin");
	mkdirSync(bin);
	const model = join(bin, "model.bin");
	writeFileSync(model, "model");
	process.env.YTD_TRANSCRIBE_CALLS = join(root, "calls");
	process.env.PATH = `${bin}:${process.env.PATH}`;
	return {
		root,
		bin,
		cache: join(root, "cache"),
		model,
		calls: () =>
			existsSync(join(root, "calls"))
				? readFileSync(join(root, "calls"), "utf8").trim().split("\n")
				: []
	};
}

test("transcription is off unless asked for, and an unconfigured engine refuses before downloading", () => {
	const original = process.env.PATH;
	const command = process.env.YTD_WHISPER_COMMAND;
	const model = process.env.YTD_WHISPER_MODEL;
	try {
		// A machine with no engine, no model and no explicit configuration must refuse.
		process.env.PATH = "/nonexistent";
		delete process.env.YTD_WHISPER_COMMAND;
		delete process.env.YTD_WHISPER_MODEL;
		const refusal = resolveEngine({ enabled: true });
		if (refusal.ok) throw new Error("an unconfigured engine must never resolve");
		expect(refusal.reason).toContain("executable");
		expect(refusal.reason).toContain("model");
		expect(refusal.reason).toContain("Nothing is downloaded");
		// A half-configured engine is still a refusal, not an automatic download.
		expect(resolveEngine({ command: process.execPath })).toMatchObject({ ok: false });
	} finally {
		process.env.PATH = original;
		if (command !== undefined) process.env.YTD_WHISPER_COMMAND = command;
		if (model !== undefined) process.env.YTD_WHISPER_MODEL = model;
	}
});

test("a configured engine recovers speech, labels its provenance and caches it", async () => {
	const f = fixture();
	try {
		fakeYtDlp(f.bin);
		const command = fakeWhisper(f.bin);
		const resolved = resolveEngine({ command, model: f.model });
		if (!resolved.ok) throw new Error(resolved.reason);
		const first = await transcribeVideo(id, resolved.engine, { cacheDir: f.cache });
		expect(first.reason).toBeUndefined();
		expect(first.text).toBe(
			`${LOCAL_TRANSCRIPTION_MARKER}\nRecover the knowledge. Then publish it.`
		);
		expect(f.calls()).toEqual(["yt-dlp", "whisper"]);
		// Cached per video, so recovered speech is neither recomputed nor re-downloaded.
		expect(readFileSync(localTranscriptionPath(id, f.cache), "utf8")).toBe(
			"Recover the knowledge. Then publish it."
		);
		expect(localTranscript(id, f.cache)).toContain(LOCAL_TRANSCRIPTION_MARKER);
		const second = await transcribeVideo(id, resolved.engine, { cacheDir: f.cache });
		expect(second.cached).toBe(true);
		expect(f.calls()).toEqual(["yt-dlp", "whisper"]);
		// The audio is a scratch artefact: nothing but the transcript remains.
		expect(
			readdirSync(join(f.cache, "videos")).filter((name) => name.startsWith(".transcribe-"))
		).toEqual([]);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test("a failed download or inference leaves the video captionless and cleans its scratch audio", async () => {
	for (const failure of ["download", "engine", "empty"] as const) {
		const f = fixture();
		try {
			fakeYtDlp(f.bin, { fail: failure === "download" });
			const command = fakeWhisper(
				f.bin,
				failure === "engine" ? { exitCode: 1 } : failure === "empty" ? { empty: true } : {}
			);
			const resolved = resolveEngine({ command, model: f.model });
			if (!resolved.ok) throw new Error(resolved.reason);
			const outcome = await transcribeVideo(id, resolved.engine, { cacheDir: f.cache });
			expect(outcome.text).toBeUndefined();
			expect(outcome.reason).toBe(
				failure === "download"
					? "download_failed"
					: failure === "engine"
						? "engine_failed"
						: "empty_transcription"
			);
			// A rejected attempt caches nothing, so the video is simply still captionless.
			expect(existsSync(localTranscriptionPath(id, f.cache))).toBe(false);
			expect(
				readdirSync(join(f.cache, "videos")).filter((name) => name.startsWith(".transcribe-"))
			).toEqual([]);
		} finally {
			rmSync(f.root, { recursive: true, force: true });
		}
	}
});

test("cancellation stops the download and removes the scratch directory", async () => {
	const f = fixture();
	try {
		writeFileSync(
			join(f.bin, "yt-dlp"),
			`#!/usr/bin/env bun
import {appendFileSync, writeFileSync} from "node:fs";
appendFileSync(process.env.YTD_TRANSCRIBE_CALLS,"yt-dlp\\n");
writeFileSync(process.env.YTD_TRANSCRIBE_READY,"ready");
setInterval(()=>{},1000);
`
		);
		chmodSync(join(f.bin, "yt-dlp"), 0o755);
		const command = fakeWhisper(f.bin);
		const resolved = resolveEngine({ command, model: f.model });
		if (!resolved.ok) throw new Error(resolved.reason);
		const ready = join(f.root, "ready");
		process.env.YTD_TRANSCRIBE_READY = ready;
		const controller = new AbortController();
		const pending = transcribeVideo(id, resolved.engine, {
			cacheDir: f.cache,
			signal: controller.signal
		});
		const deadline = Date.now() + 10_000;
		while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(5);
		controller.abort();
		await expect(pending).rejects.toThrow("Transcription cancelled");
		expect(
			readdirSync(join(f.cache, "videos")).filter((name) => name.startsWith(".transcribe-"))
		).toEqual([]);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});
