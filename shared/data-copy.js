// "Copy data from the demo" (D58): what the owner can pick, shared by the API
// (validation), the worker (plan) and the panel (labels). Pure data.
import { z } from "zod";

// In the order the worker copies them.
export const COPY_GROUPS = [
  "details",
  "settings",
  "printers",
  "menu",
  "staff",
  "customers",
  "orders",
  "tables",
  "expenses",
  "bookings",
];
// Groups the "From date" applies to; the others are copied whole (current state).
export const DATED_GROUPS = ["customers", "orders", "expenses", "bookings"];
export const COPY_LABELS = {
  details: "Cafe details",
  settings: "Bill & print settings",
  printers: "Printers",
  menu: "Menu",
  staff: "Staff logins",
  customers: "Customers & dues",
  orders: "Bills",
  tables: "Tables",
  expenses: "Expenses",
  bookings: "Bookings",
};
// Fixed note codes a run can report (never free text).
export const COPY_NOTES = [
  "telegram",
  "device-printers",
  "images",
  "older-customers",
  "open-orders",
  "old-open-orders",
  "undated",
  "index-skipped",
];
// "Blocked" counts: records the new POS made itself (ids the old database
// lacks; after a copy, only those made since) or changed since the last copy.
export const COPY_BLOCKERS = ["orders", "customers", "payments", "expenses"];
// What the new POS must have first: its admin login (go-live seeds it) when
// staff logins are copied; its settings document when only one settings part
// is copied (the POS fills defaults only when it creates the document).
export const COPY_NEEDS = ["admin", "settings"];

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
// The cafe day starts at 00:00 India time.
export const dayStart = (day) => new Date(`${day}T00:00:00+05:30`);
export const realDay = (day) =>
  DAY_RE.test(day) &&
  !Number.isNaN(dayStart(day).getTime()) &&
  new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;

export const copyParamsSchema = z
  .object({
    from: z
      .string()
      .refine(realDay, "Pick a valid date.")
      .refine((day) => day >= "2020-01-01", "Pick a date after 2020."),
    groups: z
      .array(z.enum(COPY_GROUPS))
      .min(1, "Pick at least one kind of data.")
      .max(COPY_GROUPS.length)
      .refine((list) => new Set(list).size === list.length, "Duplicate kind."),
  })
  .strict();
// Canonical order, so the same choice always compares equal.
export const sortGroups = (groups) =>
  COPY_GROUPS.filter((group) => groups.includes(group));
