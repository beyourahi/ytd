import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CACHE_DIR } from "./config.ts";
import { atomicCache } from "./fetch.ts";
import { runCommand } from "./process.ts";

/**
 * Optional local speech-to-text for videos with no usable captions.
 *
 * Disabled unless the operator asks for it, and never downloading anything on its own: the
 * engine binary and its model must already exist on this machine, named explicitly or found
 * where the operator put them. Only open-source local engines are supported, so recovering a
 * captionless video never spends money or ships its audio to a third party.
 *
 * Provenance is not negotiable. A local transcription is cached with a header naming it as
 * generated speech rather than captions, so nothing downstream — or later — can mistake
 * synthesised text for what the video actually published.
 */

export interface TranscriptionEngine {
	/** Executable that performs inference (whisper.cpp's `whisper-cli` and friends). */
	command: string;
	/** Path to the local model file. Never fetched automatically. */
	model: string;
	language: string;
	threads: number;
	timeoutMs: number;
}

export interface TranscriptionRequest extends Partial<TranscriptionEngine> {
	/** Master switch. Off unless the operator turned it on. */
	enabled?: boolean;
}

/** Conventional names an operator is told to provide. Nothing is ever downloaded here. */
export const WHISPER_COMMANDS = ["whisper-cli", "whisper-cpp", "main"] as const;
export const LOCAL_TRANSCRIPTION_MARKER = "[LOCAL TRANSCRIPTION (whisper.cpp)]";

export function localTranscriptionPath(id: string, root = CACHE_DIR): string {
	if (!/^[A-Za-z0-9_-]{11}$/.test(id)) throw new Error("Invalid video identity.");
	return join(root, "videos", `${id}.local.txt`);
}

/** True when a cached transcript came from local speech rather than published captions. */
export function isLocalTranscript(text: string): boolean {
	return text.startsWith(LOCAL_TRANSCRIPTION_MARKER);
}

function onPath(name: string): string | null {
	return Bun.which(name, { PATH: process.env.PATH }) ?? null;
}

/**
 * Resolve the engine, or explain exactly what is missing.
 *
 * Both halves are required and neither is ever obtained silently: a missing executable or model
 * fails closed before any download, because a transcription that quietly fetched a model would
 * spend the operator's bandwidth and disk on a decision they did not make.
 */
export function resolveEngine(
	request: TranscriptionRequest
): { ok: true; engine: TranscriptionEngine } | { ok: false; reason: string } {
	const command =
		request.command ??
		process.env.YTD_WHISPER_COMMAND ??
		WHISPER_COMMANDS.map((name) => onPath(name)).find(Boolean) ??
		"";
	const model = request.model ?? process.env.YTD_WHISPER_MODEL ?? "";
	const missing: string[] = [];
	if (!command) missing.push("a whisper.cpp executable (install it, or set --whisper-command)");
	else if (!existsSync(command) && !onPath(command)) missing.push(`an executable at ${command}`);
	if (!model) missing.push("a local model file (set --whisper-model)");
	else if (!existsSync(model)) missing.push(`a model file at ${model}`);
	if (missing.length)
		return {
			ok: false,
			reason: `Local transcription needs ${missing.join(" and ")}. Nothing is downloaded automatically; re-run without --transcribe, or provide the engine and model.`
		};
	return {
		ok: true,
		engine: {
			command,
			model,
			language: request.language ?? "en",
			threads: Math.max(1, Math.floor(request.threads ?? 4)),
			timeoutMs: Math.max(60_000, request.timeoutMs ?? 30 * 60_000)
		}
	};
}

export interface TranscriptionOutcome {
	/** Text with its provenance header, ready for the transcript cache. */
	text?: string;
	/** A cache hit: no download and no inference were performed. */
	cached?: boolean;
	/** Set when transcription could not produce text; the video stays captionless. */
	reason?: string;
}

/** The transcript body a captionless video should carry: its own generated speech, labelled. */
export function localTranscript(id: string, root = CACHE_DIR): string | null {
	const path = localTranscriptionPath(id, root);
	if (!existsSync(path)) return null;
	const text = readFileSync(path, "utf8").trim();
	return text ? `${LOCAL_TRANSCRIPTION_MARKER}\n${text}` : null;
}

/**
 * Recover one video's spoken content locally.
 *
 * The audio is a scratch artefact of this call and is always removed, including after a
 * cancellation or a timeout. The recovered text is cached per video, so a resumed run reuses
 * it instead of re-downloading and re-transcribing the same audio.
 */
export async function transcribeVideo(
	id: string,
	engine: TranscriptionEngine,
	options: { signal?: AbortSignal; cacheDir?: string } = {}
): Promise<TranscriptionOutcome> {
	if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return { reason: "invalid_identity" };
	const root = options.cacheDir ?? CACHE_DIR;
	const cached = localTranscriptionPath(id, root);
	const existing = existsSync(cached) ? readFileSync(cached, "utf8").trim() : "";
	if (existing) return { text: `${LOCAL_TRANSCRIPTION_MARKER}\n${existing}`, cached: true };
	const videos = join(root, "videos");
	mkdirSync(videos, { recursive: true });
	const scratch = mkdtempSync(join(videos, `.transcribe-${id}-`));
	try {
		const download = await runCommand(
			[
				"yt-dlp",
				"--no-playlist",
				"--extract-audio",
				"--audio-format",
				"wav",
				"--postprocessor-args",
				"-ar 16000 -ac 1",
				"-o",
				join(scratch, `${id}.%(ext)s`),
				`https://www.youtube.com/watch?v=${id}`
			],
			{ signal: options.signal, timeoutMs: engine.timeoutMs }
		);
		if (download.cancelled) throw new Error("Transcription cancelled; progress preserved.");
		const audio = join(scratch, `${id}.wav`);
		if (download.code !== 0 || !existsSync(audio))
			return { reason: download.timedOut ? "download_timeout" : "download_failed" };
		const out = join(scratch, id);
		const inference = await runCommand(
			[
				engine.command,
				"-m",
				engine.model,
				"-f",
				audio,
				"-l",
				engine.language,
				"-t",
				String(engine.threads),
				"-otxt",
				"-of",
				out
			],
			{ signal: options.signal, timeoutMs: engine.timeoutMs }
		);
		if (inference.cancelled) throw new Error("Transcription cancelled; progress preserved.");
		const produced = `${out}.txt`;
		if (inference.code !== 0 || !existsSync(produced))
			return { reason: inference.timedOut ? "engine_timeout" : "engine_failed" };
		const text = readFileSync(produced, "utf8")
			.split(/\r?\n/)
			// whisper.cpp writes `[00:00:00.000 --> 00:00:05.000]  text`; keep only the speech.
			.map((line) => line.replace(/^\s*\[[\d:.,\s>-]*\]\s*/, "").trim())
			.filter(Boolean)
			.join(" ")
			.trim();
		if (!text) return { reason: "empty_transcription" };
		atomicCache(cached, text);
		return { text: `${LOCAL_TRANSCRIPTION_MARKER}\n${text}` };
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}
