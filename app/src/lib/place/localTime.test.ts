import { describe, expect, test } from "vitest";
import { fromLocal, localDate, localMinutes, noonToday, offsetLabel } from "./index";

const TAIPEI = { utcOffsetMin: 8 * 60 };
const NEW_YORK_WINTER = { utcOffsetMin: -5 * 60 };
const KOLKATA = { utcOffsetMin: 5 * 60 + 30 };

describe("local time at a fixed offset", () => {
  test("round-trips a date and minute of day at +08:00", () => {
    const ms = fromLocal("2026-06-21", 9 * 60 + 15, TAIPEI);
    expect(new Date(ms).toISOString()).toBe("2026-06-21T01:15:00.000Z");
    expect(localDate(ms, TAIPEI)).toBe("2026-06-21");
    expect(localMinutes(ms, TAIPEI)).toBe(555);
  });

  test("round-trips at a negative offset and a half-hour one", () => {
    for (const place of [NEW_YORK_WINTER, KOLKATA]) {
      const ms = fromLocal("2026-01-10", 23 * 60 + 45, place);
      expect(localDate(ms, place)).toBe("2026-01-10");
      expect(localMinutes(ms, place)).toBe(23 * 60 + 45);
    }
    expect(new Date(fromLocal("2026-01-10", 0, KOLKATA)).toISOString()).toBe("2026-01-09T18:30:00.000Z");
  });

  test("a late-evening UTC instant is already tomorrow at +08:00", () => {
    const ms = Date.parse("2026-06-21T20:00:00Z");
    expect(localDate(ms, TAIPEI)).toBe("2026-06-22");
    expect(localMinutes(ms, TAIPEI)).toBe(4 * 60);
  });

  test("noonToday is noon of the local date", () => {
    const now = Date.parse("2026-09-24T17:30:00Z"); // 01:30 on the 25th at +08:00
    expect(new Date(noonToday(TAIPEI, now)).toISOString()).toBe("2026-09-25T04:00:00.000Z");
    // …but still the 24th at −05:00.
    expect(new Date(noonToday(NEW_YORK_WINTER, now)).toISOString()).toBe("2026-09-24T17:00:00.000Z");
  });
});

describe("offsetLabel", () => {
  test("reads as a readout shows it", () => {
    expect(offsetLabel(TAIPEI)).toBe("+08");
    expect(offsetLabel(NEW_YORK_WINTER)).toBe("-05");
    expect(offsetLabel(KOLKATA)).toBe("+05:30");
    expect(offsetLabel({ utcOffsetMin: 0 })).toBe("+00");
  });
});
