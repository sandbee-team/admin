import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { BSON } from "mongodb";
import { startApp, assertNoSecrets, VAULT_KEY, BACKUP_KEY } from "./helpers.js";
import { createFakeS3 } from "./fake-s3.js";
import { digest, encrypt } from "../backend/lib/crypto.js";
import { makeSnapshot, parseSnapshot } from "../backend/lib/snapshot.js";
import { fyOf } from "../shared/sales.js";
import { LEGACY_DEFAULT_TEMPLATES } from "../shared/sales-schemas.js";
import {
  LOGO,
  SIGNATURE,
  COMPANY,
  BANK,
  BILL_TO,
  dealFixture,
  pdfText,
} from "./sales-fixtures.js";

let ctx, fake, owner, admin, operations, viewer, A, B;
const sent = [];
const mailState = { fail: false };
const FY = fyOf(new Date()).label;
const stepUp = (session) =>
  ctx.db
    .collection("sessions")
    .updateOne(
      { _id: digest(session.cookie.split("=")[1]) },
      { $set: { stepUpUntil: new Date(Date.now() + 600000) } },
    );
const stepDown = (session) =>
  ctx.db
    .collection("sessions")
    .updateOne(
      { _id: digest(session.cookie.split("=")[1]) },
      { $unset: { stepUpUntil: "" } },
    );
const req = (...args) => ctx.request(...args);
// Requests whose answer is not JSON (PDF) or whose body is raw (images).
async function raw(
  path,
  { method = "POST", session, body, type = "application/json" } = {},
) {
  const res = await fetch(`${ctx.origin}/api${path}`, {
    method,
    headers: {
      Origin: ctx.origin,
      "Content-Type": type,
      Cookie: session.cookie,
      "X-CSRF-Token": session.csrf,
    },
    body: type === "application/json" ? JSON.stringify(body ?? {}) : body,
  });
  const buffer = Buffer.from(await res.arrayBuffer());
  return {
    status: res.status,
    headers: res.headers,
    buffer,
    json: () => JSON.parse(buffer.toString()),
  };
}
// Headers only over node:http (as the file tests do): the server refuses an
// oversized upload from Content-Length before reading any body.
function rawUpload(path, session, length) {
  return new Promise((resolve, reject) => {
    const r = httpRequest(
      `${ctx.origin}/api${path}`,
      {
        method: "PUT",
        headers: {
          Origin: ctx.origin,
          "Content-Type": "application/octet-stream",
          "Content-Length": String(length),
          Cookie: session.cookie,
          "X-CSRF-Token": session.csrf,
        },
      },
      (res) => {
        const parts = [];
        res.on("data", (c) => parts.push(c));
        res.on("end", () => {
          r.destroy();
          resolve({
            status: res.statusCode,
            json: () => JSON.parse(Buffer.concat(parts).toString()),
          });
        });
      },
    );
    r.on("error", (e) =>
      ["EPIPE", "ECONNRESET"].includes(e.code) ? undefined : reject(e),
    );
    r.flushHeaders();
  });
}
// The sample company is GST-registered; the jurisdiction is only needed for
// agreements.
const COMPANY_J = { ...COMPANY, jurisdiction: "Pune" };
const SETTINGS = {
  company: COMPANY_J,
  gst: { registered: true },
  bank: BANK,
  signatory: { name: "A. Founder", title: "Director" },
};
const { _id: _ignored, ...DEAL } = dealFixture();
void _ignored;
async function customer(name, email) {
  const done = await req("/customers", {
    method: "POST",
    session: owner,
    body: {
      name,
      email,
      company: `${name} LLP`,
      phone: "",
      status: "active",
      notes: "",
    },
  });
  assert.equal(done.status, 201, JSON.stringify(done.data));
  return done.data._id;
}
async function newDeal(cid, session = admin, title = "POS setup") {
  const made = await req(`/customers/${cid}/sales/deals`, {
    method: "POST",
    session,
    body: { title },
  });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const saved = await req(`/sales/deals/${made.data.id}`, {
    method: "PUT",
    session,
    body: { rev: made.data.rev, ...DEAL, title },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  return saved.data;
}
const issue = (deal, type, session = admin) =>
  req(`/sales/deals/${deal.id}/issue`, {
    method: "POST",
    session,
    body: { rev: deal.rev, type },
  });
const deal = async (id) =>
  (await req(`/sales/deals/${id}`, { session: admin })).data;
const auditRows = async (cid) =>
  await ctx.db
    .collection("audit_events")
    .find({ resourceId: cid })
    .sort({ createdAt: 1 })
    .toArray();

before(async () => {
  fake = createFakeS3();
  ctx = await startApp({
    dbName: "sales_api",
    deps: {
      s3: fake.client(),
      sendDocument: async (to, message) => {
        if (mailState.fail) throw new Error("smtp 550 secret-host details");
        sent.push({ to, ...message });
      },
    },
  });
  [owner, admin, operations, viewer] = await Promise.all(
    ["owner", "admin", "operations", "viewer"].map((r) =>
      ctx.login(`${r}@example.test`),
    ),
  );
  A = await customer("Cafe Blue", "a@cafe.example");
  B = await customer("Hotel Green", "b@hotel.example");
});
after(() => ctx?.stop());

describe("sales: permissions and settings", () => {
  it("only owner and admin reach sales; settings writes are owner + step-up", async () => {
    for (const s of [viewer, operations]) {
      assert.equal((await req("/sales/settings", { session: s })).status, 403);
      assert.equal(
        (await req(`/customers/${A}/sales`, { session: s })).status,
        403,
      );
      assert.equal(
        (
          await req(`/customers/${A}/sales/deals`, {
            method: "POST",
            session: s,
            body: { title: "x y" },
          })
        ).status,
        403,
      );
    }
    const view = await req("/sales/settings", { session: admin });
    assert.equal(view.status, 200);
    assert.equal(view.data.rev, 0);
    assert.equal(view.data.numbering.invoice.prefix, "INV/");
    assert.equal(view.data.ready.quotation, false);
    assert.equal(
      (
        await req("/sales/settings", {
          method: "PUT",
          session: admin,
          body: { rev: 0, ...SETTINGS },
        })
      ).status,
      403,
    );
    const noStep = await req("/sales/settings", {
      method: "PUT",
      session: owner,
      body: { rev: 0, ...SETTINGS },
    });
    assert.equal(noStep.status, 428);
  });
  it("refuses an incomplete company profile at issue, naming what is missing", async () => {
    const d = await newDeal(A);
    const refused = await issue(d, "quotation");
    assert.equal(refused.status, 409);
    assert.equal(refused.data.code, "settings-incomplete");
    // Not registered (the default): name, e-mail and phone only.
    assert.deepEqual(refused.data.items, ["legal-name", "email", "phone"]);
    await ctx.db.collection("sales_deals").deleteOne({ _id: d.id });
  });
  it("validates settings without echoing values; stale rev is 409", async () => {
    await stepUp(owner);
    const bad = await req("/sales/settings", {
      method: "PUT",
      session: owner,
      body: {
        rev: 0,
        ...SETTINGS,
        company: { ...COMPANY_J, gstin: "27AAACS9999K1ZX" },
      },
    });
    assert.equal(bad.status, 400);
    assert.match(bad.data.error, /company.*GSTIN/i);
    assert.equal(bad.data.error.includes("27AAACS9999K1ZX"), false);
    const placeholder = await req("/sales/settings", {
      method: "PUT",
      session: owner,
      body: {
        rev: 0,
        ...SETTINGS,
        templates: { quotationTerms: "Hi {{client.secret}}" },
      },
    });
    assert.equal(placeholder.status, 400);
    assert.match(placeholder.data.error, /placeholder/);
    // Without a GSTIN a quotation is possible but an invoice is not.
    const saved = await req("/sales/settings", {
      method: "PUT",
      session: owner,
      body: { rev: 0, ...SETTINGS, company: { ...COMPANY_J, gstin: "" } },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    assert.equal(saved.data.rev, 1);
    assert.deepEqual(saved.data.ready, {
      registered: true,
      quotation: true,
      agreement: true,
      invoice: false,
      missing: { quotation: [], agreement: [], invoice: ["gstin"] },
    });
    const stale = await req("/sales/settings", {
      method: "PUT",
      session: owner,
      body: { rev: 0, ...SETTINGS },
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.data.code, "stale");
    const done = await req("/sales/settings", {
      method: "PUT",
      session: owner,
      body: { rev: 1, ...SETTINGS },
    });
    assert.equal(done.status, 200);
    assert.equal(done.data.ready.invoice, true);
  });
  it("takes a PNG logo as a raw upload (owner + step-up) and refuses other files", async () => {
    await stepDown(owner);
    assert.equal(
      (
        await raw("/sales/settings/images/logo", {
          method: "PUT",
          session: owner,
          body: LOGO,
          type: "application/octet-stream",
        })
      ).status,
      428,
    );
    await stepUp(owner);
    const ok = await raw("/sales/settings/images/logo", {
      method: "PUT",
      session: owner,
      body: LOGO,
      type: "application/octet-stream",
    });
    assert.equal(ok.status, 200, ok.buffer.toString());
    assert.deepEqual(ok.json().images.logo, {
      set: true,
      type: "png",
      width: 120,
      height: 48,
      size: LOGO.length,
    });
    assert.equal(ok.json().rev, 3);
    const gif = await raw("/sales/settings/images/signature", {
      method: "PUT",
      session: owner,
      body: Buffer.from("GIF89a-not-allowed"),
      type: "application/octet-stream",
    });
    assert.equal(gif.status, 400);
    assert.match(gif.json().error, /PNG or JPEG/);
    const big = await rawUpload(
      "/sales/settings/images/signature",
      owner,
      600 * 1024,
    );
    assert.equal(big.status, 413);
    const json = await raw("/sales/settings/images/logo", {
      method: "PUT",
      session: owner,
      body: {},
    });
    assert.equal(json.status, 415);
    assert.equal(
      (
        await raw("/sales/settings/images/logo", {
          method: "PUT",
          session: admin,
          body: LOGO,
          type: "application/octet-stream",
        })
      ).status,
      403,
    );
  });
});

describe("sales: deals and documents", () => {
  let d1, q1, q2;
  it("creates a draft deal from the client's billing details and computes totals", async () => {
    const profile = await req(`/customers/${A}/sales`, { session: admin });
    assert.equal(profile.status, 200);
    assert.equal(profile.data.profile.rev, 0);
    assert.equal(profile.data.profile.billTo.name, "Cafe Blue LLP");
    // Client quotation terms print beside the payment details: owner + step-up.
    await stepUp(owner);
    const savedProfile = await req(`/customers/${A}/sales/profile`, {
      method: "PUT",
      session: owner,
      body: {
        rev: 0,
        billTo: BILL_TO,
        overrides: { quotationTerms: "Custom terms for {{client.name}} only." },
      },
    });
    assert.equal(savedProfile.status, 200, JSON.stringify(savedProfile.data));
    const made = await req(`/customers/${A}/sales/deals`, {
      method: "POST",
      session: admin,
      body: { title: "POS setup" },
    });
    assert.equal(made.status, 201);
    assert.equal(made.data.billTo.gstin, BILL_TO.gstin);
    assert.equal(made.data.placeOfSupply, "27");
    assert.equal(made.data.status, "draft");
    const saved = await req(`/sales/deals/${made.data.id}`, {
      method: "PUT",
      session: admin,
      body: { rev: 1, ...DEAL },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    assert.equal(saved.data.totals.payable, 1119900);
    assert.equal(saved.data.totals.cgst, 85415);
    const stale = await req(`/sales/deals/${made.data.id}`, {
      method: "PUT",
      session: admin,
      body: { rev: 1, ...DEAL },
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.data.code, "stale");
    const badLine = await req(`/sales/deals/${made.data.id}`, {
      method: "PUT",
      session: admin,
      body: {
        rev: 2,
        ...DEAL,
        lines: [
          { ...DEAL.lines[0], discount: { type: "amount", value: 2000000 } },
        ],
      },
    });
    assert.equal(badLine.status, 400);
    d1 = saved.data;
  });
  it("issues a numbered quotation, archives it as a customer file, and re-issues as v2", async () => {
    assert.equal((await issue(d1, "agreement")).status, 409);
    const first = await issue(d1, "quotation");
    assert.equal(first.status, 201, JSON.stringify(first.data));
    q1 = first.data;
    assert.equal(q1.number, `QT/${FY}/0001`);
    assert.equal(q1.label, `QT/${FY}/0001 v1`);
    assert.equal(q1.stored, true);
    assert.equal(q1.textSource, "client");
    assert.equal(q1.payable, 1119900);
    const files = (await req(`/customers/${A}/files`, { session: admin })).data
      .rows;
    assert.equal(files.length, 1);
    assert.equal(files[0].category, "quotation");
    assert.equal(files[0].name, `quotation-QT-${FY}-0001-v1.pdf`);
    // A double click: the second request carries the old rev.
    assert.equal((await issue(d1, "quotation")).status, 409);
    d1 = await deal(d1.id);
    const second = await issue(d1, "quotation");
    assert.equal(second.status, 201);
    q2 = second.data;
    assert.equal(q2.number, q1.number);
    assert.equal(q2.version, 2);
    const v1 = (await req(`/sales/documents/${q1.id}`, { session: admin }))
      .data;
    assert.equal(v1.status, "superseded");
  });
  it("issued documents are immutable: v1 downloads byte-identical, from the archive", async () => {
    const stored = await ctx.db
      .collection("sales_documents")
      .findOne({ _id: q1.id });
    const down = await raw(`/sales/documents/${q1.id}/download`, {
      session: admin,
    });
    assert.equal(down.status, 200);
    assert.equal(down.headers.get("content-type"), "application/pdf");
    assert.equal(down.headers.get("x-document-source"), "archive");
    assert.equal(digest(down.buffer), stored.pdf.sha256);
    const text = pdfText(down.buffer).join("\n");
    assert.ok(text.includes(`QT/${FY}/0001`));
    assert.ok(text.includes("Custom terms for Cafe Blue LLP only."));
    assert.ok(text.includes("11,199.00"));
    // A template change later never touches what was issued.
    await stepUp(owner);
    const s = (await req("/sales/settings", { session: owner })).data;
    const changed = await req("/sales/settings", {
      method: "PUT",
      session: owner,
      body: {
        rev: s.rev,
        ...SETTINGS,
        templates: { ...s.templates, quotationTerms: "NEW GLOBAL TERMS" },
        company: { ...COMPANY_J, legalName: "Renamed Pvt Ltd" },
      },
    });
    assert.equal(changed.status, 200);
    const again = await raw(`/sales/documents/${q1.id}/download`, {
      session: admin,
    });
    assert.ok(again.buffer.equals(down.buffer));
    const after = await ctx.db
      .collection("sales_documents")
      .findOne({ _id: q1.id });
    assert.deepEqual(after.snapshot, stored.snapshot);
    // Restore the company name for the rest of the suite.
    const back = await req("/sales/settings", {
      method: "PUT",
      session: owner,
      body: {
        rev: changed.data.rev,
        ...SETTINGS,
        templates: changed.data.templates,
      },
    });
    assert.equal(back.status, 200);
  });
  it("one client's text override never changes another client's documents", async () => {
    const other = await newDeal(B, admin, "Hotel POS");
    const q = await issue(other, "quotation");
    assert.equal(q.status, 201);
    assert.equal(q.data.number, `QT/${FY}/0002`);
    assert.equal(q.data.textSource, "default");
    const text = pdfText(
      (await raw(`/sales/documents/${q.data.id}/download`, { session: admin }))
        .buffer,
    ).join("\n");
    assert.ok(text.includes("NEW GLOBAL TERMS"));
    assert.equal(text.includes("Custom terms"), false);
  });
  it("finalise locks the deal; agreement and invoice follow; one active invoice; gapless numbers", async () => {
    d1 = await deal(d1.id);
    const fin = await req(`/sales/deals/${d1.id}/status`, {
      method: "POST",
      session: admin,
      body: { rev: d1.rev, action: "finalize" },
    });
    assert.equal(fin.status, 200);
    assert.equal(fin.data.status, "final");
    const edit = await req(`/sales/deals/${d1.id}`, {
      method: "PUT",
      session: admin,
      body: { rev: fin.data.rev, ...DEAL },
    });
    assert.equal(edit.status, 409);
    assert.equal(edit.data.code, "deal-final");
    d1 = fin.data;
    const ag = await issue(d1, "agreement");
    assert.equal(ag.status, 201);
    assert.equal(ag.data.number, `AG/${FY}/0001`);
    d1 = await deal(d1.id);
    const inv = await issue(d1, "invoice");
    assert.equal(inv.status, 201, JSON.stringify(inv.data));
    assert.equal(inv.data.number, `INV/${FY}/0001`);
    assert.equal(inv.data.label, `INV/${FY}/0001`);
    const text = pdfText(
      (
        await raw(`/sales/documents/${inv.data.id}/download`, {
          session: admin,
        })
      ).buffer,
    ).join("\n");
    for (const want of [
      "TAX INVOICE",
      `INV/${FY}/0001`,
      `QT/${FY}/0001 v2`,
      "GSTIN",
      "27AAACS9999K1ZD",
      "Reverse charge",
      "854.15",
      "11,199.00",
    ])
      assert.ok(text.includes(want), `invoice lacks ${want}`);
    d1 = await deal(d1.id);
    const twice = await issue(d1, "invoice");
    assert.equal(twice.status, 409);
    assert.equal(twice.data.code, "invoice-exists");
    d1 = await deal(d1.id);
    const reopen = await req(`/sales/deals/${d1.id}/status`, {
      method: "POST",
      session: admin,
      body: { rev: d1.rev, action: "reopen" },
    });
    assert.equal(reopen.status, 409);
    assert.equal(reopen.data.code, "invoice-active");
    // Cancel: owner + step-up only, never for quotations.
    const reason = { reason: "Wrong billing entity" };
    assert.equal(
      (
        await req(`/sales/documents/${inv.data.id}/cancel`, {
          method: "POST",
          session: admin,
          body: reason,
        })
      ).status,
      403,
    );
    await stepDown(owner);
    assert.equal(
      (
        await req(`/sales/documents/${inv.data.id}/cancel`, {
          method: "POST",
          session: owner,
          body: reason,
        })
      ).status,
      428,
    );
    await stepUp(owner);
    assert.equal(
      (
        await req(`/sales/documents/${q2.id}/cancel`, {
          method: "POST",
          session: owner,
          body: reason,
        })
      ).status,
      409,
    );
    const cancelled = await req(`/sales/documents/${inv.data.id}/cancel`, {
      method: "POST",
      session: owner,
      body: reason,
    });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.data.status, "cancelled");
    assert.equal(cancelled.data.cancelled.reason, "Wrong billing entity");
    d1 = await deal(d1.id);
    const next = await issue(d1, "invoice");
    assert.equal(next.status, 201);
    assert.equal(next.data.number, `INV/${FY}/0002`);
  });
  it("concurrent issues of one deal produce exactly one document", async () => {
    const d = await newDeal(B, admin, "Race");
    const results = await Promise.all([
      issue(d, "quotation"),
      issue(d, "quotation"),
      issue(d, "quotation"),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409]);
    assert.equal(
      await ctx.db
        .collection("sales_documents")
        .countDocuments({ dealId: d.id }),
      1,
    );
    const seqs = (
      await ctx.db
        .collection("sales_documents")
        .find({ type: "quotation" })
        .toArray()
    ).map((x) => x.seq);
    assert.deepEqual([...new Set(seqs)].sort(), [1, 2, 3]);
  });
  it("storage failure still issues; Store copy archives later; tampering falls back and is audited", async () => {
    const d = await newDeal(B, admin, "Storage");
    fake.fail("put");
    const q = await issue(d, "quotation");
    assert.equal(q.status, 201);
    assert.equal(q.data.stored, false);
    const regen = await raw(`/sales/documents/${q.data.id}/download`, {
      session: admin,
    });
    assert.equal(regen.headers.get("x-document-source"), "regenerated");
    const doc = await ctx.db
      .collection("sales_documents")
      .findOne({ _id: q.data.id });
    assert.equal(digest(regen.buffer), doc.pdf.sha256);
    const store = await req(`/sales/documents/${q.data.id}/store`, {
      method: "POST",
      session: admin,
      body: {},
    });
    assert.equal(store.status, 200, JSON.stringify(store.data));
    assert.equal(store.data.stored, true);
    assert.equal(
      (
        await req(`/sales/documents/${q.data.id}/store`, {
          method: "POST",
          session: admin,
          body: {},
        })
      ).status,
      409,
    );
    const linked = await ctx.db
      .collection("sales_documents")
      .findOne({ _id: q.data.id });
    const file = (
      await ctx.db.collection("customers").findOne({ _id: B })
    ).files.find((f) => f.id === linked.pdf.fileId);
    fake.tamper(file.s3Key);
    const fallback = await raw(`/sales/documents/${q.data.id}/download`, {
      session: admin,
    });
    assert.equal(fallback.status, 200);
    assert.equal(fallback.headers.get("x-document-source"), "regenerated");
    assert.equal(digest(fallback.buffer), doc.pdf.sha256);
    assert.ok(
      (await auditRows(B)).some((r) => r.action === "sales.integrity-failed"),
    );
  });
  it("e-mails the current version as a PDF attachment; never logs addresses or SMTP text", async () => {
    const before = sent.length;
    const ok = await req(`/sales/documents/${q2.id}/email`, {
      method: "POST",
      session: admin,
      body: { to: ["Owner@CafeBlue.example"], message: "As discussed today." },
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal(ok.data.emails.length, 1);
    const mail = sent[before];
    assert.deepEqual(mail.to, ["owner@cafeblue.example"]);
    assert.equal(mail.replyTo, COMPANY.email);
    assert.equal(mail.filename, `quotation-QT-${FY}-0001-v2.pdf`);
    assert.equal(mail.content.subarray(0, 5).toString(), "%PDF-");
    assert.match(mail.subject, new RegExp(`Quotation QT/${FY}/0001 v2`));
    assert.match(mail.text, /As discussed today\./);
    assert.equal(
      (
        await req(`/sales/documents/${q1.id}/email`, {
          method: "POST",
          session: admin,
          body: { to: ["x@y.example"] },
        })
      ).status,
      409,
    );
    mailState.fail = true;
    const failed = await req(`/sales/documents/${q2.id}/email`, {
      method: "POST",
      session: admin,
      body: { to: ["x@y.example"] },
    });
    mailState.fail = false;
    assert.equal(failed.status, 502);
    assert.equal(JSON.stringify(failed.data).includes("secret-host"), false);
    const rows = await auditRows(A);
    const emailed = rows.filter((r) => r.action === "sales.emailed");
    assert.equal(emailed.length, 1);
    assert.match(emailed[0].detail, /1 recipient$/);
    for (const r of rows) assert.equal(/@/.test(r.detail), false, r.detail);
  });
  it("records an audit trail visible in the customer's activity", async () => {
    const activity = await req(`/audit?customerId=${A}`, { session: owner });
    const actions = new Set(activity.data.rows.map((r) => r.action));
    for (const a of [
      "sales.profile-updated",
      "sales.deal-created",
      "sales.deal-updated",
      "sales.issued",
      "sales.stored",
      "sales.deal-finalized",
      "sales.cancelled",
      "sales.downloaded",
      "sales.emailed",
    ])
      assert.ok(actions.has(a), `missing ${a}`);
  });
});

describe("sales: lifecycle edges", () => {
  const counter = async (type) =>
    (
      await ctx.db
        .collection("sales_counters")
        .findOne({ _id: `${type}:${fyOf(new Date()).start}` })
    )?.seq ?? 0;
  const finalize = async (d) => {
    const done = await req(`/sales/deals/${d.id}/status`, {
      method: "POST",
      session: admin,
      body: { rev: d.rev, action: "finalize" },
    });
    assert.equal(done.status, 200, JSON.stringify(done.data));
    return done.data;
  };
  it("preview is a marked draft: no number, nothing stored, no counter used", async () => {
    const d = await newDeal(B, admin, "Preview only");
    const before = {
      q: await counter("quotation"),
      docs: await ctx.db.collection("sales_documents").countDocuments(),
    };
    for (const type of ["quotation", "agreement", "invoice"]) {
      const pdf = await raw(`/sales/deals/${d.id}/preview`, {
        session: admin,
        body: { type },
      });
      assert.equal(pdf.status, 200);
      assert.equal(pdf.headers.get("content-type"), "application/pdf");
      const text = pdfText(pdf.buffer).join("\n");
      assert.ok(text.includes("DRAFT - NOT ISSUED"), type);
    }
    assert.equal(await counter("quotation"), before.q);
    assert.equal(
      await ctx.db.collection("sales_documents").countDocuments(),
      before.docs,
    );
    const empty = await req(`/customers/${B}/sales/deals`, {
      method: "POST",
      session: admin,
      body: { title: "Empty" },
    });
    const refused = await raw(`/sales/deals/${empty.data.id}/preview`, {
      session: admin,
      body: { type: "quotation" },
    });
    assert.equal(refused.status, 409);
    assert.equal(refused.json().code, "deal-incomplete");
    const fin = await req(`/sales/deals/${empty.data.id}/status`, {
      method: "POST",
      session: admin,
      body: { rev: empty.data.rev, action: "finalize" },
    });
    assert.equal(fin.status, 409);
    assert.equal(fin.data.code, "deal-incomplete");
  });
  it("lost deals issue nothing until reopened; a past valid-until date is refused", async () => {
    let d = await newDeal(B, admin, "Maybe later");
    const lost = await req(`/sales/deals/${d.id}/status`, {
      method: "POST",
      session: admin,
      body: { rev: d.rev, action: "lost" },
    });
    assert.equal(lost.data.status, "lost");
    const refused = await issue(lost.data, "quotation");
    assert.equal(refused.data.code, "deal-lost");
    const reopened = await req(`/sales/deals/${d.id}/status`, {
      method: "POST",
      session: admin,
      body: { rev: lost.data.rev, action: "reopen" },
    });
    assert.equal(reopened.data.status, "draft");
    d = (
      await req(`/sales/deals/${d.id}`, {
        method: "PUT",
        session: admin,
        body: {
          rev: reopened.data.rev,
          ...DEAL,
          title: "Maybe later",
          validUntil: "2020-01-31",
        },
      })
    ).data;
    const past = await issue(d, "quotation");
    assert.equal(past.status, 409);
    assert.equal(past.data.code, "valid-until-past");
  });
  it("an agreement can be cancelled once; a cancelled invoice frees the deal and downloads stamped", async () => {
    let d = await finalize(await newDeal(B, admin, "Cancel flow"));
    const ag = await issue(d, "agreement");
    d = await deal(d.id);
    const inv = await issue(d, "invoice");
    assert.equal(inv.status, 201);
    await stepUp(owner);
    const reason = { reason: "Duplicate by mistake" };
    assert.equal(
      (
        await req(`/sales/documents/${ag.data.id}/cancel`, {
          method: "POST",
          session: owner,
          body: reason,
        })
      ).status,
      200,
    );
    const twice = await req(`/sales/documents/${ag.data.id}/cancel`, {
      method: "POST",
      session: owner,
      body: reason,
    });
    assert.equal(twice.status, 409);
    assert.equal(
      (
        await req(`/sales/documents/${inv.data.id}/cancel`, {
          method: "POST",
          session: owner,
          body: reason,
        })
      ).status,
      200,
    );
    const pdf = await raw(`/sales/documents/${inv.data.id}/download`, {
      session: admin,
    });
    assert.equal(pdf.headers.get("x-document-source"), "regenerated");
    assert.ok(pdfText(pdf.buffer).join("\n").includes("CANCELLED"));
    // A cancelled document is never archived (or re-archived) again.
    assert.equal(
      (
        await req(`/sales/documents/${inv.data.id}/store`, {
          method: "POST",
          session: admin,
          body: {},
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await req(`/sales/documents/${inv.data.id}/email`, {
          method: "POST",
          session: admin,
          body: { to: ["x@y.example"] },
        })
      ).status,
      409,
    );
    d = await deal(d.id);
    const reopen = await req(`/sales/deals/${d.id}/status`, {
      method: "POST",
      session: admin,
      body: { rev: d.rev, action: "reopen" },
    });
    assert.equal(reopen.status, 200);
    assert.equal(reopen.data.status, "draft");
  });
  it("a client's own invoice terms are a billing change (owner + step-up); stale saves are refused", async () => {
    const profile = (await req(`/customers/${B}/sales`, { session: admin }))
      .data.profile;
    const body = (overrides) => ({
      rev: profile.rev,
      billTo: { ...BILL_TO, name: "Hotel Green LLP" },
      overrides: {
        quotationTerms: null,
        agreementBody: null,
        invoiceTerms: null,
        ...overrides,
      },
    });
    const asAdmin = await req(`/customers/${B}/sales/profile`, {
      method: "PUT",
      session: admin,
      body: body({ invoiceTerms: "Pay to account 999" }),
    });
    assert.equal(asAdmin.status, 403);
    await stepDown(owner);
    assert.equal(
      (
        await req(`/customers/${B}/sales/profile`, {
          method: "PUT",
          session: owner,
          body: body({ invoiceTerms: "Net 15" }),
        })
      ).status,
      428,
    );
    await stepUp(owner);
    const ok = await req(`/customers/${B}/sales/profile`, {
      method: "PUT",
      session: owner,
      body: body({ invoiceTerms: "Net 15" }),
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    // Quotation terms are guarded the same way.
    const quote = await req(`/customers/${B}/sales/profile`, {
      method: "PUT",
      session: admin,
      body: {
        ...body({ invoiceTerms: "Net 15", quotationTerms: "Hotel terms" }),
        rev: ok.data.rev,
      },
    });
    assert.equal(quote.status, 403);
    // Admin may still change the billing details and the agreement text.
    const other = await req(`/customers/${B}/sales/profile`, {
      method: "PUT",
      session: admin,
      body: {
        ...body({ invoiceTerms: "Net 15", agreementBody: "Hotel agreement" }),
        billTo: { ...BILL_TO, name: "Hotel Green LLP", city: "Mumbai" },
        rev: ok.data.rev,
      },
    });
    assert.equal(other.status, 200, JSON.stringify(other.data));
    assert.equal(other.data.billTo.city, "Mumbai");
    const stale = await req(`/customers/${B}/sales/profile`, {
      method: "PUT",
      session: admin,
      body: { ...body({ invoiceTerms: "Net 15" }), rev: ok.data.rev },
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.data.code, "stale");
  });
  it("a copy deleted in Files can be stored again; S3 trouble falls back to the snapshot", async () => {
    const doc = await ctx.db.collection("sales_documents").findOne({
      dealId: { $exists: true },
      type: "quotation",
      version: 1,
      number: `QT/${FY}/0001`,
    });
    await stepUp(owner);
    const del = await req(
      `/customers/${doc.customerId}/files/${doc.pdf.fileId}`,
      { method: "DELETE", session: owner, body: {} },
    );
    assert.equal(del.status, 200, JSON.stringify(del.data));
    const view = (await req(`/sales/documents/${doc._id}`, { session: admin }))
      .data;
    assert.equal(view.stored, false);
    // Issued before the later settings and template changes: it still
    // re-renders to exactly the bytes recorded at issue.
    const again = await req(`/sales/documents/${doc._id}/store`, {
      method: "POST",
      session: admin,
      body: {},
    });
    assert.equal(again.status, 200, JSON.stringify(again.data));
    assert.equal(again.data.stored, true);
    const relinked = await ctx.db
      .collection("sales_documents")
      .findOne({ _id: doc._id });
    assert.notEqual(relinked.pdf.fileId, doc.pdf.fileId);
    assert.ok(
      (await auditRows(doc.customerId)).some(
        (r) =>
          r.action === "sales.stored" &&
          r.detail.includes(relinked.pdf.fileId.slice(0, 8)),
      ),
    );
    fake.fail("get");
    const down = await raw(`/sales/documents/${doc._id}/download`, {
      session: admin,
    });
    assert.equal(down.status, 200);
    assert.equal(down.headers.get("x-document-source"), "regenerated");
    assert.equal(digest(down.buffer), doc.pdf.sha256);
    assert.ok(
      (await auditRows(doc.customerId)).some(
        (r) => r.action === "sales.archive-unavailable",
      ),
    );
  });
  it("limits e-mail to 5 per document per hour", async () => {
    const d = await newDeal(B, admin, "Mail limit");
    const q = await issue(d, "quotation");
    for (let i = 0; i < 5; i++)
      assert.equal(
        (
          await req(`/sales/documents/${q.data.id}/email`, {
            method: "POST",
            session: admin,
            body: { to: ["limit@hotel.example"] },
          })
        ).status,
        200,
      );
    assert.equal(
      (
        await req(`/sales/documents/${q.data.id}/email`, {
          method: "POST",
          session: admin,
          body: { to: ["limit@hotel.example"] },
        })
      ).status,
      429,
    );
  });
  it("refuses an invoice number over 16 characters without using up a number", async () => {
    await stepUp(owner);
    const s = (await req("/sales/settings", { session: owner })).data;
    const set = (invoicePrefix, rev) =>
      req("/sales/settings", {
        method: "PUT",
        session: owner,
        body: {
          rev,
          ...SETTINGS,
          templates: s.templates,
          numbering: { ...s.numbering, invoice: { prefix: invoicePrefix } },
        },
      });
    const long = await set("INVOI/", s.rev);
    assert.equal(long.status, 200);
    const id = `invoice:${fyOf(new Date()).start}`,
      was = await counter("invoice");
    await ctx.db
      .collection("sales_counters")
      .updateOne({ _id: id }, { $set: { seq: 99999 } }, { upsert: true });
    assert.equal(
      (await req("/sales/settings", { session: admin })).data.next.invoice,
      `INVOI/${FY}/100000`,
    );
    const d = await finalize(await newDeal(B, admin, "Long number"));
    const refused = await issue(d, "invoice");
    assert.equal(refused.status, 409);
    assert.equal(refused.data.code, "number-too-long");
    assert.equal(await counter("invoice"), 99999);
    await ctx.db
      .collection("sales_counters")
      .updateOne({ _id: id }, { $set: { seq: was } });
    assert.equal((await set("INV/", long.data.rev)).status, 200);
    // Equal prefixes would print equal numbers.
    const same = await req("/sales/settings", {
      method: "PUT",
      session: owner,
      body: {
        rev: long.data.rev + 1,
        ...SETTINGS,
        numbering: {
          quotation: { prefix: "SB/" },
          agreement: { prefix: "AG/" },
          invoice: { prefix: "SB/" },
        },
      },
    });
    assert.equal(same.status, 400);
  });
  it("removing an image unused by any document deletes its bytes; long texts fit the request limit", async () => {
    await stepUp(owner);
    const up = await raw("/sales/settings/images/signature", {
      method: "PUT",
      session: owner,
      body: SIGNATURE,
      type: "application/octet-stream",
    });
    assert.equal(up.status, 200);
    const sha = digest(SIGNATURE);
    assert.ok(await ctx.db.collection("sales_assets").findOne({ _id: sha }));
    const gone = await req("/sales/settings/images/signature", {
      method: "DELETE",
      session: owner,
      body: {},
    });
    assert.equal(gone.status, 200);
    assert.equal(gone.data.images.signature.set, false);
    assert.equal(
      await ctx.db.collection("sales_assets").findOne({ _id: sha }),
      null,
    );
    // The logo is printed on issued documents: its bytes stay.
    const logoSha = digest(LOGO);
    assert.ok(
      await ctx.db.collection("sales_assets").findOne({ _id: logoSha }),
    );
    // 19,000 em dashes are 57 KB of JSON: above the general 32 KB limit.
    const s = gone.data;
    const big = await req("/sales/settings", {
      method: "PUT",
      session: owner,
      body: {
        rev: s.rev,
        ...SETTINGS,
        templates: { ...s.templates, agreementBody: "\u2014".repeat(19000) },
      },
    });
    assert.equal(big.status, 200, JSON.stringify(big.data).slice(0, 200));
  });
});

describe("sales: backups", () => {
  it("snapshots include the sales collections; older snapshots without them still parse", async () => {
    const snap = parseSnapshot(
      await makeSnapshot(ctx.db, VAULT_KEY, BACKUP_KEY),
      VAULT_KEY,
      BACKUP_KEY,
    );
    assert.ok(snap.collections.sales_documents.length >= 5);
    assert.equal(snap.collections.sales_settings.length, 1);
    const old = {
      format: 1,
      createdAt: new Date(),
      collections: Object.fromEntries(
        [
          "staff",
          "products",
          "customers",
          "installations",
          "connections",
          "tasks",
          "audit_events",
          "recovery_checks",
          "system_state",
        ].map((n) => [n, []]),
      ),
    };
    const seal = (value) =>
      JSON.stringify(
        encrypt(
          BSON.EJSON.stringify(value),
          BACKUP_KEY,
          "sandbee-admin-backup-v1",
        ),
      );
    const parsed = parseSnapshot(seal(old), VAULT_KEY, BACKUP_KEY);
    assert.deepEqual(parsed.collections.sales_deals, []);
    assert.throws(() =>
      parseSnapshot(
        seal({ ...old, collections: { ...old.collections, other: [] } }),
        VAULT_KEY,
        BACKUP_KEY,
      ),
    );
    const { staff: _s, ...missing } = old.collections;
    void _s;
    assert.throws(() =>
      parseSnapshot(
        seal({ ...old, collections: missing }),
        VAULT_KEY,
        BACKUP_KEY,
      ),
    );
  });
});

describe("sales: a seller without GST registration", () => {
  let C;
  const NAME_ONLY = {
    company: {
      legalName: "Sandbee Technologies",
      email: "hello@sandbee.example",
      phone: "+91 98000 00000",
    },
    gst: { registered: false },
  };
  const put = async (body) => {
    await stepUp(owner);
    const current = (await req("/sales/settings", { session: admin })).data;
    const done = await req("/sales/settings", {
      method: "PUT",
      session: owner,
      body: { rev: current.rev, ...body },
    });
    assert.equal(done.status, 200, JSON.stringify(done.data));
    assertNoSecrets(done.data, [], "settings");
    return done.data;
  };
  const finalize = async (d) =>
    (
      await req(`/sales/deals/${d.id}/status`, {
        method: "POST",
        session: admin,
        body: { rev: d.rev, action: "finalize" },
      })
    ).data;
  // No place of supply and no client state: not needed without GST.
  const bare = async (cid, title) => {
    const made = await req(`/customers/${cid}/sales/deals`, {
      method: "POST",
      session: admin,
      body: { title },
    });
    assert.equal(made.status, 201, JSON.stringify(made.data));
    const saved = await req(`/sales/deals/${made.data.id}`, {
      method: "PUT",
      session: admin,
      body: {
        rev: made.data.rev,
        ...DEAL,
        title,
        billTo: { ...BILL_TO, stateCode: "", gstin: "" },
        placeOfSupply: "",
      },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    return saved.data;
  };
  before(async () => {
    C = await customer("Plain Traders", "c@plain.example");
  });
  it("needs only name, e-mail and phone; the agreement also a jurisdiction", async () => {
    const view = await put(NAME_ONLY);
    assert.deepEqual(view.ready, {
      registered: false,
      quotation: true,
      agreement: false,
      invoice: true,
      missing: { quotation: [], agreement: ["jurisdiction"], invoice: [] },
    });
    assert.equal(view.gst.registered, false);
    const partial = await put({
      company: { legalName: "Sandbee Technologies" },
      gst: { registered: false },
    });
    assert.deepEqual(partial.ready.missing, {
      quotation: ["email", "phone"],
      agreement: ["email", "phone", "jurisdiction"],
      invoice: ["email", "phone"],
    });
    await put(NAME_ONLY);
  });
  it("completes and totals a deal without place of supply or client state, with no tax", async () => {
    const d = await bare(C, "No GST deal");
    assert.equal(d.registered, false);
    assert.equal(d.placeOfSupply, "");
    assert.equal(d.totals.registered, false);
    assert.equal(d.totals.cgst + d.totals.sgst + d.totals.igst, 0);
    assert.deepEqual(d.totals.rates, []);
    assert.equal(d.totals.total, d.totals.taxable);
    assert.deepEqual(d.ready.missing.invoice, []);
    const list = await req(`/customers/${C}/sales`, { session: admin });
    assert.equal(list.data.ready.registered, false);
    const row = list.data.deals.find((x) => x.id === d.id);
    assert.equal(row.payable, d.totals.payable);
    assertNoSecrets(list.data, [], "customer sales");
    const fin = await finalize(d);
    assert.equal(fin.status, "final", JSON.stringify(fin));
  });
  it("issues a quotation and an invoice titled Invoice; the agreement waits for a jurisdiction", async () => {
    const d = await bare(C, "Issue without GST");
    const final = await finalize(d);
    const q = await issue(final, "quotation");
    assert.equal(q.status, 201, JSON.stringify(q.data));
    assert.equal(q.data.payable, d.totals.payable);
    const again = await deal(d.id);
    const inv = await issue(again, "invoice");
    assert.equal(inv.status, 201, JSON.stringify(inv.data));
    assert.equal(inv.data.title, "Invoice");
    assert.equal(inv.data.payable, d.totals.payable);
    const ag = await issue(await deal(d.id), "agreement");
    assert.equal(ag.status, 409);
    assert.equal(ag.data.code, "settings-incomplete");
    assert.deepEqual(ag.data.items, ["jurisdiction"]);
    assert.match(ag.data.error, /jurisdiction city \(for the agreement\)/);
    await put({
      ...NAME_ONLY,
      company: { ...NAME_ONLY.company, jurisdiction: "Ahmedabad" },
    });
    const ok = await issue(await deal(d.id), "agreement");
    assert.equal(ok.status, 201, JSON.stringify(ok.data));
    assert.equal(ok.data.title, "Agreement");
    assertNoSecrets(ok.data, [], "document");
  });
  it("registered again: place of supply and client state are required to complete a deal", async () => {
    const view = await put(SETTINGS);
    assert.equal(view.ready.registered, true);
    const d = await bare(C, "Registered deal");
    // The static schema accepts blanks; completeness needs them when registered.
    const refused = await req(`/sales/deals/${d.id}/status`, {
      method: "POST",
      session: admin,
      body: { rev: d.rev, action: "finalize" },
    });
    assert.equal(refused.status, 409);
    assert.equal(refused.data.code, "deal-incomplete");
    const preview = await req(`/sales/deals/${d.id}/preview`, {
      method: "POST",
      session: admin,
      body: { type: "quotation" },
    });
    assert.equal(preview.status, 409);
    assert.equal(preview.data.code, "deal-incomplete");
    assert.ok(d.totals.cgst + d.totals.sgst + d.totals.igst >= 0);
    // A GSTIN that disagrees with an empty state is still refused.
    const bad = await req(`/sales/deals/${d.id}`, {
      method: "PUT",
      session: admin,
      body: {
        rev: d.rev,
        ...DEAL,
        billTo: { ...BILL_TO, stateCode: "" },
        placeOfSupply: "",
      },
    });
    assert.equal(bad.status, 400);
    assert.match(bad.data.error, /GSTIN state/);
  });
});

describe("sales: review fixes (old default texts, GST mode switches, seller GSTIN)", () => {
  let D;
  const NO_GST = {
    company: {
      legalName: "Sandbee Technologies",
      email: "hello@sandbee.example",
      phone: "+91 98000 00000",
      jurisdiction: "Ahmedabad",
    },
    gst: { registered: false },
  };
  const send = async (body) => {
    await stepUp(owner);
    const current = (await req("/sales/settings", { session: admin })).data;
    return req("/sales/settings", {
      method: "PUT",
      session: owner,
      body: { rev: current.rev, ...body },
    });
  };
  const put = async (body) => {
    const done = await send(body);
    assert.equal(done.status, 200, JSON.stringify(done.data));
    return done.data;
  };
  const fin = async (d) =>
    (
      await req(`/sales/deals/${d.id}/status`, {
        method: "POST",
        session: admin,
        body: { rev: d.rev, action: "finalize" },
      })
    ).data;
  const ownRow = (quotationTerms) => ({
    rev: 1,
    billTo: BILL_TO,
    overrides: { quotationTerms, agreementBody: null, invoiceTerms: null },
  });
  const stored = (patch) =>
    ctx.db
      .collection("sales_settings")
      .updateOne({ _id: "company" }, { $set: patch });
  before(async () => {
    D = await customer("Old Texts", "d@old.example");
  });
  it("a settings row that kept the first release's default texts reads as the new defaults; edits are kept", async () => {
    await put(NO_GST);
    await stored({ templates: LEGACY_DEFAULT_TEMPLATES });
    const view = await req("/sales/settings", { session: admin });
    assert.deepEqual(view.data.templates, view.data.defaults);
    assert.equal(
      view.data.templates.quotationTerms.includes(
        "GST is charged at the rates shown",
      ),
      false,
    );
    await stored({
      "templates.quotationTerms": "Custom terms for {{client.name}}.",
    });
    const kept = await req("/sales/settings", { session: admin });
    assert.equal(
      kept.data.templates.quotationTerms,
      "Custom terms for {{client.name}}.",
    );
    assert.equal(
      kept.data.templates.agreementBody,
      kept.data.defaults.agreementBody,
    );
    assert.equal(
      kept.data.templates.invoiceTerms,
      kept.data.defaults.invoiceTerms,
    );
    await stored({ templates: LEGACY_DEFAULT_TEMPLATES });
    // The documents are issued with the new texts (the default source).
    const d = await newDeal(D);
    const q = await issue(await fin(d), "quotation");
    assert.equal(q.status, 201, JSON.stringify(q.data));
    assert.equal(q.data.textSource, "default");
    const file = await raw(`/sales/documents/${q.data.id}/download`, {
      session: admin,
    });
    const text = pdfText(file.buffer).join("\n");
    assert.equal(/GST is charged at the rates shown/.test(text), false);
    assert.match(text, /to accept this quotation/i);
  });
  it("a client text equal to the old default acts as no custom text", async () => {
    await ctx.db.collection("sales_profiles").updateOne(
      { _id: D },
      {
        $set: ownRow(LEGACY_DEFAULT_TEMPLATES.quotationTerms),
      },
      { upsert: true },
    );
    const view = await req(`/customers/${D}/sales`, { session: admin });
    assert.equal(view.data.profile.overrides.quotationTerms, null);
    const d = await newDeal(D, admin, "Legacy override");
    const q = await issue(await fin(d), "quotation");
    assert.equal(q.status, 201, JSON.stringify(q.data));
    assert.equal(q.data.textSource, "default");
    await ctx.db.collection("sales_profiles").updateOne(
      { _id: D },
      {
        $set: {
          "overrides.quotationTerms": "Own terms for {{client.name}}.",
        },
      },
    );
    const own = await newDeal(D, admin, "Own override");
    const q2 = await issue(await fin(own), "quotation");
    assert.equal(q2.data.textSource, "client");
  });
  it("switching GST registration after a quotation blocks the invoice and agreement until a new quotation", async () => {
    // Without GST, then registered.
    await put(NO_GST);
    const d = await newDeal(D, admin, "Mode switch A");
    const q = await issue(await fin(d), "quotation");
    assert.equal(q.status, 201, JSON.stringify(q.data));
    await put(SETTINGS);
    const again = await deal(d.id);
    assert.deepEqual(
      again.modeChanged.map((m) => [m.label, m.gst]),
      [[`Quotation ${q.data.label}`, false]],
    );
    for (const type of ["invoice", "agreement"]) {
      const refused = await issue(again, type);
      assert.equal(refused.status, 409);
      assert.equal(refused.data.code, "gst-mode-changed");
      assert.match(
        refused.data.error,
        new RegExp(
          `${q.data.number} v1 was issued without GST, but you are now registered`,
        ),
      );
    }
    // A new quotation version is never blocked and clears the block.
    const q2 = await issue(again, "quotation");
    assert.equal(q2.status, 201, JSON.stringify(q2.data));
    const inv = await issue(await deal(d.id), "invoice");
    assert.equal(inv.status, 201, JSON.stringify(inv.data));
    assert.equal(inv.data.title, "Tax invoice");
    assert.deepEqual((await deal(d.id)).modeChanged, []);
  });
  it("and the other way round: registered quotation, then not registered", async () => {
    await put(SETTINGS);
    const d = await newDeal(D, admin, "Mode switch B");
    const q = await issue(await fin(d), "quotation");
    assert.equal(q.status, 201, JSON.stringify(q.data));
    await put(NO_GST);
    const refused = await issue(await deal(d.id), "agreement");
    assert.equal(refused.status, 409);
    assert.equal(refused.data.code, "gst-mode-changed");
    assert.match(
      refused.data.error,
      /v1 was issued with GST, but you are no longer registered/,
    );
    assert.equal((await issue(await deal(d.id), "quotation")).status, 201);
    const ok = await issue(await deal(d.id), "agreement");
    assert.equal(ok.status, 201, JSON.stringify(ok.data));
  });
  it("the advice names the next step, and the banner list holds only what still blocks", async () => {
    await put(SETTINGS);
    const d = await newDeal(D, admin, "Mode advice");
    const q = await issue(await fin(d), "quotation");
    const ag = await issue(await deal(d.id), "agreement");
    assert.equal(ag.status, 201, JSON.stringify(ag.data));
    await put(NO_GST);
    const view = await deal(d.id);
    // Only the latest document in the other mode, the agreement.
    assert.deepEqual(
      view.modeChanged.map((m) => [m.type, m.label, m.gst]),
      [["agreement", `Agreement ${ag.data.label}`, true]],
    );
    const refused = await issue(view, "invoice");
    assert.equal(refused.status, 409);
    assert.equal(refused.data.code, "gst-mode-changed");
    assert.match(refused.data.error, /Issue a new agreement version first\./);
    assert.equal(/reopen/i.test(refused.data.error), false);
    assert.ok(q.data.label);
    // A quotation with a past valid-until date also names reopening.
    await ctx.db
      .collection("sales_deals")
      .updateOne({ _id: d.id }, { $set: { validUntil: "2020-01-01" } });
    await put(SETTINGS);
    await ctx.db
      .collection("sales_documents")
      .updateMany(
        { dealId: d.id },
        { $set: { "snapshot.gstRegistered": false } },
      );
    const old = await issue(await deal(d.id), "invoice");
    assert.equal(old.status, 409);
    assert.match(old.data.error, /agreement version first/);
    await ctx.db
      .collection("sales_documents")
      .deleteOne({ dealId: d.id, type: "agreement" });
    const qOld = await issue(await deal(d.id), "invoice");
    assert.equal(qOld.status, 409);
    assert.match(
      qOld.data.error,
      /new quotation version first \(and then the agreement\)/,
    );
    assert.match(
      qOld.data.error,
      /valid-until date has passed: reopen the deal/,
    );
    // An active invoice ends the banner for good (nothing can be remedied).
    await ctx.db
      .collection("sales_documents")
      .updateMany(
        { dealId: d.id },
        { $set: { "snapshot.gstRegistered": true } },
      );
    const inv = await issue(await deal(d.id), "invoice");
    assert.equal(inv.status, 201, JSON.stringify(inv.data));
    await put(NO_GST);
    assert.deepEqual((await deal(d.id)).modeChanged, []);
    await put(SETTINGS);
  });
  it("the seller's GSTIN and state are only checked against each other while registered", async () => {
    const company = {
      ...NO_GST.company,
      gstin: "27AAACS9999K1ZD",
      stateCode: "",
    };
    assert.equal(
      (await put({ ...NO_GST, company })).company.gstin,
      company.gstin,
    );
    await put({ ...NO_GST, company: { ...company, stateCode: "29" } });
    const refused = await send({
      company: { ...company, address: ["x"], stateCode: "29" },
      gst: { registered: true },
    });
    assert.equal(refused.status, 400);
    assert.match(refused.data.error, /GSTIN/);
    await put({ ...NO_GST, company: { ...NO_GST.company } });
    await put(SETTINGS);
  });
});
