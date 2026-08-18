import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../core/config.ts";
import { MarkdownVault } from "../core/vault.ts";

test("configuration parses repositories without exposing a required token", () => {
  const config = loadConfig(
    {
      ULTRON_DATA_DIR: ".private-ultron",
      ULTRON_TIMEZONE: "Europe/London",
      ULTRON_GITHUB_REPOSITORIES: "owner/one, owner/two,owner/one",
    },
    "C:\\workspace",
  );

  assert.equal(config.dataDir, path.resolve("C:\\workspace", ".private-ultron"));
  assert.equal(config.vaultDir, path.resolve("C:\\workspace", ".private-ultron", "vault"));
  assert.equal(config.timezone, "Europe/London");
  assert.deepEqual(config.github.repositories, ["owner/one", "owner/two"]);
  assert.equal(config.github.token, undefined);
});

test("configuration keeps the default Vault inside ignored local state", () => {
  const config = loadConfig({}, "C:\\workspace");

  assert.equal(config.dataDir, path.resolve("C:\\workspace", ".ultron"));
  assert.equal(config.vaultDir, path.resolve("C:\\workspace", ".ultron", "vault"));
});

test("configuration permits an explicit private Vault override", () => {
  const config = loadConfig(
    { ULTRON_VAULT_DIR: "D:\\PrivateData\\ultron-vault" },
    "C:\\workspace",
  );

  assert.equal(config.vaultDir, path.resolve("D:\\PrivateData\\ultron-vault"));
});

test("the default private Vault initializes without repository templates", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ultron-private-vault-config-"));
  try {
    const config = loadConfig({}, directory);
    const vault = new MarkdownVault(config.vaultDir);

    await vault.initialize();

    assert.deepEqual(
      (await readdir(config.vaultDir)).sort(),
      ["AGENTS.md", "CHANGELOG.md", "INDEX.md", "outputs", "raw", "wiki"],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("configuration rejects malformed GitHub repository names", () => {
  assert.throws(
    () => loadConfig({ ULTRON_GITHUB_REPOSITORIES: "not-a-repository" }, "C:\\workspace"),
    /Expected owner\/repository/,
  );
});
