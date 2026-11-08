import assert from "node:assert/strict";
import test from "node:test";
import { MemoryActionLog } from "../core/actionLog.ts";
import { MemoryLogger } from "../core/observability.ts";
import {
  MemoryPermissionGrantStore,
  PermissionConfirmationError,
  PermissionRequiredError,
  PermissionService,
  TrustedWriteConfirmationRequiredError,
} from "../core/permissions.ts";
import { ToolRegistry, type ToolInvocationRequest } from "../core/tools.ts";

async function captureChallenge(operation: () => Promise<unknown>): Promise<PermissionRequiredError> {
  try {
    await operation();
    assert.fail("Expected permission to be required.");
  } catch (error) {
    assert.ok(error instanceof PermissionRequiredError);
    return error;
  }
}

function invocation(
  requestId: string,
  message: string,
  confirmationId?: string,
): ToolInvocationRequest {
  return {
    requestId,
    message,
    ...(confirmationId ? { confirmationId } : {}),
  };
}

test("loopback confirmationId cannot unlock writes without a trusted stamp", async () => {
  const actionLog = new MemoryActionLog();
  const permissions = new PermissionService(new MemoryPermissionGrantStore(), 60_000, {
    enableTrustedWrites: true,
    actionLog,
  });
  const tools = new ToolRegistry(permissions, new MemoryLogger());
  let executions = 0;
  tools.register<{ text: string }, string>({
    name: "example.write",
    description: "Write something reversible.",
    risk: "reversible_write",
    permissionScope: "example:write",
    async execute(input) {
      executions += 1;
      return input.text;
    },
  });

  const challenge = await captureChallenge(() =>
    tools.invoke("example.write", { text: "draft" }, invocation("r1", "Write a draft")),
  );
  await assert.rejects(
    tools.invoke(
      "example.write",
      { text: "draft" },
      invocation("r2", "Write a draft", challenge.challenge.id),
    ),
    /trusted confirmation channel/,
  );
  assert.equal(executions, 0);
  assert.equal(actionLog.entries.at(-1)?.decision, "rejected");
});

test("authenticated UI stamp allows a bound reversible write once", async () => {
  const actionLog = new MemoryActionLog();
  const permissions = new PermissionService(new MemoryPermissionGrantStore(), 60_000, {
    enableTrustedWrites: true,
    actionLog,
  });
  const tools = new ToolRegistry(permissions, new MemoryLogger());
  tools.register<{ text: string }, string>({
    name: "example.write",
    description: "Write something reversible.",
    risk: "reversible_write",
    permissionScope: "example:write",
    async execute(input) {
      return input.text;
    },
  });

  const first = await captureChallenge(() =>
    tools.invoke("example.write", { text: "ok" }, invocation("r1", "Write ok")),
  );
  const decided = await permissions.decideWrite({
    challengeId: first.challenge.id,
    approve: true,
    method: "authenticated_ui",
  });
  assert.equal(decided.stamped, true);
  assert.equal(
    await tools.invoke(
      "example.write",
      { text: "ok" },
      invocation("r2", "Write ok", first.challenge.id),
    ),
    "ok",
  );
  assert.equal(actionLog.entries.at(-1)?.decision, "approved");
  assert.equal(actionLog.entries.at(-1)?.method, "authenticated_ui");

  await assert.rejects(
    tools.invoke(
      "example.write",
      { text: "ok" },
      invocation("r3", "Write ok", first.challenge.id),
    ),
    PermissionConfirmationError,
  );
});

test("voice stamp requires speaker verification and rejects consequential writes", async () => {
  const permissions = new PermissionService(new MemoryPermissionGrantStore(), 60_000, {
    enableTrustedWrites: true,
    actionLog: new MemoryActionLog(),
  });
  const tools = new ToolRegistry(permissions, new MemoryLogger());
  tools.register<{ text: string }, void>({
    name: "example.reversible",
    description: "Reversible write.",
    risk: "reversible_write",
    permissionScope: "example:reversible",
    async execute() {},
  });
  tools.register<{ text: string }, void>({
    name: "example.consequential",
    description: "Consequential write.",
    risk: "consequential_write",
    permissionScope: "example:consequential",
    async execute() {},
  });

  const reversible = await captureChallenge(() =>
    tools.invoke("example.reversible", { text: "a" }, invocation("r1", "Do reversible")),
  );
  await assert.rejects(
    permissions.decideWrite({
      challengeId: reversible.challenge.id,
      approve: true,
      method: "voice",
      speakerVerified: false,
    }),
    /speaker verification/,
  );
  await permissions.decideWrite({
    challengeId: reversible.challenge.id,
    approve: true,
    method: "voice",
    speakerVerified: true,
  });
  await tools.invoke(
    "example.reversible",
    { text: "a" },
    invocation("r2", "Do reversible", reversible.challenge.id),
  );

  const consequential = await captureChallenge(() =>
    tools.invoke("example.consequential", { text: "b" }, invocation("r3", "Do consequential")),
  );
  await assert.rejects(
    permissions.decideWrite({
      challengeId: consequential.challenge.id,
      approve: true,
      method: "voice",
      speakerVerified: true,
    }),
    /only allowed for reversible/,
  );
});

test("challenge tampering and expired writes fail closed", async () => {
  const permissions = new PermissionService(new MemoryPermissionGrantStore(), 1, {
    enableTrustedWrites: true,
    actionLog: new MemoryActionLog(),
  });
  const tools = new ToolRegistry(permissions, new MemoryLogger());
  tools.register<{ value: number }, number>({
    name: "example.write",
    description: "Write a number.",
    risk: "reversible_write",
    permissionScope: "example:write",
    async execute(input) {
      return input.value;
    },
  });

  const challenge = await captureChallenge(() =>
    tools.invoke("example.write", { value: 1 }, invocation("r1", "Write one")),
  );
  await permissions.decideWrite({
    challengeId: challenge.challenge.id,
    approve: true,
    method: "authenticated_ui",
  });
  await assert.rejects(
    tools.invoke(
      "example.write",
      { value: 2 },
      invocation("r2", "Write one", challenge.challenge.id),
    ),
    /did not match/,
  );

  const shortLived = new PermissionService(new MemoryPermissionGrantStore(), 1, {
    enableTrustedWrites: true,
  });
  const shortTools = new ToolRegistry(shortLived, new MemoryLogger());
  shortTools.register<{ value: number }, number>({
    name: "example.write",
    description: "Write a number.",
    risk: "reversible_write",
    permissionScope: "example:write",
    async execute(input) {
      return input.value;
    },
  });
  const expired = await captureChallenge(() =>
    shortTools.invoke("example.write", { value: 3 }, invocation("r3", "Write three")),
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  await assert.rejects(
    shortLived.decideWrite({
      challengeId: expired.challenge.id,
      approve: true,
      method: "authenticated_ui",
    }),
    /expired/,
  );
});

test("writes stay disabled when trusted writes are not enabled", async () => {
  const tools = new ToolRegistry(
    new PermissionService(new MemoryPermissionGrantStore()),
    new MemoryLogger(),
  );
  tools.register<{ text: string }, void>({
    name: "example.write",
    description: "Write.",
    risk: "consequential_write",
    permissionScope: "example:write",
    async execute() {},
  });
  await assert.rejects(
    tools.invoke("example.write", { text: "x" }, invocation("r1", "Write")),
    TrustedWriteConfirmationRequiredError,
  );
});
