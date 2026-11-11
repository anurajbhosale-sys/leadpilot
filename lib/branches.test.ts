import { describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ db: {} })); // the pure lookup needs no database
const { matchBranchByZip, normalizeZip } = await import("./branches");

const branches = [
  { id: 1, name: "Austin North", zipCodes: ["78727", "78728"] },
  { id: 2, name: "Denver Metro", zipCodes: ["80202"] },
];

describe("ZIP to branch lookup", () => {
  it("finds the branch that serves a ZIP", () => {
    expect(matchBranchByZip(branches, "78728")?.name).toBe("Austin North");
    expect(matchBranchByZip(branches, "80202")?.name).toBe("Denver Metro");
  });

  it("handles ZIP+4 and whitespace", () => {
    expect(normalizeZip(" 78727-1234 ")).toBe("78727");
    expect(matchBranchByZip(branches, "78727-1234")?.id).toBe(1);
  });

  it("returns null for an unknown ZIP", () => {
    expect(matchBranchByZip(branches, "10001")).toBeNull();
  });
});
