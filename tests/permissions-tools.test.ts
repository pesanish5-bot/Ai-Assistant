import assert from "node:assert/strict";
import test from "node:test";
import { MemoryLogger } from "../core/observability.ts";
import {
  MemoryPermissionGrantStore,
  PermissionConfirmationError,
  PermissionRequiredError,
  PermissionService,
  TrustedWriteConfirmationRequiredError,
  digestPermissionInput,
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
  rememberPermission = false,
): ToolInvocationRequest {
  return {
    requestId,
    message,
    ...(confirmationId ? { confirmationId } : {}),
    ...(rememberPermission ? { rememberPermission: true } : {}),
  };
}

test("read confirmation is bound to tool, input, and original normalized message", async () => {
  const permissions = new PermissionService(new MemoryPermissionGrantStore());
  const tools = new ToolRegistry(permissions, new MemoryLogger());
  let executions = 0;
  tools.register<{ value: number }, number>({
    name: "example.read",
    description: "Read an example value.",
    risk: "read",
    permissionScope: "example:read",
    async execute(input) {
      executions += 1;
      return input.value;
    },
  });

  const first = await captureChallenge(() =>
    tools.invoke("example.read", { value: 7 }, invocation("request-1", "Read value seven")),
  );
  assert.equal(executions, 0);
  assert.equal(
    await tools.invoke(
      "example.read",
      { value: 7 },
      invocation("request-2", "  READ   value seven  ", first.challenge.id),
    ),
    7,
  );
  assert.equal(executions, 1);

  const inputBound = await captureChallenge(() =>
    tools.invoke("example.read", { value: 8 }, invocation("request-3", "Read a value")),
  );
  await assert.rejects(
    tools.invoke(
      "example.read",
      { value: 9 },
      invocation("request-4", "Read a value", inputBound.challenge.id),
    ),
    PermissionConfirmationError,
  );
  await assert.rejects(
    tools.invoke(
      "example.read",
      { value: 8 },
      invocation("request-5", "Read a value", inputBound.challenge.id),
    ),
    /Unknown permission confirmation/,
  );

  const messageBound = await captureChallenge(() =>
    tools.invoke("example.read", { value: 10 }, invocation("request-6", "Read ten")),
  );
  await assert.rejects(
    tools.invoke(
      "example.read",
      { value: 10 },
      invocation("request-7", "Read something else", messageBound.challenge.id),
    ),
    /did not match this tool invocation/,
  );
  assert.equal(executions, 1);
});

test("remembered read grants remain scope-specific and revocable", async () => {
  const store = new MemoryPermissionGrantStore();
  const permissions = new PermissionService(store);
  const tools = new ToolRegistry(permissions, new MemoryLogger());
  tools.register<{ value: number }, number>({
    name: "example.read",
    description: "Read an example value.",
    risk: "read",
    permissionScope: "example:read",
    async execute(input) {
      return input.value;
    },
  });

  const challenge = await captureChallenge(() =>
    tools.invoke("example.read", { value: 8 }, invocation("request-1", "Read eight")),
  );
  assert.equal(
    await tools.invoke(
      "example.read",
      { value: 8 },
      invocation("request-2", "Read eight", challenge.challenge.id, true),
    ),
    8,
  );
  assert.equal(
    await tools.invoke("example.read", { value: 9 }, invocation("request-3", "Read nine")),
    9,
  );
  assert.deepEqual((await permissions.grants()).map((grant) => grant.scope), ["example:read"]);
  assert.equal(await permissions.revoke("example:read"), true);
  await captureChallenge(() =>
    tools.invoke("example.read", { value: 10 }, invocation("request-4", "Read ten")),
  );
});

test("loopback/UI confirmation cannot enable write tools", async () => {
  const tools = new ToolRegistry(
    new PermissionService(new MemoryPermissionGrantStore()),
    new MemoryLogger(),
  );
  let executions = 0;
  tools.register<{ text: string }, void>({
    name: "example.write",
    description: "Perform a consequential external write.",
    risk: "consequential_write",
    permissionScope: "example:write",
    async execute() {
      executions += 1;
    },
  });

  await assert.rejects(
    tools.invoke(
      "example.write",
      { text: "different action" },
      invocation("request-1", "Do a write", "attacker-supplied-confirmation", true),
    ),
    TrustedWriteConfirmationRequiredError,
  );
  assert.equal(executions, 0);
});

test("permission input digest is stable for JSON object key order", () => {
  assert.equal(
    digestPermissionInput({ beta: [2, 3], alpha: 1 }),
    digestPermissionInput({ alpha: 1, beta: [2, 3] }),
  );
  assert.notEqual(digestPermissionInput({ value: 1 }), digestPermissionInput({ value: 2 }));
});

test("tool registry rejects malformed and duplicate tool definitions", () => {
  const tools = new ToolRegistry(
    new PermissionService(new MemoryPermissionGrantStore()),
    new MemoryLogger(),
  );
  const definition = {
    name: "example.read",
    description: "Read an example value.",
    risk: "read" as const,
    permissionScope: "example:read",
    async execute() {
      return true;
    },
  };
  tools.register(definition);
  assert.throws(() => tools.register(definition), /already registered/);
  assert.throws(() => tools.register({ ...definition, name: "Invalid Tool" }), /Malformed tool name/);
});
