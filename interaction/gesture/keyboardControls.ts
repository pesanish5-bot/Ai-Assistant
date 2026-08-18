export interface KeyboardControlEventLike {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  target: EventTarget | null;
}

/** HUD shortcuts must never intercept ordinary typing or modified OS/browser keys. */
export function shouldHandleHudShortcut(event: KeyboardControlEventLike): boolean {
  if (event.altKey || event.ctrlKey || event.metaKey) return false;
  const target = event.target as
    | { tagName?: string; isContentEditable?: boolean; closest?: (selector: string) => unknown }
    | null;
  if (!target) return true;
  if (target.isContentEditable) return false;
  if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName?.toUpperCase() ?? "")) return false;
  return !target.closest?.('[contenteditable="true"]');
}
