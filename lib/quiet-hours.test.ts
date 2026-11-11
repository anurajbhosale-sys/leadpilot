import { describe, expect, it } from "vitest";
import { nextSendTime } from "./quiet-hours";

// Austin North: Mon-Fri 08:00-18:00, Sat 09:00-14:00, closed Sunday (America/Chicago).
const weekdays = Object.fromEntries(["1", "2", "3", "4", "5"].map((d) => [d, { open: "08:00", close: "18:00" }]));
const austin = { ...weekdays, "6": { open: "09:00", close: "14:00" } };
const tz = "America/Chicago";

// November 2026 is standard time in Chicago: UTC-6. Nov 11 2026 is a Wednesday.
describe("nextSendTime (quiet hours)", () => {
  it("sends immediately during business hours", () => {
    const now = new Date("2026-11-11T16:00:00Z"); // Wed 10:00 local
    expect(nextSendTime(now, austin, tz)).toEqual(now);
  });

  it("holds an evening lead until 8am the next morning", () => {
    const now = new Date("2026-11-12T03:30:00Z"); // Wed 21:30 local
    expect(nextSendTime(now, austin, tz)).toEqual(new Date("2026-11-12T14:00:00Z")); // Thu 08:00 local
  });

  it("holds an early-morning lead until opening the same day", () => {
    const now = new Date("2026-11-11T11:00:00Z"); // Wed 05:00 local
    expect(nextSendTime(now, austin, tz)).toEqual(new Date("2026-11-11T14:00:00Z"));
  });

  it("uses Saturday hours, then skips closed Sunday to Monday", () => {
    const satAfterClose = new Date("2026-11-14T21:00:00Z"); // Sat 15:00 local, closed at 14:00
    expect(nextSendTime(satAfterClose, austin, tz)).toEqual(new Date("2026-11-16T14:00:00Z")); // Mon 08:00
    const friNight = new Date("2026-11-14T02:00:00Z"); // Fri 20:00 local
    expect(nextSendTime(friNight, austin, tz)).toEqual(new Date("2026-11-14T15:00:00Z")); // Sat 09:00
  });

  it("uses the branch's own time zone", () => {
    // 15:30 UTC is 10:30 in New York (open) but 08:30 in Denver (opens at 09:00)
    const now = new Date("2026-11-11T15:30:00Z");
    const nineToFive = Object.fromEntries(["1", "2", "3", "4", "5"].map((d) => [d, { open: "09:00", close: "17:00" }]));
    expect(nextSendTime(now, nineToFive, "America/New_York")).toEqual(now);
    expect(nextSendTime(now, nineToFive, "America/Denver")).toEqual(new Date("2026-11-11T16:00:00Z"));
  });

  it("handles the DST change (clocks go back Nov 1 2026)", () => {
    const sat = new Date("2026-10-31T23:00:00Z"); // Sat 18:00 CDT, after close
    // Next opening is Mon Nov 2 08:00 CST = 14:00 UTC (not 13:00, which it would be under CDT)
    expect(nextSendTime(sat, austin, tz)).toEqual(new Date("2026-11-02T14:00:00Z"));
  });
});
