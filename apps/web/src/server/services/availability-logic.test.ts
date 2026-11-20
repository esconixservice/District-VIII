import { describe, expect, it } from "vitest";
import {
  businessDateOf,
  currentSlot,
  fitsInSession,
  formatHour,
  formatSlotRange,
  type OperatingHours,
  slotCells,
  slotHours,
  slotStart,
} from "@district-viii/shared";
import {
  buildSlots,
  isUnitFreeNow,
  nextFreeAt,
  SlotIndex,
  slotState,
  summarize,
  type UnitState,
} from "./availability-logic";

const HOURS: OperatingHours = {
  openHour: 12,
  closeHour: 4,
  slotDurationHours: 1,
};
const DATE = "2026-10-21";

/** Instant for an IST wall-clock time on DATE (hour >= 24 rolls into the next day). */
const ist = (hour: number, minute = 0) =>
  new Date(Date.UTC(2026, 9, 21, hour, minute) - 330 * 60_000);

const free = (id = "u1"): UnitState => ({
  id,
  status: "free",
  busyUntil: null,
});
const emptyIndex = new SlotIndex([], []);

describe("business-day helpers (Asia/Kolkata)", () => {
  it("lists 32 half-hour slots from 12 PM to 4 AM", () => {
    const hours = slotHours(HOURS);
    expect(hours).toHaveLength(32);
    expect(hours.slice(0, 4)).toEqual([12, 12.5, 13, 13.5]);
    expect(hours.slice(-4)).toEqual([2, 2.5, 3, 3.5]);
  });

  it("puts slots between midnight and closing in the previous business day", () => {
    expect(businessDateOf(ist(26), HOURS)).toBe(DATE); // 2 AM on the 22nd
    expect(businessDateOf(ist(28), HOURS)).toBe("2026-10-22"); // 4 AM: closed, next session
    expect(businessDateOf(ist(13), HOURS)).toBe(DATE);
  });

  it("places after-midnight slots on the next calendar day", () => {
    expect(slotStart(DATE, 1, HOURS).toISOString()).toBe(ist(25).toISOString());
    expect(slotStart(DATE, 20, HOURS).toISOString()).toBe(
      ist(20).toISOString(),
    );
  });

  it("finds the running slot, or null when closed", () => {
    expect(currentSlot(ist(20, 45), HOURS)).toEqual({
      businessDate: DATE,
      startHour: 20.5,
    });
    expect(currentSlot(ist(20, 10), HOURS)).toEqual({
      businessDate: DATE,
      startHour: 20,
    });
    expect(currentSlot(ist(27, 10), HOURS)).toEqual({
      businessDate: DATE,
      startHour: 3,
    });
    expect(currentSlot(ist(9), HOURS)).toBeNull();
  });

  it("supports daytime-only hours (grid is always 30 minutes)", () => {
    const hours = slotHours({ openHour: 10, closeHour: 13, slotDurationHours: 2 });
    expect(hours).toEqual([10, 10.5, 11, 11.5, 12, 12.5]);
  });

  it("checks a booking fits before closing", () => {
    expect(fitsInSession(3.5, 0.5, HOURS)).toBe(true);
    expect(fitsInSession(3.5, 1, HOURS)).toBe(false);
    expect(fitsInSession(3, 1, HOURS)).toBe(true);
    expect(fitsInSession(11.5, 0.5, HOURS)).toBe(false); // before opening
  });

  it("maps bookings to clock-based half-hour cells", () => {
    expect(slotCells(20, 1)).toEqual([40, 41]);
    expect(slotCells(20.5, 0.5)).toEqual([41]);
    expect(slotCells(23.5, 1)).toEqual([47, 0]);
  });

  it("formats half hours", () => {
    expect(formatHour(20)).toBe("8 PM");
    expect(formatHour(20.5)).toBe("8:30 PM");
    expect(formatHour(0.5)).toBe("12:30 AM");
    expect(formatSlotRange(20.5, 0.5)).toBe("8:30 PM – 9 PM");
    expect(formatSlotRange(23.5, 1)).toBe("11:30 PM – 12:30 AM");
  });
});

describe("slotState", () => {
  const state = (overrides: Partial<Parameters<typeof slotState>[0]> = {}) =>
    slotState({
      unit: free(),
      businessDate: DATE,
      startHour: 21,
      hours: HOURS,
      index: emptyIndex,
      now: ist(18),
      ...overrides,
    });

  it("is available by default", () => {
    expect(state()).toBe("available");
  });

  it("is past once the late-booking grace (15 min) has elapsed", () => {
    expect(state({ now: ist(21, 14) })).toBe("available");
    expect(state({ now: ist(21, 15) })).toBe("past");
  });

  it("reports maintenance before bookings", () => {
    const index = new SlotIndex(
      [{ unitId: "u1", businessDate: DATE, startHour: 21, status: "approved" }],
      [],
    );
    expect(state({ unit: { ...free(), status: "maintenance" }, index })).toBe(
      "maintenance",
    );
  });

  it("distinguishes approved (booked) from pending holds", () => {
    const approved = new SlotIndex(
      [{ unitId: "u1", businessDate: DATE, startHour: 21, status: "approved" }],
      [],
    );
    const pending = new SlotIndex(
      [{ unitId: "u1", businessDate: DATE, startHour: 21, status: "pending" }],
      [],
    );
    expect(state({ index: approved })).toBe("booked");
    expect(state({ index: pending })).toBe("pending");
  });

  it("holds both half hours of a 1-hour booking and only one of a 30-minute booking", () => {
    const index = new SlotIndex(
      [
        { unitId: "u1", businessDate: DATE, startHour: 20, durationHours: 1, status: "approved" },
        { unitId: "u1", businessDate: DATE, startHour: 22.5, durationHours: 0.5, status: "pending" },
      ],
      [],
    );
    expect(state({ index, startHour: 20 })).toBe("booked");
    expect(state({ index, startHour: 20.5 })).toBe("booked");
    expect(state({ index, startHour: 21 })).toBe("available");
    expect(state({ index, startHour: 22 })).toBe("available");
    expect(state({ index, startHour: 22.5 })).toBe("pending");
    expect(state({ index, startHour: 23 })).toBe("available");
  });

  it("treats admin-blocked slots as busy", () => {
    const index = new SlotIndex(
      [],
      [{ unitId: "u1", businessDate: DATE, startHour: 21 }],
    );
    expect(state({ index })).toBe("busy");
  });

  it("marks slots the unit is still busy into", () => {
    const unit: UnitState = {
      id: "u1",
      status: "busy",
      busyUntil: ist(21, 15),
    };
    expect(state({ unit, startHour: 21 })).toBe("busy");
    expect(state({ unit, startHour: 22 })).toBe("available");
  });

  it("ignores holds on other units and dates", () => {
    const index = new SlotIndex(
      [
        { unitId: "u2", businessDate: DATE, startHour: 21, status: "approved" },
        {
          unitId: "u1",
          businessDate: "2026-10-22",
          startHour: 21,
          status: "approved",
        },
      ],
      [],
    );
    expect(state({ index })).toBe("available");
  });

  it("builds a full grid with ISO start and end times", () => {
    const slots = buildSlots({
      unit: free(),
      businessDate: DATE,
      hours: HOURS,
      index: emptyIndex,
      now: ist(18),
    });
    expect(slots).toHaveLength(32);
    expect(slots[0]).toMatchObject({ startHour: 12, state: "past" });
    expect(slots[17]).toMatchObject({
      startHour: 20.5,
      state: "available",
      startsAt: ist(20, 30).toISOString(),
      endsAt: ist(21).toISOString(),
    });
  });
});

describe("summary and next free time", () => {
  it("counts a unit as taken when the current slot is held", () => {
    const index = new SlotIndex(
      [{ unitId: "u1", businessDate: DATE, startHour: 20, status: "pending" }],
      [],
    );
    expect(isUnitFreeNow(free(), HOURS, index, ist(20, 10))).toBe(false);
    expect(isUnitFreeNow(free("u2"), HOURS, index, ist(20, 10))).toBe(true);
  });

  it("walks past busy time and consecutive held slots", () => {
    const unit: UnitState = {
      id: "u1",
      status: "busy",
      busyUntil: ist(20, 40),
    };
    const index = new SlotIndex(
      [
        { unitId: "u1", businessDate: DATE, startHour: 20, status: "approved" },
        { unitId: "u1", businessDate: DATE, startHour: 21, status: "pending" },
      ],
      [{ unitId: "u1", businessDate: DATE, startHour: 22 }],
    );
    // 1-hour holds at 8 and 9 PM, a blocked 10:00 half hour: free from 10:30.
    expect(nextFreeAt(unit, HOURS, index, ist(20, 5))?.toISOString()).toBe(
      ist(22, 30).toISOString(),
    );
  });

  it("never frees a unit in maintenance", () => {
    expect(
      nextFreeAt(
        { ...free(), status: "maintenance" },
        HOURS,
        emptyIndex,
        ist(20),
      ),
    ).toBeNull();
  });

  it("reports nextFreeAt only when nothing is free", () => {
    const units: UnitState[] = [
      { id: "u1", status: "busy", busyUntil: ist(21, 30) },
      { id: "u2", status: "busy", busyUntil: ist(20, 50) },
    ];
    expect(summarize(units, HOURS, emptyIndex, ist(20))).toEqual({
      total: 2,
      free: 0,
      nextFreeAt: ist(20, 50).toISOString(),
    });
    expect(
      summarize([...units, free("u3")], HOURS, emptyIndex, ist(20)),
    ).toEqual({ total: 3, free: 1 });
  });
});
