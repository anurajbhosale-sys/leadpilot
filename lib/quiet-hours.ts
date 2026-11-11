import type { BusinessHours } from "@/db/schema";

// Used when a lead has no branch (ZIP not served): weekdays 8am-6pm Central.
export const DEFAULT_TIME_ZONE = "America/Chicago";
export const DEFAULT_BUSINESS_HOURS: BusinessHours = Object.fromEntries(
  ["1", "2", "3", "4", "5"].map((d) => [d, { open: "08:00", close: "18:00" }]),
);

/**
 * When may we text this customer? Now, if the branch is open in its own time zone;
 * otherwise the next time it opens (e.g. a 9pm lead is held until 8am the next business day).
 */
export function nextSendTime(now: Date, hours: BusinessHours, timeZone: string): Date {
  const today = localDate(now, timeZone);

  for (let dayOffset = 0; dayOffset < 8; dayOffset++) {
    // Date.UTC rolls over month/year boundaries for us
    const day = new Date(Date.UTC(today.year, today.month - 1, today.day + dayOffset));
    const window = hours[String(day.getUTCDay())];
    if (!window) continue; // closed that day

    const open = zonedTime(day, window.open, timeZone);
    const close = zonedTime(day, window.close, timeZone);
    if (now >= open && now < close) return now; // open right now
    if (now < open) return open; // next opening
  }
  return now; // no hours configured at all: don't hold forever
}

/** The calendar date it is right now in `timeZone`. */
function localDate(at: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric" })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

/** How far `timeZone` is ahead of UTC at a given instant, in ms (negative for the Americas). */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    })
      .formatToParts(at)
      .map((x) => [x.type, Number(x.value)]),
  );
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** The instant when the wall clock in `timeZone` shows `hhmm` on `day` (a UTC-midnight date). */
function zonedTime(day: Date, hhmm: string, timeZone: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  const wallClock = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h, m);
  // Guess with the offset at that moment, then correct once in case a DST change sits in between.
  let utc = wallClock - zoneOffsetMs(new Date(wallClock), timeZone);
  utc = wallClock - zoneOffsetMs(new Date(utc), timeZone);
  return new Date(utc);
}
