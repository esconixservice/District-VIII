/**
 * One-off, idempotent migration for half-hour slots. Safe on production.
 *
 *   npm run migrate:half-hour -w @district-viii/web            # dry run: only reports
 *   npm run migrate:half-hour -w @district-viii/web -- --apply # writes
 *
 * 1. Backfills `cells` on bookings made before half-hour slots, so the
 *    `unique_active_booking_per_cell` index guards them too.
 * 2. Gives every on-the-hour blocked slot a matching :30 twin, so an hour an
 *    admin blocked stays fully blocked now that the grid is 30-minute cells.
 *
 * It never deletes anything and only touches documents that still need it, so
 * it can be re-run at any time (e.g. once more right after deploying).
 * Take an Atlas snapshot or mongodump before running with --apply.
 */
import { slotCells } from "@district-viii/shared";
import { loadEnvConfig } from "@next/env";
import mongoose from "mongoose";
import { BlockedSlotModel, type BlockedSlotRecord, BookingModel, type BookingRecord } from "@/server/models";

loadEnvConfig(process.cwd());

const apply = process.argv.includes("--apply");

function isDuplicateKey(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: number }).code === 11000;
}

async function backfillBookingCells(): Promise<void> {
  const rows = await BookingModel.find({ cells: { $exists: false } }, { startHour: 1, durationHours: 1, businessDate: 1, status: 1 })
    .lean<Pick<BookingRecord, "_id" | "startHour" | "durationHours" | "businessDate" | "status">[]>()
    .exec();
  console.log(`Bookings without cells: ${rows.length}`);
  let updated = 0;
  const conflicts: string[] = [];
  for (const row of rows) {
    const cells = slotCells(row.startHour, row.durationHours ?? 1);
    if (!apply) continue;
    try {
      // The filter keeps it idempotent if the app or another run filled it meanwhile.
      const result = await BookingModel.updateOne({ _id: row._id, cells: { $exists: false } }, { $set: { cells } }).exec();
      updated += result.modifiedCount;
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      // Two active bookings already overlapped (only possible if slot length was changed in the past). Leave it for a human.
      conflicts.push(`${String(row._id)} (${row.businessDate} ${row.startHour}h, ${row.status})`);
    }
  }
  if (apply) console.log(`  backfilled: ${updated}`);
  if (conflicts.length > 0) {
    console.warn(`  ${conflicts.length} booking(s) overlap another active booking and were left unchanged:`);
    for (const line of conflicts) console.warn(`    - ${line}`);
  }
}

async function addHalfHourBlockTwins(): Promise<void> {
  const blocks = await BlockedSlotModel.find({}).lean<BlockedSlotRecord[]>().exec();
  const existing = new Set(blocks.map((block) => `${String(block.unitId)}|${block.businessDate}|${block.startHour}`));
  const missing = blocks.filter(
    (block) => Number.isInteger(block.startHour) && !existing.has(`${String(block.unitId)}|${block.businessDate}|${block.startHour + 0.5}`),
  );
  console.log(`On-the-hour blocked slots missing their :30 twin: ${missing.length}`);
  if (!apply || missing.length === 0) return;
  const result = await BlockedSlotModel.bulkWrite(
    missing.map((block) => ({
      updateOne: {
        filter: { unitId: block.unitId, businessDate: block.businessDate, startHour: block.startHour + 0.5 },
        update: { $setOnInsert: { reason: block.reason } },
        upsert: true,
      },
    })),
    { ordered: false },
  );
  console.log(`  created: ${result.upsertedCount}`);
}

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("Set MONGODB_URI (apps/web/.env.local)");
  const host = uri.replace(/^mongodb(\+srv)?:\/\/([^@]*@)?/, "").split(/[/?]/)[0];
  console.log(`${apply ? "APPLYING" : "DRY RUN (pass --apply to write)"} against ${host}\n`);

  // Plain connect: no model.init(), so a dry run makes no writes or index builds.
  await mongoose.connect(uri, { bufferCommands: false, serverSelectionTimeoutMS: 8000, autoIndex: false, autoCreate: false });
  try {
    await backfillBookingCells();
    await addHalfHourBlockTwins();
  } finally {
    await mongoose.disconnect();
  }
  console.log("\nDone.");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
