import { expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createPalaceFixture, fixtureGit, hasPalacePrerequisite } from "./palace-fixture.ts";
import {
	loadPalaceSnapshot,
	publishBatch,
	sourceMappings,
	verifyPublication,
	type PublishInput
} from "../src/palace.ts";

const input = (base: string): PublishInput => ({
	room: "content",
	channel: "Creator",
	channelUrl: "https://youtube.com/@creator",
	dateStr: "2026-10-23",
	runId: "fixture-run-1",
	expectedBase: base,
	titles: new Map([
		["aaaaaaaaaaa", "Earlier"],
		["bbbbbbbbbbb", "New video"]
	]),
	principles: [
		{
			theme: "Useful",
			principle: "Keep a recoverable checkpoint.",
			ids: ["aaaaaaaaaaa", "bbbbbbbbbbb"]
		}
	],
	halalNotes: []
});

test("source mappings reuse existing global IDs and refuse ambiguous history", () => {
	expect(sourceMappings(['- **[M-007]** "A" — X · YouTube `aaaaaaaaaaa`'])).toEqual(
		new Map([["aaaaaaaaaaa", 7]])
	);
	expect(() =>
		sourceMappings([
			'- **[M7]** "A" — X · YouTube `aaaaaaaaaaa`',
			'- **[M8]** "A" — X · YouTube `aaaaaaaaaaa`'
		])
	).toThrow("Conflicting");
});

test.skipIf(!hasPalacePrerequisite)(
	"publication verifies remote rooms, recovers receipts, and preserves dirty foreign work",
	async () => {
		const f = createPalaceFixture();
		try {
			const initial = await loadPalaceSnapshot(f.source);
			expect(initial.notes.map((n) => n.path)).toContain("unrelated-room/field-notes.md");
			writeFileSync(join(f.source, "foreign.txt"), "foreign staged work\n");
			fixtureGit(f.source, "add", "foreign.txt");
			writeFileSync(
				join(f.source, "content", "field-notes.md"),
				readFileSync(join(f.source, "content", "field-notes.md"), "utf8") +
					"foreign unstaged work\n"
			);
			const foreign = fixtureGit(f.source, "diff", "HEAD");
			const status = fixtureGit(f.source, "status", "--porcelain=v1");
			const firstInput = input(initial.base);
			const first = await publishBatch(firstInput, f.options);
			expect(first.idToM).toEqual({ aaaaaaaaaaa: 7, bbbbbbbbbbb: 53 });
			expect(fixtureGit(f.source, "diff", "HEAD")).toBe(foreign);
			expect(fixtureGit(f.source, "status", "--porcelain=v1")).toBe(status);
			expect(fixtureGit(f.remote, "show", "main:content/field-notes.md")).toContain(first.marker);
			const recovered = await publishBatch(firstInput, f.options);
			expect(recovered.commit).toBe(first.commit);
			expect(fixtureGit(f.remote, "rev-list", "--count", "main")).toBe("2");
			const second = await publishBatch(
				{ ...firstInput, room: "craft", expectedBase: first.verifiedHead },
				f.options
			);
			expect(second.idToM).toEqual(first.idToM);
			expect((await verifyPublication(first, "Creator", f.source)).commit).toBe(first.commit);
			expect((await verifyPublication(second, "Creator", f.source)).commit).toBe(second.commit);
			expect(fixtureGit(f.remote, "show", "main:craft/field-notes.md")).toContain(
				"## ⚠️ Halal gate"
			);
			expect(fixtureGit(f.remote, "show", "main:content/field-notes.md")).not.toContain(
				"foreign unstaged"
			);
			expect(() => fixtureGit(f.remote, "show", "main:foreign.txt")).toThrow();
		} finally {
			rmSync(f.root, { recursive: true, force: true });
		}
	},
	60_000
);

test.skipIf(!hasPalacePrerequisite)(
	"publication rejects stale deduplication bases and tampered remote receipts",
	async () => {
		const f = createPalaceFixture();
		try {
			const initial = await loadPalaceSnapshot(f.source);
			const writer = join(f.root, "writer");
			fixtureGit(f.root, "clone", f.remote, writer);
			writeFileSync(join(writer, "other.md"), "Concurrent writer\n");
			fixtureGit(writer, "add", "other.md");
			fixtureGit(writer, "commit", "-m", "test: advance remote before publication");
			fixtureGit(writer, "push", "origin", "main");
			await expect(publishBatch(input(initial.base), f.options)).rejects.toThrow(
				"base changed since deduplication"
			);
			expect(fixtureGit(f.remote, "rev-list", "--count", "main")).toBe("2");
			const current = await loadPalaceSnapshot(f.source);
			const receipt = await publishBatch(input(current.base), f.options);
			fixtureGit(writer, "fetch", "origin");
			fixtureGit(writer, "merge", "--ff-only", "origin/main");
			const path = join(writer, "content", "field-notes.md");
			writeFileSync(
				path,
				readFileSync(path, "utf8").replace(
					"Keep a recoverable checkpoint.",
					"Changed after publication."
				)
			);
			fixtureGit(writer, "add", "content/field-notes.md");
			fixtureGit(writer, "commit", "-m", "test: alter published content");
			fixtureGit(writer, "push", "origin", "main");
			await expect(verifyPublication(receipt, "Creator", f.source)).rejects.toThrow(
				"content changed"
			);
		} finally {
			rmSync(f.root, { recursive: true, force: true });
		}
	},
	60_000
);

test("source mapping rejects reused IDs across different videos", () => {
	expect(() =>
		sourceMappings([
			'- **[M7]** "A" — X · YouTube `aaaaaaaaaaa`',
			'- **[M7]** "B" — X · YouTube `bbbbbbbbbbb`'
		])
	).toThrow("Ambiguous global");
});

test.skipIf(!hasPalacePrerequisite)(
	"unsafe model citations are refused before any remote mutation; metadata remains text",
	async () => {
		const f = createPalaceFixture();
		try {
			const base = (await loadPalaceSnapshot(f.source)).base;
			const bad = { ...input(base), halalNotes: ["Rejected a doubtful recommendation [M999]"] };
			await expect(publishBatch(bad, f.options)).rejects.toThrow("unsafe citation");
			expect(fixtureGit(f.remote, "rev-parse", "main")).toBe(base);
			const safe = {
				...input(base),
				titles: new Map([
					["aaaaaaaaaaa", "Earlier [M999]\n# Fake heading"],
					["bbbbbbbbbbb", "A `title` <!-- ytd:fake -->"]
				])
			};
			const receipt = await publishBatch(safe, f.options);
			const content = fixtureGit(f.remote, "show", "main:content/field-notes.md");
			expect(content).toContain("&#91;M999&#93;");
			expect(content).not.toContain("<!-- ytd:fake -->");
			await expect(verifyPublication(receipt, safe.channel, f.source)).resolves.toMatchObject({
				commit: receipt.commit
			});
		} finally {
			rmSync(f.root, { recursive: true, force: true });
		}
	},
	60_000
);

test.skipIf(!hasPalacePrerequisite)(
	"cancellation stops an active Palace transaction before the remote ref advances",
	async () => {
		const f = createPalaceFixture();
		try {
			const base = (await loadPalaceSnapshot(f.source)).base;
			const entered = join(f.root, "receive-entered");
			const hook = join(f.remote, "hooks", "pre-receive");
			writeFileSync(hook, `#!/bin/sh\nprintf entered > '${entered}'\nsleep 2\n`);
			chmodSync(hook, 0o755);
			const controller = new AbortController();
			const pending = publishBatch(input(base), { ...f.options, signal: controller.signal }).then(
				() => ({ failed: false }),
				() => ({ failed: true })
			);
			const deadline = Date.now() + 10_000;
			while (!existsSync(entered) && Date.now() < deadline) await Bun.sleep(10);
			expect(existsSync(entered)).toBe(true);
			controller.abort();
			expect((await pending).failed).toBe(true);
			expect(fixtureGit(f.remote, "rev-parse", "main")).toBe(base);
		} finally {
			rmSync(f.root, { recursive: true, force: true });
		}
	},
	30_000
);
