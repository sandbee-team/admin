import { decrypt } from "./crypto.js";
import { POS_SECRET_FIELDS } from "../../shared/schemas.js";
const at = (object, path) =>
  path.split(".").reduce((value, part) => value?.[part], object);
// Every encrypted box the database can hold, with the AAD it was sealed with.
// snapshot.js verifies all of them, so a new secret location only needs an
// entry here.
const locations = {
  connections: (row) => [[row.secret, `connection:${row._id}`]],
  staff: (row) => [
    [row.totp?.key, `staff:${row._id}:totp`],
    [row.totpPending?.key, `staff:${row._id}:totp-pending`],
  ],
  customers: (row) => [
    ...(row.accounts ?? []).flatMap((account) =>
      ["password", "totpKey", "backupCodes"].map((field) => [
        account?.[field],
        `account:${row._id}:${account?.id}:${field}`,
      ]),
    ),
    ...(row.files ?? []).map((file) => [
      file?.dataKey,
      `file:${row._id}:${file?.id}`,
    ]),
  ],
  installations: (row) =>
    POS_SECRET_FIELDS.map((field) => [
      at(row.pos, field),
      `pos:${row._id}:${field}`,
    ]),
};
export function* secretBoxes(collection, row) {
  for (const [box, aad] of locations[collection]?.(row) ?? [])
    if (box) yield [box, aad];
}
// Throws if any box does not open with this key and its own record binding.
export function verifySecretBoxes(collection, row, vaultKey) {
  for (const [box, aad] of secretBoxes(collection, row))
    decrypt(box, vaultKey, aad);
}
