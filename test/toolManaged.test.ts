import { describe, expect, it } from "vitest";
import { classify } from "../src/cli-core/classify";
import fixture from "./fixtures/tool-managed.json";

// The same examples are checked against the Rust hard block in src-tauri/src/safety.rs (#31).
// "developer" is the category these paths get; "system" would return before the tool rules.
describe("tool-managed paths (shared with safety.rs)", () => {
  it.each(fixture.system)("$path is system", ({ path, dir }) => {
    expect(classify({ path, size: 1, dir }, "developer").verdict).toBe("system");
  });
  it.each(fixture.notSystem)("$path is not system", ({ path, dir }) => {
    expect(classify({ path, size: 1, dir }, "developer").verdict).not.toBe("system");
  });
});
