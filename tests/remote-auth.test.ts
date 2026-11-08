import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DeviceTokenStore, hashDeviceToken, mintDeviceToken } from "../core/deviceAuth.ts";
import { authorizeRuntimeRequest, isTailscaleCgNatAddress } from "../core/localHttp.ts";

test("Tailscale CGNAT detection and device token hashing", () => {
  assert.equal(isTailscaleCgNatAddress("100.64.1.2"), true);
  assert.equal(isTailscaleCgNatAddress("100.128.1.2"), false);
  assert.equal(isTailscaleCgNatAddress("192.168.1.2"), false);
  const minted = mintDeviceToken();
  assert.equal(hashDeviceToken(minted.token), minted.record.hash);
  assert.notEqual(minted.token, minted.record.hash);
});

test("device token store verifies hashes only", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ultron-device-"));
  try {
    const store = new DeviceTokenStore(directory);
    const minted = await store.register("phone");
    assert.equal(await store.verify(minted.token), true);
    assert.equal(await store.verify("not-a-real-token-value-at-all-xxxx"), false);
    const listed = await store.list();
    assert.equal(listed.length, 1);
    assert.equal("token" in listed[0], false);
    assert.equal(await store.revoke(minted.id), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("authorizeRuntimeRequest accepts loopback and rejects plain LAN", async () => {
  const loopback = await authorizeRuntimeRequest(new Request("http://localhost:3000/api/ultron"));
  assert.equal(loopback.ok, true);
  if (loopback.ok) assert.equal(loopback.remote, false);

  const lan = await authorizeRuntimeRequest(new Request("http://192.168.1.20:3000/api/ultron"));
  assert.equal(lan.ok, false);
});
