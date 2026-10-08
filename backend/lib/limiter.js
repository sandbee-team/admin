import { digest } from "./crypto.js";
import { HttpError } from "./errors.js";
export async function consume(db, key, limit, windowMs) {
  const now = Date.now(),
    bucket = Math.floor(now / windowMs);
  const id = digest(`${key}:${bucket}`);
  let row;
  try {
    row = await db.collection("rate_limits").findOneAndUpdate(
      { _id: id },
      {
        $inc: { count: 1 },
        $setOnInsert: { expiresAt: new Date((bucket + 2) * windowMs) },
      },
      { upsert: true, returnDocument: "after" },
    );
  } catch (error) {
    if (error.code !== 11000) throw error;
    row = await db
      .collection("rate_limits")
      .findOneAndUpdate(
        { _id: id },
        { $inc: { count: 1 } },
        { returnDocument: "after" },
      );
  }
  if (row.count > limit)
    throw new HttpError(
      429,
      "Too many requests. Please wait before trying again.",
    );
}
