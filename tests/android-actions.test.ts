import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createAndroidAppOpenTool,
  createAndroidBatteryTool,
  createAndroidMediaKeyTool,
  parseBatteryDump,
} from "../core/integrations/android.ts";
import { parseComputerAllowlist } from "../core/integrations/allowlist.ts";

test("battery dump parser extracts level and charging without serials", () => {
  const parsed = parseBatteryDump("Current Battery Service state:\n  level: 87\n  scale: 100\n  status: 2\n  plugged: 2\n");
  assert.deepEqual(parsed, { levelPercent: 87, charging: true });
  assert.equal(JSON.stringify(parsed).includes("serial"), false);
});

test("Android action tools validate allowlist and key codes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ultron-adb-"));
  const previous = process.env.ULTRON_ADB_PATH;
  try {
    const adbPath = path.join(directory, "adb.exe");
    await writeFile(adbPath, "");
    process.env.ULTRON_ADB_PATH = adbPath;

    const allowlist = parseComputerAllowlist({
      apps: [],
      mediaProviders: ["youtube"],
      androidPackages: [{ id: "youtube", label: "YouTube", package: "com.google.android.youtube" }],
    });
    const calls: string[][] = [];
    const run = async (_file: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "devices") return { stdout: "List of devices attached\nSERIAL device\n", stderr: "" };
      if (args.includes("dumpsys")) return { stdout: "  level: 50\n  status: 3\n", stderr: "" };
      return { stdout: "", stderr: "" };
    };

    const battery = createAndroidBatteryTool({ run });
    const status = await battery.execute({ target: "android" }, { requestId: "t", logger: {} as never });
    assert.equal(status.levelPercent, 50);
    assert.equal(status.charging, false);

    const open = createAndroidAppOpenTool(".ultron", { loadAllowlist: async () => allowlist, run });
    const opened = await open.execute({ packageId: "youtube" }, { requestId: "t", logger: {} as never });
    assert.equal(opened.packageName, "com.google.android.youtube");
    assert.ok(opened.note.includes("unlocked"));
    assert.ok(calls.some((args) => args.includes("monkey") && args.includes("com.google.android.youtube")));

    const media = createAndroidMediaKeyTool({ run });
    const keyed = await media.execute({ action: "play_pause" }, { requestId: "t", logger: {} as never });
    assert.equal(keyed.keyCode, 85);
    await assert.rejects(open.execute({ packageId: "instagram" }, { requestId: "t", logger: {} as never }), /allowlist/);
  } finally {
    if (previous === undefined) delete process.env.ULTRON_ADB_PATH;
    else process.env.ULTRON_ADB_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
