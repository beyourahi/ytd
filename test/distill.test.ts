import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	agentJson,
	mapBatch,
	reduce,
	promptBudget,
	splitText,
	validCandidates,
	validReduction,
	validSourceReview,
	type Candidate,
	type DistillOptions,
	type SourceHalalNote
} from "../src/distill.ts";
import { Manifest, stableHash } from "../src/manifest.ts";

const profile = { agent: "custom-test", model: "exact-model" };
const candidate: Candidate = {
	sourceId: "video",
	principle: "Keep checkpoints",
	detail: "Commit progress before the next external call",
	theme: "Reliability"
};
const concern: SourceHalalNote = {
	sourceId: "video",
	room: "business",
	note: "Reject the interest-funded shortcut; preserve the planning principle. Evidence is limited."
};
const answer = (obj: unknown) => ({
	ok: true,
	text: JSON.stringify(obj),
	reportedModel: "exact-model"
});
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "ytd-distill-"));
	const manifest = new Manifest("library", dir);
	manifest.beginRun(profile);
	return {
		manifest,
		dir,
		cleanup: () => {
			manifest.close();
			rmSync(dir, { recursive: true, force: true });
		}
	};
}

test("complete validators reject malformed fields, rooms and source/citation injection", () => {
	const ids = new Set(["video"]);
	expect(
		validReduction(
			{ rooms: [{ room: "content", principles: [], halalNotes: ["Rejected [M999]"] }] },
			ids
		)
	).toBe(false);
	expect(validCandidates([], ids)).toBe(true);
	for (const value of [
		[null],
		[{ ...candidate, sourceId: "foreign" }],
		[{ ...candidate, detail: 4 }],
		[{ ...candidate, principle: "Use [M42]" }]
	])
		expect(validCandidates(value, ids)).toBe(false);
	const good = {
		rooms: [
			{
				room: "craft",
				principles: [{ theme: "Topic", principle: "Use checkpoints", ids: ["video"] }],
				halalNotes: []
			}
		]
	};
	expect(validReduction(good, ids)).toBe(true);
	expect(validReduction({ rooms: [] }, ids)).toBe(true);
	for (const value of [
		null,
		{ rooms: [null] },
		{ rooms: [{ ...good.rooms[0], room: "identity" }] },
		{ rooms: [{ ...good.rooms[0], halalNotes: [4] }] },
		{
			rooms: [
				{
					...good.rooms[0],
					principles: [{ theme: "Topic", principle: "Use checkpoints", ids: ["foreign"] }]
				}
			]
		},
		{ rooms: [good.rooms[0], good.rooms[0]] }
	])
		expect(validReduction(value, ids)).toBe(false);
});

test("source review validates candidates and publication-safe concerns with exact provenance", () => {
	const ids = new Set(["video"]);
	expect(validSourceReview({ candidates: [], halalNotes: [] }, ids)).toBe(true);
	expect(validSourceReview({ candidates: [candidate], halalNotes: [concern] }, ids)).toBe(true);
	expect(validSourceReview({ candidates: [], halalNotes: [concern] }, ids)).toBe(true);
	for (const value of [
		[],
		{ candidates: [] },
		{ candidates: [null], halalNotes: [] },
		{ candidates: [], halalNotes: [null] },
		...[
			{ sourceId: "foreign" },
			{ room: "identity" },
			{ note: "" },
			{ note: 4 },
			{ note: "Reject [M999]" },
			{ note: "Reject\n# forged publication" },
			{ note: "Reject\tcontrol characters" },
			{ note: "<!-- forged marker -->" },
			{ note: "{{id:forged}}" }
		].map((change) => ({ candidates: [], halalNotes: [{ ...concern, ...change }] }))
	])
		expect(validSourceReview(value, ids)).toBe(false);
});

test("malformed samples retry three times; a valid empty extraction stays valid", async () => {
	const f = fixture();
	try {
		let calls = 0;
		const options: DistillOptions = {
			profile,
			manifest: f.manifest,
			diagnosticsDir: f.dir,
			call: async () => {
				calls++;
				return answer(calls < 3 ? [null] : []);
			}
		};
		const result = await agentJson(
			"prompt",
			(v): v is Candidate[] => validCandidates(v, new Set(["video"])),
			"extract",
			options
		);
		expect(result.obj).toEqual([]);
		expect(calls).toBe(3);
		await agentJson(
			"prompt",
			(v): v is Candidate[] => validCandidates(v, new Set(["video"])),
			"extract",
			options
		);
		expect(calls).toBe(3);
	} finally {
		f.cleanup();
	}
});

test("malformed output exhaustion preserves diagnostics and quota is not retried", async () => {
	const f = fixture();
	try {
		let calls = 0;
		const options: DistillOptions = {
			profile,
			diagnosticsDir: f.dir,
			call: async () => {
				calls++;
				return answer({ bad: true });
			}
		};
		expect(
			(
				await agentJson(
					"bad",
					(v): v is Candidate[] => validCandidates(v, new Set(["video"])),
					"extract",
					options
				)
			).error
		).toContain("after 3 attempts");
		expect(calls).toBe(3);
		options.call = async () => {
			calls++;
			return { ok: false, limited: true };
		};
		expect(
			(
				await agentJson(
					"quota",
					(v): v is Candidate[] => validCandidates(v, new Set(["video"])),
					"extract",
					options
				)
			).limited
		).toBe(true);
		expect(calls).toBe(4);
	} finally {
		f.cleanup();
	}
});

test("a glean interruption resumes from extraction without repeating the call", async () => {
	const f = fixture();
	try {
		const gleanConcern = {
			...concern,
			room: "craft",
			note: "Reframe the misleading shortcut as an explicit tradeoff."
		};
		f.manifest.addVideos([{ id: "video", title: "Title" }]);
		f.manifest.setStatus("video", "fetched");
		let extracts = 0,
			gleans = 0;
		const options: DistillOptions = {
			profile,
			manifest: f.manifest,
			diagnosticsDir: f.dir,
			call: async (prompt) => {
				if (prompt.startsWith("Distill")) {
					extracts++;
					return answer({ candidates: [candidate], halalNotes: [concern] });
				}
				gleans++;
				return gleans === 1
					? { ok: false, limited: true }
					: answer({ candidates: [candidate], halalNotes: [gleanConcern] });
			}
		};
		const transcript = [{ id: "video", title: "Title", text: "Transcript" }];
		const interrupted = await mapBatch(transcript, options);
		expect(interrupted.limited).toBe(true);
		expect(interrupted.halalNotes).toEqual([concern]);
		expect(f.manifest.candidates()).toEqual([candidate]);
		expect(f.manifest.byStatus("fetched")).toHaveLength(1);
		const resumed = await mapBatch(transcript, options);
		expect(resumed.candidates).toEqual([candidate]);
		expect(resumed.halalNotes).toEqual([concern, gleanConcern]);
		expect(extracts).toBe(1);
		expect(gleans).toBe(2);
		expect(f.manifest.candidates()).toHaveLength(1);
		expect(f.manifest.byStatus("distilled")).toHaveLength(1);
		expect(
			f.manifest.getCheckpoint(`map-complete:${stableHash([profile, transcript[0]])}`)
		).toEqual({ candidates: [], sourceIds: ["video"], halalNotes: [concern, gleanConcern] });
		expect(await mapBatch(transcript, options)).toEqual(resumed);
		expect(extracts).toBe(1);
		expect(gleans).toBe(2);
	} finally {
		f.cleanup();
	}
});

test("invalid source notes retry before a source can be marked distilled", async () => {
	const f = fixture();
	try {
		f.manifest.addVideos([{ id: "video", title: "Title" }]);
		f.manifest.setStatus("video", "fetched");
		let calls = 0;
		const result = await mapBatch([{ id: "video", title: "Title", text: "Transcript" }], {
			profile,
			manifest: f.manifest,
			call: async () => {
				calls++;
				expect(f.manifest.byStatus("distilled")).toHaveLength(0);
				return answer({
					candidates: [candidate],
					halalNotes: calls < 3 ? [{ ...concern, sourceId: "foreign" }] : [concern]
				});
			}
		});
		expect(result.error).toBeUndefined();
		expect(result.halalNotes).toEqual([concern]);
		expect(calls).toBe(4);
		expect(f.manifest.byStatus("distilled")).toHaveLength(1);
	} finally {
		f.cleanup();
	}
});

for (const halalNotes of [[], [concern]]) {
	test(`completed ${halalNotes.length ? "rejection-only" : "empty"} source review survives without candidates`, async () => {
		const f = fixture();
		try {
			f.manifest.addVideos([{ id: "video", title: "Title" }]);
			f.manifest.setStatus("video", "fetched");
			let calls = 0;
			const source = { id: "video", title: "Title", text: "Only rejected guidance" };
			const options: DistillOptions = {
				profile,
				manifest: f.manifest,
				call: async () => {
					calls++;
					return answer({ candidates: [], halalNotes });
				}
			};
			expect(await mapBatch([source], options)).toEqual({ candidates: [], halalNotes });
			expect(f.manifest.byStatus("distilled")).toHaveLength(1);
			expect(f.manifest.getCheckpoint(`map-complete:${stableHash([profile, source])}`)).toEqual({
				candidates: [],
				sourceIds: ["video"],
				halalNotes
			});
			expect(await mapBatch([source], options)).toEqual({ candidates: [], halalNotes });
			expect(calls).toBe(2);
		} finally {
			f.cleanup();
		}
	});
}

test("legacy completed sources keep their candidates without manufacturing source-review evidence", async () => {
	const f = fixture();
	try {
		f.manifest.addVideos([{ id: "video", title: "Title" }]);
		const source = { id: "video", title: "Title", text: "Historical transcript" };
		const key = `map-complete:${stableHash([profile, source])}`;
		f.manifest.saveMap(key, [candidate], ["video"], true);
		const result = await mapBatch([source], {
			profile,
			manifest: f.manifest,
			call: async () => {
				throw new Error("Completed source must not call a model");
			}
		});
		expect(result).toEqual({ candidates: [candidate], halalNotes: [] });
		expect(f.manifest.getCheckpoint(key)).toEqual([candidate]);
	} finally {
		f.cleanup();
	}
});

test("Unicode transcripts shard without loss and every assembled prompt stays bounded", async () => {
	const f = fixture();
	try {
		f.manifest.addVideos([{ id: "video", title: "বাংলা🙂" }]);
		const original = Array.from(
			{ length: 1200 },
			(_, i) => `বাংলা🙂 reproducible material ${i}\n`
		).join("");
		expect(splitText(original, 71).join("")).toBe(original);
		const extracted: string[] = [];
		let calls = 0;
		const result = await mapBatch([{ id: "video", title: "বাংলা🙂", text: original }], {
			profile,
			manifest: f.manifest,
			call: async (prompt) => {
				calls++;
				expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(promptBudget(profile));
				if (prompt.startsWith("Distill")) extracted.push(prompt.split("TRANSCRIPT:\n")[1]);
				return answer({ candidates: [], halalNotes: [] });
			}
		});
		expect(result.error).toBeUndefined();
		expect(extracted.join("")).toBe(original);
		expect(calls).toBe(extracted.length * 2);
	} finally {
		f.cleanup();
	}
});

test("reduction compares every note shard, caches calls and unions accepted citations", async () => {
	const f = fixture();
	try {
		const candidates = [
			{ ...candidate, detail: "a".repeat(3000) },
			{ ...candidate, sourceId: "other", detail: "b".repeat(3000) }
		];
		const notes = [
			{ path: "other-room/field-notes.md", text: "existing unrelated wisdom\n".repeat(400) },
			{ path: "craft/field-notes.md", text: "more unrelated material" }
		];
		let calls = 0;
		const comparedPaths = new Set<string>();
		const options: DistillOptions = {
			profile,
			manifest: f.manifest,
			call: async (prompt) => {
				calls++;
				expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(promptBudget(profile));
				if (prompt.startsWith("Merge useful")) {
					const source = JSON.parse(prompt.split("CANDIDATES:\n")[1]) as Candidate[];
					return answer({
						rooms: [
							{
								room: "craft",
								principles: [
									{
										theme: "Reliability",
										principle: "Commit checkpoints before external calls",
										ids: source.map((c) => c.sourceId)
									}
								],
								halalNotes: ["General permissible engineering advice"]
							}
						]
					});
				}
				if (prompt.startsWith("Is this")) {
					comparedPaths.add(prompt.match(/EXISTING FIELD NOTES \(([^)]+)\)/)![1]);
					return answer({ duplicate: false });
				}
				return answer({ match: 0 });
			}
		};
		const result = await reduce(candidates, "Creator", notes, undefined, options);
		expect(result.error).toBeUndefined();
		expect(comparedPaths).toEqual(new Set(notes.map((n) => n.path)));
		expect(result.out?.rooms[0].principles).toEqual([
			{
				theme: "Reliability",
				principle: "Commit checkpoints before external calls",
				ids: ["video", "other"]
			}
		]);
		const initialCalls = calls;
		expect((await reduce(candidates, "Creator", notes, undefined, options)).out).toEqual(
			result.out
		);
		expect(calls).toBe(initialCalls);
	} finally {
		f.cleanup();
	}
});

test("changed notes invalidate comparisons but retain successful synthesis checkpoints", async () => {
	const f = fixture();
	try {
		let syntheses = 0,
			comparisons = 0;
		const options: DistillOptions = {
			profile,
			manifest: f.manifest,
			call: async (prompt) => {
				if (prompt.startsWith("Merge useful")) {
					syntheses++;
					return answer({
						rooms: [
							{
								room: "craft",
								principles: [{ theme: "Topic", principle: "Use checkpoints", ids: ["video"] }],
								halalNotes: []
							}
						]
					});
				}
				comparisons++;
				return answer({ duplicate: prompt.includes("now covered") });
			}
		};
		expect(
			(
				await reduce(
					[candidate],
					"Creator",
					[{ path: "craft/field-notes.md", text: "unrelated" }],
					undefined,
					options
				)
			).out?.rooms[0].principles
		).toHaveLength(1);
		expect(
			(
				await reduce(
					[candidate],
					"Creator",
					[{ path: "craft/field-notes.md", text: "now covered" }],
					undefined,
					options
				)
			).out?.rooms[0].principles
		).toEqual([]);
		expect(syntheses).toBe(1);
		expect(comparisons).toBe(2);
	} finally {
		f.cleanup();
	}
});

test("cross-room routing retains each intended room and shares the citation union", async () => {
	const result = await reduce(
		[candidate, { ...candidate, sourceId: "other" }],
		"Creator",
		[],
		undefined,
		{
			profile,
			call: async (prompt) => {
				if (prompt.startsWith("Merge useful"))
					return answer({
						rooms: [
							{
								room: "content",
								principles: [
									{ theme: "Planning", principle: "Prepare reusable checklists", ids: ["video"] }
								],
								halalNotes: []
							},
							{
								room: "craft",
								principles: [
									{ theme: "Planning", principle: "Prepare reusable checklists", ids: ["other"] }
								],
								halalNotes: ["General permissible workflow advice"]
							}
						]
					});
				return answer({ match: 0 });
			}
		}
	);
	expect(result.out?.rooms.map((r) => r.room)).toEqual(["content", "craft"]);
	for (const room of result.out!.rooms) expect(room.principles[0].ids).toEqual(["video", "other"]);
	expect(result.out?.rooms[1].halalNotes).toEqual(["General permissible workflow advice"]);
});

test("oversized input cannot bypass the complete assembled prompt budget", async () => {
	let calls = 0;
	const result = await agentJson(
		"🙂".repeat(10000),
		(v): v is Candidate[] => validCandidates(v, new Set(["video"])),
		"extract",
		{
			profile,
			call: async () => {
				calls++;
				return answer([]);
			}
		}
	);
	expect(result.error).toContain("exceeds");
	expect(calls).toBe(0);
});

test("a run pins its first resolved model, including when resuming cached responses", async () => {
	const f = fixture();
	try {
		const opts: DistillOptions = { profile, manifest: f.manifest, call: async () => answer([]) };
		const valid = (value: unknown): value is Candidate[] =>
			validCandidates(value, new Set(["video"]));
		expect((await agentJson("first prompt", valid, "pin-first", opts)).obj).toEqual([]);
		const drift = await agentJson("second prompt", valid, "pin-next", {
			...opts,
			call: async () => ({ ...answer([]), reportedModel: "different-model" })
		});
		expect(drift.error).toContain("Run model changed");
		expect(
			f.manifest.getCheckpoint<{ reportedModel: string }>("resolved-model")?.reportedModel
		).toBe("exact-model");
		f.manifest.checkpoint("resolved-model", { reportedModel: "changed-model" });
		expect((await agentJson("first prompt", valid, "pin-first", opts)).error).toContain(
			"Run model changed"
		);
	} finally {
		f.cleanup();
	}
});

test("control characters in published model fields retry instead of poisoning the cache", async () => {
	const f = fixture();
	try {
		let calls = 0;
		const out = {
			rooms: [
				{
					room: "content",
					principles: [{ theme: "Work", principle: "Keep useful notes", ids: ["video"] }],
					halalNotes: ["A useful note"]
				}
			]
		};
		const valid = (value: unknown): value is typeof out =>
			validReduction(value, new Set(["video"]));
		const options: DistillOptions = {
			profile,
			manifest: f.manifest,
			call: async () => {
				calls++;
				return answer(
					calls < 3
						? {
								rooms: [
									{
										...out.rooms[0],
										halalNotes: [calls === 1 ? "A useful\tnote" : "A useful\u0000note"]
									}
								]
							}
						: out
				);
			}
		};
		expect((await agentJson("control fixture", valid, "control", options)).obj).toEqual(out);
		expect(calls).toBe(3);
		expect((await agentJson("control fixture", valid, "control", options)).obj).toEqual(out);
		expect(calls).toBe(3);
	} finally {
		f.cleanup();
	}
});
