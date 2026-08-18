import assert from "node:assert/strict";
import test from "node:test";
import { shouldHandleHudShortcut } from "../interaction/gesture/keyboardControls.ts";

const event = (target: unknown, overrides = {}) => ({
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  target: target as EventTarget,
  ...overrides,
});

test("HUD shortcuts are ignored while the user types", () => {
  assert.equal(shouldHandleHudShortcut(event({ tagName: "INPUT" })), false);
  assert.equal(shouldHandleHudShortcut(event({ tagName: "textarea" })), false);
  assert.equal(shouldHandleHudShortcut(event({ tagName: "DIV", isContentEditable: true })), false);
});

test("HUD shortcuts accept the non-editable HUD and reject modifiers", () => {
  assert.equal(shouldHandleHudShortcut(event({ tagName: "DIV" })), true);
  assert.equal(shouldHandleHudShortcut(event({ tagName: "DIV" }, { ctrlKey: true })), false);
});
