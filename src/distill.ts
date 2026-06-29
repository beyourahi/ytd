import { claudePrompt } from "./claude.ts";

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

export interface RoomBatch {
	room: string; // content | craft | business | design-systems
	batchMarkdown: string;
}

export interface ReduceOutput {
	contributingVideoIds: string[];
	rooms: RoomBatch[]; // wisdom smart-routed across one or more palace rooms
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

const MAP_INSTRUCTIONS = `You are distilling YouTube transcripts into applicable principles for a personal knowledge base ("field notes").

For the transcripts below, extract every genuinely useful, ACTIONABLE principle, mental model, tactic, framework, or non-obvious insight a creator/operator could apply. Ignore filler, intros/outros, sponsor reads, self-promotion, and small talk. Prefer specific, concrete, transferable wisdom over generic advice.

Output ONLY a JSON array (no prose, no code fence). Each item:
{"principle":"<short imperative title>","detail":"<1-2 sentences, specific and applicable>","theme":"<2-4 word topic>","sourceId":"<the exact videoId it came from>"}

If a transcript contains nothing applicable, contribute nothing for it.`;

function renderTranscripts(batch: Transcript[]): string {
	return batch
		.map((t) => `### videoId: ${t.id}\n# Title: ${t.title}\n${t.text}`)
		.join("\n\n---\n\n");
}

export async function mapBatch(
	batch: Transcript[]
): Promise<{ candidates: Candidate[]; limited?: boolean; error?: string }> {
	const prompt = `${MAP_INSTRUCTIONS}\n\n=== TRANSCRIPTS ===\n\n${renderTranscripts(batch)}`;
	const res = await claudePrompt(prompt);
	if (res.limited) return { candidates: [], limited: true };
	if (!res.ok) return { candidates: [], error: res.error };

	const arr = extractJson<Candidate[]>(res.text ?? "");
	if (!Array.isArray(arr)) return { candidates: [], error: "could not parse map JSON" };
	const ids = new Set(batch.map((b) => b.id));
	return { candidates: arr.filter((c) => c?.principle && ids.has(c.sourceId)) };
}

function reducePrompt(channel: string, allFieldNotes: string, candidates: Candidate[]): string {
	return `You are merging distilled principles into Rahi's mind-palace "field notes" — a curated, high-signal knowledge base.

GOVERNING RULE — HALAL GATE (highest priority). Rahi is a practicing Muslim who follows the Qur'an and the authentic Sunnah only. Every principle you keep MUST be halal wisdom (ḥikmah). Drop or reframe anything that depends on or promotes the haram (riba/interest, gambling, deception/gharar, immodesty, music-as-an-end, dishonest persuasion, etc.). Keep the transferable insight; discard the haram framing. End your output with a "## ⚠️ Halal gate" section noting anything borderline you reframed or rejected and why (cite Qur'an/Sunnah where the evidence is clear; say so plainly when it is not).

ROUTING — smartly split the kept principles ACROSS Rahi's palace rooms by what each principle is actually about. Most channels land mostly in ONE room, but send any principle that clearly belongs elsewhere to its own room (the SAME source video may appear in several rooms). Rooms:
- "content": creator economy, content/social-media strategy, audience growth, brand, marketing, copywriting, storytelling
- "craft": software engineering, building, code, dev tooling, technical how-to
- "business": operations, clients, pricing, sales, agency/ops, ventures, money, deal-making, monetization
- "design-systems": visual design, UI/UX, typography, layout, design tokens, brand visual identity
Only include a room that actually has ≥1 kept principle. If everything fits one room, return just that one.

DEDUPE — ONLY NET-NEW. ALL of Rahi's existing field notes (every room) are below. Do NOT repeat anything already covered anywhere there. Merge near-duplicate candidates into a single sharp principle. Keep only genuinely new, non-obvious, applicable wisdom. Quality over quantity — a tight set of strong principles beats a long redundant list. It is fine to keep very few (or zero) if little is net-new.

OUTPUT — return ONLY a JSON object (no prose, no code fence) with exactly two keys:
{
  "contributingVideoIds": ["<videoId>", ...],
  "rooms": [
    { "room": "<content|craft|business|design-systems>", "batchMarkdown": "<themed sections for THIS room only>" }
  ]
}
"contributingVideoIds" = every videoId that contributed at least one KEPT principle (across all rooms).
Each room's "batchMarkdown" = themed sections for THAT room only:
## A. <Theme title>
- <principle — specific, applicable, terse>. {{id:VIDEOID}}
- ...
## ⚠️ Halal gate
- <notes for this room's principles>

Put a "## ⚠️ Halal gate" section inside EACH room's batchMarkdown (covering that room's principles). Cite each bullet with the literal token {{id:VIDEOID}} using the REAL videoId (a bullet synthesised from several videos may carry several {{id:...}} tokens). Do NOT invent [M..] numbers — use only {{id:...}} tokens; the numbering is assigned downstream.

CHANNEL: ${channel}

=== EXISTING FIELD NOTES — ALL ROOMS (do not duplicate anything here) ===
${allFieldNotes || "(none yet)"}

=== CANDIDATE PRINCIPLES (JSON) ===
${JSON.stringify(candidates)}`;
}

export async function reduce(
	candidates: Candidate[],
	channel: string,
	allFieldNotes: string
): Promise<{ out?: ReduceOutput; limited?: boolean; error?: string }> {
	const res = await claudePrompt(reducePrompt(channel, allFieldNotes, candidates));
	if (res.limited) return { limited: true };
	if (!res.ok) return { error: res.error };

	const obj = extractJson<ReduceOutput>(res.text ?? "");
	if (
		!obj ||
		!Array.isArray(obj.contributingVideoIds) ||
		!Array.isArray(obj.rooms) ||
		!obj.rooms.every((r) => r && typeof r.room === "string" && typeof r.batchMarkdown === "string")
	) {
		return { error: "could not parse reduce JSON" };
	}
	return { out: obj };
}
