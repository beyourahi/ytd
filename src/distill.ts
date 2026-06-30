import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudePrompt } from "./claude.ts";
import { DEFAULTS, RUN_DIR } from "./config.ts";

export interface Transcript {
	id: string;
	title: string;
	text: string;
}

export interface Candidate {
	principle: string;
	detail: string;
	theme: string;
	sourceId: string;
}

/** One kept principle, room-scoped. The model returns small structured fields; the
 *  markdown (themed sections, [Mn] citations, halal-gate) is rendered downstream. */
export interface ReducedPrinciple {
	theme: string; // 2-4 word topic, used to group into sections
	principle: string; // one terse, applicable sentence
	ids: string[]; // the videoId(s) this principle is drawn from
}

export interface ReducedRoom {
	room: string; // content | craft | business | design-systems
	principles: ReducedPrinciple[];
	halalNotes: string[]; // anything borderline reframed/rejected, and why
}

export interface ReduceOutput {
	rooms: ReducedRoom[]; // wisdom smart-routed across one or more palace rooms
}

/** Best-effort JSON extraction from a model response (handles code fences / stray prose). */
export function extractJson<T>(text: string): T | null {
	const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	for (const candidate of [fence?.[1], text]) {
		if (!candidate) continue;
		const startObj = candidate.indexOf("{");
		const startArr = candidate.indexOf("[");
		const start = startObj < 0 ? startArr : startArr < 0 ? startObj : Math.min(startObj, startArr);
		const end = Math.max(candidate.lastIndexOf("}"), candidate.lastIndexOf("]"));
		if (start < 0 || end <= start) continue;
		try {
			return JSON.parse(candidate.slice(start, end + 1)) as T;
		} catch {
			/* try next candidate */
		}
	}
	return null;
}

/**
 * Run a prompt and parse its JSON, retrying on a non-conforming sample. The prompt
 * reliably produces valid JSON, but `claude -p` is sampled — an occasional response
 * adds a preamble/postscript or a half-truncated code fence that defeats extractJson.
 * One bad sample shouldn't abort a whole run, so retry a few times; on total failure
 * dump the last raw response to ~/.ytd/run/<label>.fail.txt so we're never blind again.
 * A genuine claude error (or usage limit) is surfaced immediately, not retried as a parse fail.
 */
async function claudeJson<T>(
	prompt: string,
	valid: (o: T) => boolean,
	label: string,
	attempts = 3
): Promise<{ obj?: T; limited?: boolean; error?: string }> {
	let lastText = "";
	for (let a = 1; a <= attempts; a++) {
		const res = await claudePrompt(prompt);
		if (res.limited) return { limited: true };
		if (!res.ok) return { error: res.error };
		lastText = res.text ?? "";
		const obj = extractJson<T>(lastText);
		if (obj && valid(obj)) return { obj };
		// non-conforming sample — try again with a fresh draw
	}
	try {
		mkdirSync(RUN_DIR, { recursive: true });
		writeFileSync(join(RUN_DIR, `${label}.fail.txt`), lastText);
	} catch {
		/* best-effort diagnostics — never mask the real error */
	}
	return {
		error: `could not parse ${label} JSON after ${attempts} attempts (raw saved to ~/.ytd/run/${label}.fail.txt)`
	};
}

/** Group transcripts into batches that fit comfortably in one Opus call. */
export function batchTranscripts(transcripts: Transcript[], maxChars: number): Transcript[][] {
	const batches: Transcript[][] = [];
	let cur: Transcript[] = [];
	let size = 0;
	for (const t of transcripts) {
		const len = t.text.length + t.title.length + t.id.length + 64;
		if (size + len > maxChars && cur.length) {
			batches.push(cur);
			cur = [];
			size = 0;
		}
		cur.push(t);
		size += len;
	}
	if (cur.length) batches.push(cur);
	return batches;
}

/** Split candidates into reduce passes that fit comfortably in one Opus call alongside
 *  the existing field-notes — bounding input so the answer never gets truncated. */
export function chunkCandidates(candidates: Candidate[], maxChars: number): Candidate[][] {
	const chunks: Candidate[][] = [];
	let cur: Candidate[] = [];
	let size = 0;
	for (const c of candidates) {
		const len = JSON.stringify(c).length + 1;
		if (size + len > maxChars && cur.length) {
			chunks.push(cur);
			cur = [];
			size = 0;
		}
		cur.push(c);
		size += len;
	}
	if (cur.length) chunks.push(cur);
	return chunks;
}

const MAP_INSTRUCTIONS = `You are distilling YouTube transcripts into applicable principles for a personal knowledge base ("field notes").

For the transcripts below, extract every genuinely useful, ACTIONABLE principle, mental model, tactic, framework, or non-obvious insight a creator/operator could apply. Ignore filler, intros/outros, sponsor reads, self-promotion, and small talk. Prefer specific, concrete, transferable wisdom over generic advice.

Output ONLY a JSON array (no prose, no code fence). Each item:
{"principle":"<short imperative title>","detail":"<1-2 sentences, specific and applicable>","theme":"<2-4 word topic>","sourceId":"<the exact videoId it came from>"}

If a transcript contains nothing applicable, contribute nothing for it.`;

const MAP_GLEAN_INSTRUCTIONS = `You already extracted principles from the transcripts below — they are listed under ALREADY EXTRACTED. Do a careful SECOND pass and surface genuinely useful, ACTIONABLE principles, mental models, tactics, frameworks, or non-obvious insights the first pass MISSED — the kind easy to skip when reading a large batch once.

Same filters: ignore filler, intros/outros, sponsor reads, self-promotion, and small talk; prefer specific, concrete, transferable wisdom over generic advice. Do NOT repeat or merely restate anything under ALREADY EXTRACTED — return only NET-NEW principles.

Output ONLY a JSON array (no prose, no code fence). Each item:
{"principle":"<short imperative title>","detail":"<1-2 sentences, specific and applicable>","theme":"<2-4 word topic>","sourceId":"<the exact videoId it came from>"}

If the first pass already caught everything useful, return [].`;

function renderTranscripts(batch: Transcript[]): string {
	return batch
		.map((t) => `### videoId: ${t.id}\n# Title: ${t.title}\n${t.text}`)
		.join("\n\n---\n\n");
}

function gleanPrompt(transcripts: string, kept: Candidate[]): string {
	const already = kept.length
		? kept.map((c) => `- [${c.sourceId}] ${c.principle}`).join("\n")
		: "(nothing yet)";
	return `${MAP_GLEAN_INSTRUCTIONS}\n\n=== ALREADY EXTRACTED ===\n${already}\n\n=== TRANSCRIPTS ===\n\n${transcripts}`;
}

export async function mapBatch(
	batch: Transcript[]
): Promise<{ candidates: Candidate[]; limited?: boolean; error?: string }> {
	const transcripts = renderTranscripts(batch);
	const ids = new Set(batch.map((b) => b.id));

	const first = await claudeJson<Candidate[]>(
		`${MAP_INSTRUCTIONS}\n\n=== TRANSCRIPTS ===\n\n${transcripts}`,
		(a) => Array.isArray(a),
		"map"
	);
	if (first.limited) return { candidates: [], limited: true };
	if (first.error || !first.obj)
		return { candidates: [], error: first.error ?? "could not parse map JSON" };
	const kept = first.obj.filter((c) => c?.principle && ids.has(c.sourceId));

	// Second "what did I miss?" pass — a single sampled first draw skips long-tail principles
	// buried in a big batch; gleaning over the same transcripts recovers them. Resilience rules:
	// a usage-limit discards the batch (videos stay "fetched" → resume re-maps it cleanly), but a
	// glean parse failure must NOT throw away a good first pass — just keep the first-pass set.
	const glean = await claudeJson<Candidate[]>(
		gleanPrompt(transcripts, kept),
		(a) => Array.isArray(a),
		"map-glean"
	);
	if (glean.limited) return { candidates: [], limited: true };
	const extra = (glean.obj ?? []).filter((c) => c?.principle && ids.has(c.sourceId));

	// ponytail: env-gated one-liner — see how much the glean pass actually recovers per batch.
	if (process.env.YTD_DEBUG_MAP)
		console.error(`  [map] first pass: ${kept.length} · glean added: ${extra.length}`);
	return { candidates: [...kept, ...extra] };
}

function reducePrompt(
	channel: string,
	allFieldNotes: string,
	candidates: Candidate[],
	alreadyKept: string[]
): string {
	const keptBlock = alreadyKept.length
		? `\n=== ALREADY KEPT EARLIER THIS RUN (do NOT repeat or restate these) ===\n${alreadyKept.map((p) => `- ${p}`).join("\n")}\n`
		: "";

	return `You are merging distilled principles into Rahi's mind-palace "field notes" — a curated, high-signal knowledge base.

GOVERNING RULE — HALAL GATE (highest priority). Rahi is a practicing Muslim who follows the Qur'an and the authentic Sunnah only. Every principle you keep MUST be halal wisdom (ḥikmah). Drop or reframe anything that depends on or promotes the haram (riba/interest, gambling, deception/gharar, immodesty, music-as-an-end, dishonest persuasion, etc.). Keep the transferable insight; discard the haram framing.

ROUTING — smartly split the kept principles ACROSS Rahi's palace rooms by what each principle is actually about. Most channels land mostly in ONE room, but send any principle that clearly belongs elsewhere to its own room (the SAME source video may appear in several rooms). Rooms:
- "content": creator economy, content/social-media strategy, audience growth, brand, marketing, copywriting, storytelling
- "craft": software engineering, building, code, dev tooling, technical how-to
- "business": operations, clients, pricing, sales, agency/ops, ventures, money, deal-making, monetization
- "design-systems": visual design, UI/UX, typography, layout, design tokens, brand visual identity
Only include a room that actually has ≥1 kept principle. If everything fits one room, return just that one.

DEDUPE — ONLY NET-NEW. ALL of Rahi's existing field notes are below. Do NOT repeat anything already covered there, nor anything in "ALREADY KEPT EARLIER THIS RUN". Merge near-duplicate candidates into a single sharp principle. Keep only genuinely new, non-obvious, applicable wisdom. Quality over quantity — a tight set of strong principles beats a long redundant list. It is fine to keep very few (or zero) if little is net-new.

OUTPUT — return ONLY a JSON object (no prose, no code fence) of this exact shape:
{
  "rooms": [
    {
      "room": "<content|craft|business|design-systems>",
      "principles": [
        { "theme": "<2-4 word topic>", "principle": "<ONE terse, specific, applicable sentence>", "ids": ["<videoId>", ...] }
      ],
      "halalNotes": ["<short note on anything borderline you reframed or rejected, and why — cite Qur'an/Sunnah where the evidence is clear; say so plainly when it is not>"]
    }
  ]
}
RULES for the JSON:
- "principle" is plain text — NO markdown, NO [M..] numbers, NO citation tokens. Keep it to one sentence.
- "ids" lists the REAL videoId(s) the principle came from (a principle synthesised from several videos lists several). Use only ids that appear in the candidates below.
- "halalNotes" may be [] if nothing was borderline.
- Group related principles by giving them the same "theme" — they become one section downstream.

CHANNEL: ${channel}
${keptBlock}
=== EXISTING FIELD NOTES — TARGET ROOMS (do not duplicate anything here) ===
${allFieldNotes || "(none yet)"}

=== CANDIDATE PRINCIPLES (JSON) ===
${JSON.stringify(candidates)}`;
}

/** Reduce in bounded passes (input never crowds the context window), carrying kept
 *  principle titles forward so later passes still dedup. Merges per room. */
export async function reduce(
	candidates: Candidate[],
	channel: string,
	allFieldNotes: string,
	onPass?: (pass: number, total: number) => void
): Promise<{ out?: ReduceOutput; limited?: boolean; error?: string }> {
	const chunks = chunkCandidates(candidates, DEFAULTS.reduceBatchChars);
	const byRoom = new Map<string, ReducedRoom>();
	const keptTitles: string[] = [];

	for (let i = 0; i < chunks.length; i++) {
		onPass?.(i + 1, chunks.length);
		const pass = await claudeJson<ReduceOutput>(
			reducePrompt(channel, allFieldNotes, chunks[i], keptTitles),
			(o) => Array.isArray(o.rooms),
			`reduce-pass-${i + 1}`
		);
		if (pass.limited) return { limited: true };
		if (pass.error || !pass.obj) return { error: pass.error ?? "reduce failed" };

		for (const r of pass.obj.rooms) {
			if (!r || typeof r.room !== "string" || !Array.isArray(r.principles)) continue;
			const principles = r.principles.filter(
				(p) =>
					p &&
					typeof p.principle === "string" &&
					p.principle.trim() &&
					typeof p.theme === "string" &&
					Array.isArray(p.ids) &&
					p.ids.length > 0
			);
			if (!principles.length) continue;
			const room = byRoom.get(r.room) ?? { room: r.room, principles: [], halalNotes: [] };
			room.principles.push(...principles);
			if (Array.isArray(r.halalNotes)) {
				room.halalNotes.push(...r.halalNotes.filter((n) => typeof n === "string" && n.trim()));
			}
			byRoom.set(r.room, room);
			for (const p of principles) keptTitles.push(p.principle);
		}
	}

	return { out: { rooms: [...byRoom.values()] } };
}
