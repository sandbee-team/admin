import { randomUUID } from "node:crypto";
// Control characters, line/paragraph separators and bidi controls are removed
// so a hostile header cannot forge or visually reorder audit rows.
const unsafe = (ch) => {
  const n = ch.codePointAt(0);
  return (
    n <= 0x1f ||
    (n >= 0x7f && n <= 0x9f) ||
    n === 0x61c ||
    n === 0x200e ||
    n === 0x200f ||
    n === 0x2028 ||
    n === 0x2029 ||
    (n >= 0x202a && n <= 0x202e) ||
    (n >= 0x2066 && n <= 0x2069)
  );
};
// `detail` must never contain secrets.
const clean = (value) =>
  [...String(value ?? "")]
    .filter((ch) => !unsafe(ch))
    .join("")
    .slice(0, 200);
// Only address characters survive; anything else is recorded as "invalid".
const cleanIp = (value) =>
  value === undefined || value === null
    ? null
    : /^[0-9A-Fa-f:.]{1,64}$/.test(String(value))
      ? String(value)
      : "invalid";
export async function audit(
  db,
  session,
  actor,
  action,
  resource,
  resourceId,
  detail = "",
  req,
) {
  await db.collection("audit_events").insertOne(
    {
      _id: randomUUID(),
      actorId: actor?._id || "system",
      actorName: actor?.name || "System",
      action,
      resource,
      resourceId,
      detail: clean(detail),
      ...(req
        ? {
            ip: cleanIp(req.ip),
            userAgent: clean(req.get?.("user-agent")),
          }
        : {}),
      createdAt: new Date(),
    },
    { session },
  );
}
