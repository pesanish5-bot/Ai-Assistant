import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MarkdownVault, parseVaultMarkdown, VaultValidationError } from "../core/vault.ts";

test("Markdown Vault initializes, validates, searches, indexes, and preserves history", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ultron-markdown-vault-"));
  let now = new Date("2026-08-11T08:00:00.000Z");
  const vault = new MarkdownVault(directory, { now: () => new Date(now), timezone: "UTC" });

  try {
    await vault.initialize();
    assert.deepEqual(
      (await readdir(directory)).sort(),
      ["AGENTS.md", "CHANGELOG.md", "INDEX.md", "outputs", "raw", "wiki"],
    );

    const raw = await vault.captureRaw({
      title: "Workflow interview",
      summary: "Original workflow answers captured without rewriting.",
      content: "Original wording stays here.",
      tags: ["workflow", "interview"],
    });
    assert.equal(raw.slug, "2026-08-11-workflow-interview");
    assert.equal(parseVaultMarkdown(await readFile(raw.filePath, "utf8")).metadata.type, "raw");

    const created = await vault.upsertWiki({
      slug: "memory-design",
      title: "Memory Design",
      summary: "Human-readable persistence architecture for Ultron.",
      content: "The Markdown Vault is canonical.",
      tags: ["ultron", "memory"],
      wikilinks: [raw.slug],
      data: { status: "active" },
    });
    assert.match(created.content, /\[\[2026-08-11-workflow-interview\]\]/);

    const changelogBeforeUpdate = await readFile(path.join(directory, "CHANGELOG.md"), "utf8");
    now = new Date("2026-08-12T09:30:00.000Z");
    const updated = await vault.upsertWiki({
      slug: "memory-design",
      title: "Memory Design",
      summary: "Human-readable persistence architecture for Ultron.",
      content: "The Markdown Vault is canonical and Git-friendly.",
      tags: ["ultron", "memory", "architecture"],
      wikilinks: [raw.slug],
      data: { status: "active" },
    });
    assert.equal(updated.createdAt, created.createdAt);
    assert.equal(updated.updatedAt, "2026-08-12T09:30:00.000Z");
    assert.notEqual(updated.updatedAt, created.updatedAt);
    assert.ok((await readFile(path.join(directory, "CHANGELOG.md"), "utf8")).startsWith(changelogBeforeUpdate));

    now = new Date("2026-08-12T10:00:00.000Z");
    const unchanged = await vault.upsertWiki({
      slug: "memory-design",
      title: "Memory Design",
      summary: "Human-readable persistence architecture for Ultron.",
      content: "The Markdown Vault is canonical and Git-friendly.",
      tags: ["ultron", "memory", "architecture"],
      wikilinks: [raw.slug],
      data: { status: "active" },
    });
    assert.equal(unchanged.updatedAt, updated.updatedAt);

    const firstOutput = await vault.writeOutput({
      title: "Daily plan 2026-08-12",
      topic: "daily-plan",
      type: "daily-plan",
      kind: "daily_plan",
      summary: "The three highest-priority outcomes for today.",
      content: "1. Finish the Markdown memory layer.",
      tags: ["plan"],
      wikilinks: ["memory-design"],
    });
    const secondOutput = await vault.writeOutput({
      title: "Daily plan 2026-08-12",
      topic: "daily-plan",
      type: "daily-plan",
      kind: "daily_plan",
      summary: "A second plan generated on the same day.",
      content: "1. Validate the Markdown memory layer.",
      tags: ["plan"],
    });
    assert.equal(firstOutput.slug, "2026-08-12-daily-plan");
    assert.equal(secondOutput.slug, "2026-08-12-daily-plan-02");
    assert.notEqual(await readFile(firstOutput.filePath, "utf8"), await readFile(secondOutput.filePath, "utf8"));

    assert.equal((await vault.search({ text: "Git-friendly" }))[0]?.slug, "memory-design");
    assert.equal((await vault.search({ tags: ["architecture"] }))[0]?.slug, "memory-design");
    assert.equal((await vault.search({ kind: "daily_plan" })).length, 2);

    const index = await readFile(path.join(directory, "INDEX.md"), "utf8");
    assert.match(index, /## Wiki[\s\S]*\[\[memory-design\]\] — Human-readable persistence/);
    assert.match(index, /## Recent Outputs[\s\S]*\[\[2026-08-12-daily-plan-02\]\]/);
    assert.match(index, /## Raw[\s\S]*\[\[2026-08-11-workflow-interview\]\]/);
    assert.deepEqual(await vault.validateAll(), []);

    const invalidPath = path.join(directory, "wiki", "invalid.md");
    await writeFile(invalidPath, "---\ntitle: Missing fields\ntags: not-a-list\n---\n", "utf8");
    const issues = await vault.validateAll();
    assert.equal(issues.length, 1);
    assert.match(issues[0].messages.join(" "), /missing required frontmatter field type/);
    assert.match(issues[0].messages.join(" "), /tags must be a list/);
    assert.throws(
      () => parseVaultMarkdown("No frontmatter", "invalid.md"),
      (error: unknown) => error instanceof VaultValidationError,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
