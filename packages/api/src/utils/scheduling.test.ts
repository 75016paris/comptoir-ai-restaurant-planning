import { describe, test, expect } from "bun:test";
import {
  timeToMinutes,
  serviceMinutes,
  serviceHours,
  timesOverlap,
  computeOvertimeBreakdown,
  isoDayOfWeek,
  getMonday,
  weekDates,
  fmtDate,
  isoWeekNum,
  isoWeekYear,
  getMonthWeeks,
  countDaysInRange,
  computeRestBetweenDays,
  maxNonOverlappingShifts,
} from "./scheduling";

// ── timeToMinutes ──

describe("timeToMinutes", () => {
  test("midnight", () => expect(timeToMinutes("00:00")).toBe(0));
  test("noon", () => expect(timeToMinutes("12:00")).toBe(720));
  test("23:30", () => expect(timeToMinutes("23:30")).toBe(1410));
  test("07:30", () => expect(timeToMinutes("07:30")).toBe(450));
});

// ── serviceMinutes / serviceHours ──

describe("serviceMinutes", () => {
  test("normal day service", () => expect(serviceMinutes("09:00", "15:00")).toBe(360));
  test("evening service", () => expect(serviceMinutes("18:00", "23:30")).toBe(330));
  test("overnight service 22:00-02:00", () => expect(serviceMinutes("22:00", "02:00")).toBe(240));
  test("overnight service 18:00-01:00", () => expect(serviceMinutes("18:00", "01:00")).toBe(420));
  test("full 24h returns 0 (same time)", () => expect(serviceMinutes("09:00", "09:00")).toBe(0));
});

describe("serviceHours", () => {
  test("7.5h service", () => expect(serviceHours("07:30", "15:00")).toBe(7.5));
  test("overnight 7h", () => expect(serviceHours("18:00", "01:00")).toBe(7));
});

// ── timesOverlap ──

describe("timesOverlap", () => {
  // Normal daytime services
  test("identical services overlap", () =>
    expect(timesOverlap("09:00", "15:00", "09:00", "15:00")).toBe(true));
  test("partial overlap", () =>
    expect(timesOverlap("09:00", "15:00", "14:00", "20:00")).toBe(true));
  test("no overlap — sequential", () =>
    expect(timesOverlap("09:00", "15:00", "15:00", "20:00")).toBe(false));
  test("no overlap — gap between", () =>
    expect(timesOverlap("09:00", "12:00", "14:00", "18:00")).toBe(false));
  test("contained service", () =>
    expect(timesOverlap("09:00", "18:00", "11:00", "14:00")).toBe(true));

  // Overnight services
  test("two overnight services overlap", () =>
    expect(timesOverlap("22:00", "02:00", "23:00", "03:00")).toBe(true));
  test("overnight vs early morning — overlap", () =>
    expect(timesOverlap("22:00", "02:00", "01:00", "06:00")).toBe(true));
  test("overnight vs day — no overlap", () =>
    expect(timesOverlap("22:00", "02:00", "09:00", "15:00")).toBe(false));
  test("evening ending at midnight vs overnight", () =>
    expect(timesOverlap("18:00", "23:30", "23:00", "02:00")).toBe(true));
  test("day service vs overnight — no overlap", () =>
    expect(timesOverlap("07:00", "15:00", "22:00", "02:00")).toBe(false));
});

// ── computeOvertimeBreakdown ──

describe("computeOvertimeBreakdown", () => {
  test("35h — no overtime", () => {
    const r = computeOvertimeBreakdown(35);
    expect(r.overtime).toBe(0);
    expect(r.rate110).toBe(0);
    expect(r.rate120).toBe(0);
    expect(r.rate150).toBe(0);
  });

  test("39h — exactly at threshold, no overtime", () => {
    const r = computeOvertimeBreakdown(39);
    expect(r.overtime).toBe(0);
  });

  test("41h — 2h at 110%", () => {
    const r = computeOvertimeBreakdown(41);
    expect(r.overtime).toBe(2);
    expect(r.rate110).toBe(2);
    expect(r.rate120).toBe(0);
    expect(r.rate150).toBe(0);
  });

  test("43h — 4h at 110%, boundary", () => {
    const r = computeOvertimeBreakdown(43);
    expect(r.overtime).toBe(4);
    expect(r.rate110).toBe(4);
    expect(r.rate120).toBe(0);
    expect(r.rate150).toBe(0);
  });

  test("45h — 4h at 110% + 2h at 120%", () => {
    const r = computeOvertimeBreakdown(45);
    expect(r.overtime).toBe(6);
    expect(r.rate110).toBe(4);
    expect(r.rate120).toBe(2);
    expect(r.rate150).toBe(0);
  });

  test("47h — 4h at 110% + 4h at 120%, boundary", () => {
    const r = computeOvertimeBreakdown(47);
    expect(r.overtime).toBe(8);
    expect(r.rate110).toBe(4);
    expect(r.rate120).toBe(4);
    expect(r.rate150).toBe(0);
  });

  test("50h — 4h at 110% + 4h at 120% + 3h at 150%", () => {
    const r = computeOvertimeBreakdown(50);
    expect(r.overtime).toBe(11);
    expect(r.rate110).toBe(4);
    expect(r.rate120).toBe(4);
    expect(r.rate150).toBe(3);
  });

  test("48h — legal max — 4+4+1", () => {
    const r = computeOvertimeBreakdown(48);
    expect(r.overtime).toBe(9);
    expect(r.rate110).toBe(4);
    expect(r.rate120).toBe(4);
    expect(r.rate150).toBe(1);
  });

  test("tiers always sum to overtime", () => {
    for (const h of [39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 50, 55]) {
      const r = computeOvertimeBreakdown(h);
      expect(r.rate110 + r.rate120 + r.rate150).toBe(r.overtime);
    }
  });

  test("custom threshold 35h", () => {
    const r = computeOvertimeBreakdown(39, 35);
    expect(r.overtime).toBe(4);
    expect(r.rate110).toBe(4);
  });
});

// ── isoDayOfWeek ──

describe("isoDayOfWeek", () => {
  test("Monday", () => expect(isoDayOfWeek("2026-03-30")).toBe(1));
  test("Friday", () => expect(isoDayOfWeek("2026-04-03")).toBe(5));
  test("Sunday", () => expect(isoDayOfWeek("2026-04-05")).toBe(7));
  test("Saturday", () => expect(isoDayOfWeek("2026-04-04")).toBe(6));
});

// ── getMonday ──

describe("getMonday", () => {
  test("from Wednesday", () => expect(getMonday("2026-04-01")).toBe("2026-03-30"));
  test("from Monday returns same", () => expect(getMonday("2026-03-30")).toBe("2026-03-30"));
  test("from Sunday", () => expect(getMonday("2026-04-05")).toBe("2026-03-30"));
});

// ── weekDates ──

describe("weekDates", () => {
  test("generates 7 days Mon-Sun", () => {
    const dates = weekDates("2026-03-30");
    expect(dates).toHaveLength(7);
    expect(dates[0]).toBe("2026-03-30"); // Mon
    expect(dates[6]).toBe("2026-04-05"); // Sun
  });

  test("crosses month boundary", () => {
    const dates = weekDates("2026-03-30");
    expect(dates[2]).toBe("2026-04-01"); // Wed = Apr 1
  });
});

// ── fmtDate ──

describe("fmtDate", () => {
  test("formats correctly", () => {
    expect(fmtDate(new Date(2026, 2, 5, 12))).toBe("2026-03-05");
  });
  test("pads single digits", () => {
    expect(fmtDate(new Date(2026, 0, 9, 12))).toBe("2026-01-09");
  });
});

// ── getMonthWeeks ──

describe("getMonthWeeks", () => {
  test("March 2026 — starts on Sunday, 5 weeks", () => {
    const weeks = getMonthWeeks(2026, 2); // 0-indexed month
    expect(weeks.length).toBeGreaterThanOrEqual(4);
    // First week's Monday should be on or before March 1
    expect(weeks[0].from <= "2026-03-01").toBe(true);
    // Last week's Sunday should be on or after March 31
    expect(weeks[weeks.length - 1].to >= "2026-03-31").toBe(true);
  });

  test("each week is exactly 7 days apart", () => {
    const weeks = getMonthWeeks(2026, 2);
    for (let i = 1; i < weeks.length; i++) {
      const prev = new Date(weeks[i - 1].from + "T12:00:00");
      const curr = new Date(weeks[i].from + "T12:00:00");
      const diff = (curr.getTime() - prev.getTime()) / (24 * 60 * 60 * 1000);
      expect(diff).toBe(7);
    }
  });
});

// ── countDaysInRange ──

describe("countDaysInRange", () => {
  test("full week Mon-Sun, clamped to same month", () => {
    // Mon Mar 30 - Sun Apr 5, clamped to March
    const count = countDaysInRange("2026-03-30", "2026-04-05", "2026-03-01", "2026-03-31");
    // Mar 30 (Mon) + Mar 31 (Tue) = 2 days (no Sunday in range)
    expect(count).toBe(2);
  });

  test("excludes Sundays", () => {
    // Full week within same month: Mon-Sun
    const count = countDaysInRange("2026-03-02", "2026-03-08", "2026-03-01", "2026-03-31");
    // Mon-Sat = 6 (Sunday excluded)
    expect(count).toBe(6);
  });

  test("single day — Sunday excluded", () => {
    // 2026-03-15 is a Sunday → excluded
    const count = countDaysInRange("2026-03-15", "2026-03-15", "2026-03-01", "2026-03-31");
    expect(count).toBe(0);
  });

  test("single day — weekday counted", () => {
    // 2026-03-16 is Monday
    const count = countDaysInRange("2026-03-16", "2026-03-16", "2026-03-01", "2026-03-31");
    expect(count).toBe(1);
  });
});

// ── computeRestBetweenDays ──

describe("computeRestBetweenDays", () => {
  test("normal close then early open — 11h rest", () => {
    const rest = computeRestBetweenDays(
      [{ startTime: "18:00", endTime: "23:00" }],
      [{ startTime: "10:00", endTime: "15:00" }],
      1,
    );
    expect(rest).toBe(11);
  });

  test("late close then early open — tight rest", () => {
    const rest = computeRestBetweenDays(
      [{ startTime: "18:00", endTime: "23:30" }],
      [{ startTime: "07:30", endTime: "15:00" }],
      1,
    );
    expect(rest).toBe(8); // 00:30 gap + 7:30 = 8h
  });

  test("overnight service on day1 — very short rest", () => {
    const rest = computeRestBetweenDays(
      [{ startTime: "22:00", endTime: "02:00" }], // ends at 26:00 (2am next day)
      [{ startTime: "09:00", endTime: "15:00" }],
      1,
    );
    // Last end = 26*60 = 1560min, toMidnight = 1440-1560 = -120 → but overnight means end > 24h
    // Actually: endMin = 120 (02:00), startMin = 22*60=1320, 120 < 1320 so endMin += 1440 = 1560
    // toMidnight = 1440 - 1560 = -120... that's wrong.
    // The function uses 24*60 - lastEndMinutes where lastEndMinutes can be > 1440
    // 1440 - 1560 = -120, fromMidnight = 540, fullDays = 0
    // total = -120 + 540 = 420 min = 7h. That's correct: 02:00→09:00 = 7h
    expect(rest).toBe(7);
  });

  test("consecutive days with gap", () => {
    const rest = computeRestBetweenDays(
      [{ startTime: "09:00", endTime: "17:00" }],
      [{ startTime: "09:00", endTime: "17:00" }],
      2, // 2 calendar days apart (1 full rest day between)
    );
    // toMidnight = 1440 - 1020 = 420, fromMidnight = 540, fullDays = 1*1440 = 1440
    // total = 420 + 540 + 1440 = 2400 min = 40h
    expect(rest).toBe(40);
  });

  test("multiple services on day1 — uses latest end", () => {
    const rest = computeRestBetweenDays(
      [
        { startTime: "09:00", endTime: "15:00" },
        { startTime: "18:00", endTime: "23:30" },
      ],
      [{ startTime: "07:30", endTime: "15:00" }],
      1,
    );
    // Latest end = 23:30 (1410min), toMidnight = 30, fromMidnight = 450
    // rest = 30 + 450 = 480 min = 8h
    expect(rest).toBe(8);
  });

  test("HCR violation — less than 10h rest", () => {
    const rest = computeRestBetweenDays(
      [{ startTime: "16:00", endTime: "01:00" }], // overnight
      [{ startTime: "07:00", endTime: "15:00" }],
      1,
    );
    // end = 01:00 → overnight → 25*60 = 1500
    // toMidnight = 1440 - 1500 = -60, fromMidnight = 420
    // rest = -60 + 420 = 360 min = 6h — serious violation
    expect(rest).toBe(6);
  });
});

// ── isoWeekNum ──

describe("isoWeekNum", () => {
  test("known week number", () => {
    // 2026-01-01 is Thursday, ISO week 1
    expect(isoWeekNum("2026-01-01")).toBe(1);
  });

  test("late December can be week 1 of next year", () => {
    // 2025-12-29 is Monday of ISO week 1 of 2026
    expect(isoWeekNum("2025-12-29")).toBe(1);
  });

  test("late December can belong to the next ISO year", () => {
    expect(isoWeekYear("2025-12-29")).toBe(2026);
  });
});

// ── maxNonOverlappingShifts ──

const grandBrasserieTemplates = [
  { zone: "Matin", startTime: "06:00", endTime: "14:00" },   // 8h
  { zone: "Midi", startTime: "10:00", endTime: "16:00" },    // 6h
  { zone: "Après-midi", startTime: "14:00", endTime: "22:00" }, // 8h
  { zone: "Soir", startTime: "18:00", endTime: "01:00" },    // 7h
];

describe("maxNonOverlappingShifts", () => {
  test("all 4 overlapping zones — max 1 shift", () => {
    // Matin overlaps Midi, Midi overlaps AM, AM overlaps Soir
    // No pair is non-overlapping except Matin+Soir but 8+7=15h > 10h cap
    expect(maxNonOverlappingShifts(
      ["Matin", "Midi", "Après-midi", "Soir"],
      grandBrasserieTemplates,
    )).toBe(1);
  });

  test("single zone", () => {
    expect(maxNonOverlappingShifts(["Midi"], grandBrasserieTemplates)).toBe(1);
  });

  test("no zones", () => {
    expect(maxNonOverlappingShifts([], grandBrasserieTemplates)).toBe(0);
  });

  test("non-overlapping short zones fit 2 shifts", () => {
    const shortTemplates = [
      { zone: "A", startTime: "06:00", endTime: "10:00" },  // 4h
      { zone: "B", startTime: "10:00", endTime: "14:00" },  // 4h
      { zone: "C", startTime: "14:00", endTime: "18:00" },  // 4h
    ];
    // A+B don't overlap (10:00 == 10:00 is boundary), B+C same
    // A+C don't overlap. A+B = 8h, A+C = 8h, B+C = 8h — all fit in 10h
    // A+B+C = 12h > 10h cap
    expect(maxNonOverlappingShifts(["A", "B", "C"], shortTemplates)).toBe(2);
  });

  test("two non-overlapping zones within hours cap", () => {
    const templates = [
      { zone: "morning", startTime: "07:00", endTime: "12:00" }, // 5h
      { zone: "evening", startTime: "17:00", endTime: "22:00" }, // 5h
    ];
    // 5+5=10h, exactly at cap
    expect(maxNonOverlappingShifts(["morning", "evening"], templates)).toBe(2);
  });

  test("two non-overlapping zones exceeding hours cap", () => {
    const templates = [
      { zone: "morning", startTime: "06:00", endTime: "14:00" }, // 8h
      { zone: "evening", startTime: "16:00", endTime: "23:00" }, // 7h
    ];
    // 8+7=15h > 10h cap — only 1 fits
    expect(maxNonOverlappingShifts(["morning", "evening"], templates)).toBe(1);
  });

  test("unknown zone is skipped", () => {
    expect(maxNonOverlappingShifts(["nonexistent"], grandBrasserieTemplates)).toBe(0);
  });
});
