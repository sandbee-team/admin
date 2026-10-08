import { randomUUID } from "node:crypto";
export async function audit(
  db,
  session,
  actor,
  action,
  resource,
  resourceId,
  detail = "",
) {
  await db.collection("audit_events").insertOne(
    {
      _id: randomUUID(),
      actorId: actor?._id || "system",
      actorName: actor?.name || "System",
      action,
      resource,
      resourceId,
      detail,
      createdAt: new Date(),
    },
    { session },
  );
}
