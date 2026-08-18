import assert from "node:assert/strict";
import test from "node:test";
import { isAllowedLocalHttpRequest } from "../core/localHttp.ts";

test("local runtime accepts loopback requests and rejects LAN or remote origins", () => {
  assert.equal(isAllowedLocalHttpRequest(new Request("http://localhost:3000/api/ultron")), true);
  assert.equal(isAllowedLocalHttpRequest(new Request("http://127.0.0.1:3000/api/ultron")), true);
  assert.equal(isAllowedLocalHttpRequest(new Request("http://[::1]:3000/api/ultron")), true);

  assert.equal(
    isAllowedLocalHttpRequest(
      new Request("http://localhost:3000/api/ultron", {
        headers: { origin: "http://127.0.0.1:3000" },
      }),
    ),
    true,
  );
  assert.equal(isAllowedLocalHttpRequest(new Request("http://192.168.1.20:3000/api/ultron")), false);
  assert.equal(
    isAllowedLocalHttpRequest(
      new Request("http://localhost:3000/api/ultron", {
        headers: { origin: "http://192.168.1.20:3000" },
      }),
    ),
    false,
  );
});
