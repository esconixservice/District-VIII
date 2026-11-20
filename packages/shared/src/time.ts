import type { IsoDate, OperatingHours } from "./dto";

/**
 * Business-day helpers. All arena logic runs in Asia/Kolkata, which has a
 * fixed UTC+05:30 offset and no daylight saving, so plain offset arithmetic
 * is exact and needs no time-zone database.
 */

export const ARENA_TIME_ZONE = "Asia/Kolkata";
const IST_OFFSET_MS = 330 * 60_000;
export const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface IstParts {
  date: IsoDate;
  hour: number;
  minute: number;
}

function toIsoDate(utcMidnight: Date): IsoDate {
  return utcMidnight.toISOString().slice(0, 10);
}

function parseIsoDate(date: IsoDate): number {
  const [year, month, day] = date.split("-").map(Number);
  return Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1);
}

/** Wall-clock date and time in Asia/Kolkata for an instant. */
export function istParts(instant: Date | number): IstParts {
  const shifted = new Date(+instant + IST_OFFSET_MS);
  return {
    date: toIsoDate(shifted),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

export function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) return false;
  return toIsoDate(new Date(parseIsoDate(value))) === value;
}

export function addDays(date: IsoDate, days: number): IsoDate {
  return toIsoDate(new Date(parseIsoDate(date) + days * DAY_MS));
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function diffDays(from: IsoDate, to: IsoDate): number {
  return Math.round((parseIsoDate(to) - parseIsoDate(from)) / DAY_MS);
}

/** True when the session runs past midnight (e.g. 12 PM to 4 AM). Equal hours mean open 24h. */
export function isOvernight(hours: OperatingHours): boolean {
  return hours.closeHour <= hours.openHour;
}

/** Grid step: every bookable cell is 30 minutes. Start hours may end in .5 (20.5 = 8:30 PM). */
export const SLOT_STEP_HOURS = 0.5;
/** Booking lengths customers and admins can choose, in hours. */
export const BOOKING_DURATIONS = [0.5, 1] as const;
export type BookingDuration = (typeof BOOKING_DURATIONS)[number];
export const DEFAULT_BOOKING_DURATION: BookingDuration = 1;

export function isBookingDuration(value: number): value is BookingDuration {
  return (BOOKING_DURATIONS as readonly number[]).includes(value);
}

/** Normalizes a clock hour (may be fractional) into [0, 24). */
function wrapHour(hour: number): number {
  return ((hour % 24) + 24) % 24;
}

/** Hours in one business session (24 when open round the clock). */
export function sessionSpanHours(hours: OperatingHours): number {
  return isOvernight(hours) ? 24 - hours.openHour + hours.closeHour : hours.closeHour - hours.openHour;
}

/** Start hours of every 30-minute cell in one business session, in order. */
export function slotHours(hours: OperatingHours): number[] {
  const span = sessionSpanHours(hours);
  const result: number[] = [];
  for (let offset = 0; offset + SLOT_STEP_HOURS <= span; offset += SLOT_STEP_HOURS) {
    result.push(wrapHour(hours.openHour + offset));
  }
  return result;
}

export function isOperatingSlot(startHour: number, hours: OperatingHours): boolean {
  return slotHours(hours).includes(startHour);
}

/** True when a booking of `durationHours` starting at `startHour` ends at or before closing. */
export function fitsInSession(startHour: number, durationHours: number, hours: OperatingHours): boolean {
  if (!isOperatingSlot(startHour, hours)) return false;
  return wrapHour(startHour - hours.openHour) + durationHours <= sessionSpanHours(hours);
}

/** Start hours of the 30-minute cells a booking covers: 20 for 1 h -> [20, 20.5]. */
export function coveredStartHours(startHour: number, durationHours: number): number[] {
  const count = Math.max(1, Math.round(durationHours / SLOT_STEP_HOURS));
  return Array.from({ length: count }, (_, index) => wrapHour(startHour + index * SLOT_STEP_HOURS));
}

/** Clock-based cell id (0 to 47) of a 30-minute cell: 20.5 -> 41. Stable even if opening hours change. */
export function cellOf(startHour: number): number {
  return Math.round(wrapHour(startHour) / SLOT_STEP_HOURS) % 48;
}

/** Cell ids a booking occupies; stored on bookings for the overlap guard. */
export function slotCells(startHour: number, durationHours: number): number[] {
  return coveredStartHours(startHour, durationHours).map(cellOf);
}

/**
 * The business date an instant belongs to. Hours after midnight but before
 * closing (e.g. 1 AM) belong to the previous day's session.
 */
export function businessDateOf(instant: Date | number, hours: OperatingHours): IsoDate {
  const { date, hour } = istParts(instant);
  return isOvernight(hours) && hour < hours.closeHour ? addDays(date, -1) : date;
}

/** Real start instant of a slot. After-midnight slots fall on the next calendar day. */
export function slotStart(businessDate: IsoDate, startHour: number, hours: OperatingHours): Date {
  const dayOffset = isOvernight(hours) && startHour < hours.openHour ? 1 : 0;
  return new Date(parseIsoDate(businessDate) + dayOffset * DAY_MS + startHour * HOUR_MS - IST_OFFSET_MS);
}

export function slotEnd(businessDate: IsoDate, startHour: number, hours: OperatingHours): Date {
  return new Date(slotStart(businessDate, startHour, hours).getTime() + SLOT_STEP_HOURS * HOUR_MS);
}

/** The 30-minute cell running at `instant`, or null when the arena is closed. */
export function currentSlot(
  instant: Date | number,
  hours: OperatingHours,
): { businessDate: IsoDate; startHour: number } | null {
  const businessDate = businessDateOf(instant, hours);
  const time = +instant;
  for (const startHour of slotHours(hours)) {
    const start = slotStart(businessDate, startHour, hours).getTime();
    if (time >= start && time < start + SLOT_STEP_HOURS * HOUR_MS) {
      return { businessDate, startHour };
    }
  }
  return null;
}

/** Business dates customers may book: today's session plus the following days in the window. */
export function bookableDates(instant: Date | number, hours: OperatingHours, windowDays: number): IsoDate[] {
  const today = businessDateOf(instant, hours);
  return Array.from({ length: Math.max(1, windowDays) }, (_, index) => addDays(today, index));
}

// ---------- Formatting ----------

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** 20 -> "8 PM", 20.5 -> "8:30 PM", 0 -> "12 AM". */
export function formatHour(hour: number): string {
  const totalMinutes = Math.round(wrapHour(hour) * 60) % (24 * 60);
  const whole = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const suffix = whole < 12 ? "AM" : "PM";
  const display = whole % 12 === 0 ? 12 : whole % 12;
  return minutes === 0 ? `${display} ${suffix}` : `${display}:${String(minutes).padStart(2, "0")} ${suffix}`;
}

/** 0.5 -> "30 min", 1 -> "1 hr", 2 -> "2 hrs". */
export function formatDuration(durationHours: number): string {
  if (durationHours < 1) return `${Math.round(durationHours * 60)} min`;
  return durationHours === 1 ? "1 hr" : `${durationHours} hrs`;
}

export function formatSlotRange(startHour: number, durationHours: number): string {
  return `${formatHour(startHour)} – ${formatHour(startHour + durationHours)}`;
}

/** "HH:MM" (24h) in Asia/Kolkata. */
export function formatIstClock(instant: Date | number | string): string {
  const time = typeof instant === "string" ? Date.parse(instant) : +instant;
  if (Number.isNaN(time)) return "--:--";
  const { hour, minute } = istParts(time);
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** "Thu 23 Oct". */
export function formatShortDate(date: IsoDate): string {
  const value = new Date(parseIsoDate(date));
  return `${WEEKDAYS[value.getUTCDay()]} ${value.getUTCDate()} ${MONTHS[value.getUTCMonth()]}`;
}

/** "Today", "Tomorrow" or "Thu 23 Oct", relative to the current business date. */
export function formatBusinessDate(date: IsoDate, today: IsoDate): string {
  const offset = diffDays(today, date);
  if (offset === 0) return "Today";
  if (offset === 1) return "Tomorrow";
  if (offset === -1) return "Yesterday";
  return formatShortDate(date);
}

/** A slot stays bookable this long after it starts, so someone walking in at 8:10 can still take the 8 PM slot. */
export const LATE_BOOKING_GRACE_MINUTES = 15;

/** True once a slot can no longer be booked. */
export function isSlotPast(startsAt: Date | number, instant: Date | number): boolean {
  return +instant >= +startsAt + LATE_BOOKING_GRACE_MINUTES * 60_000;
}
