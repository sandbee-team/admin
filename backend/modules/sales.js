// Sales documents: company settings, client billing profiles, deals and the
// immutable quotation / agreement / tax-invoice documents issued from them
// (docs/SALES-DOCS-PLAN.md). Permissions: `sales` (owner, admin) for deals and
// documents; `billing` (owner) + step-up for settings, cancelling and a
// client's own quotation/invoice terms (they print next to the payment details).
import { Router } from "express";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  salesSchemas,
  DEFAULT_TEMPLATES,
  LEGACY_DEFAULT_TEMPLATES,
} from "../../shared/sales-schemas.js";
import {
  DOC_TITLES,
  DOC_TYPES,
  computeTotals,
  docNumber,
  fyOf,
  formatDate,
  istDate,
  versionLabel,
  INVOICE_NUMBER_MAX,
  normalizeText,
} from "../../shared/sales.js";
import { can } from "../../shared/policy.js";
import { ensure, HttpError, staleError } from "../lib/errors.js";
import { audit } from "../lib/audit.js";
import { consume } from "../lib/limiter.js";
import { encodeRfc3986 } from "../lib/s3.js";
import {
  createSealer,
  fileEntry,
  pushEntry,
  openSealed,
  SealedIntegrityError,
  aadOf as fileAad,
  keyOf as fileKey,
} from "../lib/file-store.js";
import { parseImage, ImageError, MAX_IMAGE_BYTES } from "../lib/pdf-images.js";
import { snapshotOf, renderDocument } from "../lib/sales-pdf.js";
import { transaction } from "../db.js";
import { authorizeWrite } from "./records.js";

const SETTINGS_ID = "company";
// Client texts printed next to the payment details: changed by owners only.
const PAYMENT_TEXTS = ["quotationTerms", "invoiceTerms"];
const IMAGE_KINDS = ["logo", "signature"];
const HOUR = 3600000;
const LIST_LIMIT = 200;
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const by = (staff) => ({ id: staff._id, name: staff.name });
const short = (id) => id.slice(0, 8);
const conflict = (message, code) => {
  const error = new HttpError(409, message);
  if (code) error.apiCode = code;
  return error;
};
const notConfigured = (message) => {
  const error = new HttpError(503, message, true);
  error.apiCode = "not-configured";
  return error;
};

// What each document type needs from the company profile. Without GST
// registration (the default) only the name and contact details: no address,
// state or GSTIN. Registered: Rule 46 particulars (GSTIN on invoices).
export function readiness(settings) {
  const c = settings.company,
    registered = settings.gst?.registered === true,
    gaps = (pairs) => pairs.filter(([, v]) => !v).map(([id]) => id),
    common = [
      ["legal-name", c.legalName],
      ...(registered
        ? [
            ["address", c.address?.[0]],
            ["state", c.stateCode],
          ]
        : []),
      ["email", c.email],
      ["phone", c.phone],
    ],
    missing = {
      quotation: gaps(common),
      agreement: gaps([...common, ["jurisdiction", c.jurisdiction]]),
      invoice: gaps([...common, ...(registered ? [["gstin", c.gstin]] : [])]),
    };
  return {
    registered,
    quotation: missing.quotation.length === 0,
    agreement: missing.agreement.length === 0,
    invoice: missing.invoice.length === 0,
    missing,
  };
}
const MISSING_TEXT = {
  "legal-name": "the company's legal name",
  address: "the company address",
  state: "the company state",
  gstin: "the company GSTIN",
  email: "the company email",
  phone: "the company phone",
  jurisdiction: "the jurisdiction city (for the agreement)",
};

// Without GST registration the invoice is just an "Invoice" (no GST charged).
const docTitle = (doc) =>
  doc.type === "invoice" && doc.snapshot?.totals?.registered === false
    ? "Invoice"
    : DOC_TITLES[doc.type];

// A text stored exactly equal to the first release's default was never edited:
// it reads as the current default (settings) or as "no custom text" (a client).
const currentTemplates = (templates = {}) =>
  Object.fromEntries(
    Object.entries({ ...DEFAULT_TEMPLATES, ...templates }).map(([k, v]) => [
      k,
      v === LEGACY_DEFAULT_TEMPLATES[k] ? DEFAULT_TEMPLATES[k] : v,
    ]),
  );
const currentOverrides = (overrides) =>
  overrides &&
  Object.fromEntries(
    Object.entries(overrides).map(([k, v]) => [
      k,
      v === LEGACY_DEFAULT_TEMPLATES[k] ? null : v,
    ]),
  );
// Documents already issued for a deal in the other GST mode (a snapshot
// without gstRegistered is format 1 = registered).
const modeOf = (doc) => doc.snapshot?.gstRegistered !== false;
const modeText = (registered) => (registered ? "with GST" : "without GST");

const imageMeta = (meta) =>
  meta
    ? {
        set: true,
        type: meta.type,
        width: meta.width,
        height: meta.height,
        size: meta.size,
      }
    : { set: false };
const settingsView = (s, next) => ({
  rev: s.rev,
  company: s.company,
  bank: s.bank,
  signatory: s.signatory,
  numbering: s.numbering,
  gst: { ...s.gst, registered: s.gst.registered === true },
  design: s.design,
  quotation: s.quotation,
  invoice: s.invoice,
  templates: s.templates,
  defaults: salesSchemas.settings.parse({}).templates,
  images: {
    logo: imageMeta(s.images?.logo),
    signature: imageMeta(s.images?.signature),
  },
  ready: readiness(s),
  next,
  updatedAt: s.updatedAt ?? null,
  updatedBy: s.updatedBy?.name ?? null,
});
const profileView = (p) => ({
  rev: p.rev,
  billTo: p.billTo,
  overrides: currentOverrides(p.overrides),
  updatedAt: p.updatedAt ?? null,
});
// Totals for a stored deal with the current settings; null while the deal
// cannot be computed (an unsaved, incomplete draft).
function totalsOf(deal, settings) {
  try {
    return computeTotals(deal, {
      sellerState: settings.company.stateCode || deal.placeOfSupply,
      roundOff: settings.gst.roundOff,
      registered: settings.gst.registered === true,
    });
  } catch {
    return null;
  }
}
const dealSummary = (deal, settings) => ({
  id: deal._id,
  title: deal.title,
  status: deal.status,
  rev: deal.rev,
  lines: deal.lines.length,
  payable: totalsOf(deal, settings)?.payable ?? null,
  updatedAt: deal.updatedAt,
});
// `live`: ids of the customer's files that are not deleted (a copy deleted in
// the Files tab is no longer "stored").
const docView = (doc, live) => ({
  id: doc._id,
  dealId: doc.dealId,
  customerId: doc.customerId,
  type: doc.type,
  title: docTitle(doc),
  number: doc.number,
  version: doc.version,
  label: versionLabel(doc),
  status: doc.status,
  issuedAt: doc.issuedAt,
  issuedBy: doc.issuedBy.name,
  dealTitle: doc.snapshot.deal.title,
  payable: doc.snapshot.totals.payable,
  textSource: doc.snapshot.textSource,
  stored: Boolean(doc.pdf.fileId && live.has(doc.pdf.fileId)),
  size: doc.pdf.size,
  emails: (doc.emails ?? []).map((e) => ({
    at: e.at,
    by: e.by.name,
    to: e.to,
  })),
  cancelled: doc.cancelled
    ? {
        at: doc.cancelled.at,
        by: doc.cancelled.by.name,
        reason: doc.cancelled.reason,
      }
    : null,
});
const DEAL_FIELDS = [
  "title",
  "billTo",
  "placeOfSupply",
  "lines",
  "discount",
  "validUntil",
  "notes",
];
const fieldsOf = (deal) =>
  Object.fromEntries(DEAL_FIELDS.map((k) => [k, deal[k]]));
// The static deal schema cannot know the settings: the place of supply and the
// client's state are needed only for a GST-registered seller.
const statesGiven = (deal, settings) =>
  settings.gst.registered !== true ||
  Boolean(deal.placeOfSupply && deal.billTo?.stateCode);
const valid = (deal, settings) =>
  salesSchemas.deal.safeParse(fieldsOf(deal)).success &&
  statesGiven(deal, settings);
const complete = (deal, settings) =>
  deal.lines.length > 0 && valid(deal, settings);
const fileName = (doc) =>
  `${doc.type}-${doc.number.replaceAll("/", "-")}${doc.type === "invoice" ? "" : `-v${doc.version}`}.pdf`;
// Parsed logo/signature by hash (they never change): parsing re-inflates a PNG.
const parsed = new Map();
function parsedImage(sha, data) {
  if (!parsed.has(sha)) {
    if (parsed.size >= 8) parsed.delete(parsed.keys().next().value);
    parsed.set(sha, parseImage(data));
  }
  return parsed.get(sha);
}

export function salesRoutes({ db, client, c, auth, s3, sendDocument }) {
  const router = Router(),
    settingsCol = db.collection("sales_settings"),
    assets = db.collection("sales_assets"),
    counters = db.collection("sales_counters"),
    profiles = db.collection("sales_profiles"),
    deals = db.collection("sales_deals"),
    documents = db.collection("sales_documents"),
    customers = db.collection("customers");
  router.use(auth.requireAuth);

  async function loadSettings(session) {
    const row = await settingsCol.findOne({ _id: SETTINGS_ID }, { session });
    const defaults = salesSchemas.settings.parse({});
    return {
      ...defaults,
      ...row,
      // A section saved before a field existed gets that field's default.
      ...Object.fromEntries(
        ["company", "bank", "signatory", "gst", "design"].map((k) => [
          k,
          { ...defaults[k], ...row?.[k] },
        ]),
      ),
      templates: currentTemplates(row?.templates),
      rev: row?.rev ?? 0,
      images: { logo: null, signature: null, ...row?.images },
    };
  }
  // The next new number of each type in the current financial year.
  async function nextNumbers(settings) {
    const fy = fyOf(new Date()),
      out = {};
    for (const type of DOC_TYPES) {
      const row = await counters.findOne({ _id: `${type}:${fy.start}` });
      out[type] = docNumber(
        settings.numbering[type].prefix,
        fy.label,
        (row?.seq ?? 0) + 1,
      );
    }
    return out;
  }
  const settingsReply = async (settings) =>
    settingsView(settings, await nextNumbers(settings));
  async function loadCustomer(cid, session) {
    const row = await customers.findOne(
      { _id: cid },
      { session, projection: { name: 1, email: 1, company: 1, phone: 1 } },
    );
    ensure(row, 404, "Customer not found.");
    return row;
  }
  async function liveFiles(cid) {
    const row = await customers.findOne(
      { _id: cid },
      { projection: { "files.id": 1, "files.deletedAt": 1 } },
    );
    return new Set(
      (row?.files ?? []).filter((f) => !f.deletedAt).map((f) => f.id),
    );
  }
  async function loadProfile(customer, session) {
    const row = await profiles.findOne({ _id: customer._id }, { session });
    if (row) return row;
    // Nothing saved yet: start from the customer record (checked on save).
    return {
      _id: customer._id,
      rev: 0,
      billTo: {
        name: normalizeText(customer.company || customer.name)
          .trim()
          .slice(0, 160),
        address: [],
        city: "",
        stateCode: "",
        pincode: "",
        gstin: "",
        pan: "",
        email: customer.email ?? "",
        phone: String(customer.phone ?? "").slice(0, 32),
      },
      overrides: {
        quotationTerms: null,
        agreementBody: null,
        invoiceTerms: null,
      },
    };
  }
  async function loadDeal(id, session) {
    const deal = await deals.findOne({ _id: z.uuid().parse(id) }, { session });
    ensure(deal, 404, "Deal not found.");
    return deal;
  }
  async function loadDoc(id, session) {
    const doc = await documents.findOne(
      { _id: z.uuid().parse(id) },
      { session },
    );
    ensure(doc, 404, "Document not found.");
    return doc;
  }
  async function imagesFor(snapshotImages) {
    const out = { logo: null, signature: null };
    for (const kind of IMAGE_KINDS) {
      const sha = snapshotImages?.[kind];
      if (!sha) continue;
      const row = await assets.findOne({ _id: sha });
      // An asset still referenced by a document is never deleted; a missing
      // one only drops the picture.
      if (row) out[kind] = parsedImage(sha, Buffer.from(row.data.buffer));
    }
    return out;
  }
  const render = async (snapshot, options) =>
    renderDocument(snapshot, await imagesFor(snapshot.images), options);
  // Mutations of a deal bump its rev, so a stale form or a double click gets 409.
  async function claimDeal(session, id, rev, extra = {}) {
    const deal = await deals.findOneAndUpdate(
      { _id: id, rev },
      { $inc: { rev: 1 }, $set: { updatedAt: new Date(), ...extra } },
      { session, returnDocument: "before" },
    );
    if (!deal) throw staleError("This deal changed. Reload it and try again.");
    return deal;
  }
  async function dealReply(id) {
    const deal = await loadDeal(id);
    const [settings, docs, live] = await Promise.all([
      loadSettings(),
      documents
        .find({ dealId: id }, { sort: { issuedAt: -1 } })
        .limit(LIST_LIMIT)
        .toArray(),
      liveFiles(deal.customerId),
    ]);
    return {
      id: deal._id,
      customerId: deal.customerId,
      rev: deal.rev,
      status: deal.status,
      title: deal.title,
      billTo: deal.billTo,
      placeOfSupply: deal.placeOfSupply,
      lines: deal.lines,
      discount: deal.discount,
      validUntil: deal.validUntil,
      notes: deal.notes,
      createdAt: deal.createdAt,
      createdBy: deal.createdBy.name,
      updatedAt: deal.updatedAt,
      finalizedAt: deal.finalizedAt ?? null,
      sellerState: settings.company.stateCode,
      roundOff: settings.gst.roundOff,
      registered: settings.gst.registered === true,
      // Issued documents whose GST mode differs from the current setting.
      // Only a quotation or agreement that still blocks the next document:
      // nothing once an invoice is active, else the latest one in the other
      // mode.
      modeChanged: docs.some(
        (d) => d.type === "invoice" && d.status === "issued",
      )
        ? []
        : docs
            .filter(
              (d) =>
                d.type !== "invoice" &&
                d.status === "issued" &&
                modeOf(d) !== (settings.gst.registered === true),
            )
            .slice(0, 1)
            .map((d) => ({
              id: d._id,
              type: d.type,
              label: `${docTitle(d)} ${versionLabel(d)}`,
              gst: modeOf(d),
            })),
      ready: readiness(settings),
      storage: Boolean(s3),
      totals: totalsOf(deal, settings),
      documents: docs.map((d) => docView(d, live)),
    };
  }
  const docReply = async (doc) => docView(doc, await liveFiles(doc.customerId));

  // ---- Settings ----------------------------------------------------------
  router.get("/sales/settings", auth.permit("sales"), async (_req, res) => {
    res.json(await settingsReply(await loadSettings()));
  });
  router.put(
    "/sales/settings",
    auth.permit("billing"),
    auth.requireStepUp,
    async (req, res) => {
      const { rev, ...body } = req.body ?? {};
      const expected = z.number().int().min(0).parse(rev);
      const data = salesSchemas.settings.parse(body);
      const saved = await transaction(client, async (session) => {
        await authorizeWrite(db, session, req.staff, "billing");
        const now = new Date(),
          set = { ...data, updatedAt: now, updatedBy: by(req.staff) };
        if (expected === 0) {
          try {
            await settingsCol.insertOne(
              {
                _id: SETTINGS_ID,
                rev: 1,
                images: { logo: null, signature: null },
                ...set,
              },
              { session },
            );
          } catch (error) {
            if (error.code === 11000)
              throw staleError("Settings changed. Reload them and try again.");
            throw error;
          }
        } else {
          const done = await settingsCol.updateOne(
            { _id: SETTINGS_ID, rev: expected },
            { $set: set, $inc: { rev: 1 } },
            { session },
          );
          if (!done.matchedCount)
            throw staleError("Settings changed. Reload them and try again.");
        }
        await audit(
          db,
          session,
          req.staff,
          "sales.settings-updated",
          "sales",
          "sales-settings",
          "Company, numbering and texts",
          req,
        );
        return loadSettings(session);
      });
      res.json(await settingsReply(saved));
    },
  );
  // Sets or clears one image; the replaced image's bytes are removed when no
  // issued document refers to them (so trial uploads do not pile up).
  async function setImage(session, kind, meta, staff) {
    const row = await settingsCol.findOne({ _id: SETTINGS_ID }, { session });
    const now = new Date();
    if (!row)
      await settingsCol.insertOne(
        {
          _id: SETTINGS_ID,
          rev: 1,
          ...salesSchemas.settings.parse({}),
          images: { logo: null, signature: null, [kind]: meta },
          updatedAt: now,
          updatedBy: by(staff),
        },
        { session },
      );
    else
      await settingsCol.updateOne(
        { _id: SETTINGS_ID },
        {
          $set: {
            [`images.${kind}`]: meta,
            updatedAt: now,
            updatedBy: by(staff),
          },
          $inc: { rev: 1 },
        },
        { session },
      );
    const old = row?.images?.[kind]?.sha256;
    if (
      old &&
      old !== meta?.sha256 &&
      old !== row.images?.[kind === "logo" ? "signature" : "logo"]?.sha256 &&
      !(await documents.findOne(
        {
          $or: [
            { "snapshot.images.logo": old },
            { "snapshot.images.signature": old },
          ],
        },
        { session, projection: { _id: 1 } },
      ))
    )
      await assets.deleteOne({ _id: old }, { session });
  }
  router.put(
    "/sales/settings/images/:kind",
    auth.permit("billing"),
    auth.requireStepUp,
    async (req, res) => {
      res.set("Connection", "close");
      const kind = z.enum(IMAGE_KINDS).parse(req.params.kind);
      await consume(db, `sales-image:${req.staff._id}`, 30, HOUR);
      const raw = req.get("content-length");
      ensure(raw !== undefined, 411, "Content-Length is required.");
      ensure(/^\d{1,9}$/.test(raw), 400, "Invalid Content-Length.");
      const length = Number(raw);
      ensure(length >= 1, 400, "The image is empty.");
      ensure(length <= MAX_IMAGE_BYTES, 413, "Images can be at most 512 KB.");
      const parts = [];
      let received = 0;
      // Read to the end even after a problem (breaking early would destroy the
      // socket before the error response is written).
      for await (const chunk of req) {
        received += chunk.length;
        if (received <= length) parts.push(chunk);
      }
      ensure(
        received === length,
        400,
        "The upload length does not match Content-Length.",
      );
      res.removeHeader("Connection");
      const data = Buffer.concat(parts);
      let image;
      try {
        image = parseImage(data);
      } catch (error) {
        if (error instanceof ImageError)
          throw new HttpError(400, error.message);
        throw error;
      }
      const meta = {
        sha256: sha256(data),
        type: image.type,
        width: image.width,
        height: image.height,
        size: data.length,
      };
      const saved = await transaction(client, async (session) => {
        await authorizeWrite(db, session, req.staff, "billing");
        await assets.updateOne(
          { _id: meta.sha256 },
          {
            $setOnInsert: {
              ...meta,
              _id: meta.sha256,
              data,
              createdAt: new Date(),
            },
          },
          { session, upsert: true },
        );
        await setImage(session, kind, meta, req.staff);
        await audit(
          db,
          session,
          req.staff,
          "sales.image-set",
          "sales",
          "sales-settings",
          `${kind}, ${image.type}, ${data.length} bytes`,
          req,
        );
        return loadSettings(session);
      });
      res.json(await settingsReply(saved));
    },
  );
  router.delete(
    "/sales/settings/images/:kind",
    auth.permit("billing"),
    auth.requireStepUp,
    async (req, res) => {
      const kind = z.enum(IMAGE_KINDS).parse(req.params.kind);
      const saved = await transaction(client, async (session) => {
        await authorizeWrite(db, session, req.staff, "billing");
        await setImage(session, kind, null, req.staff);
        await audit(
          db,
          session,
          req.staff,
          "sales.image-removed",
          "sales",
          "sales-settings",
          kind,
          req,
        );
        return loadSettings(session);
      });
      res.json(await settingsReply(saved));
    },
  );

  // ---- Client profile and lists ------------------------------------------
  router.get("/customers/:id/sales", auth.permit("sales"), async (req, res) => {
    const customer = await loadCustomer(z.uuid().parse(req.params.id));
    const [settings, profile, dealRows, docRows, live] = await Promise.all([
      loadSettings(),
      loadProfile(customer),
      deals
        .find({ customerId: customer._id }, { sort: { updatedAt: -1 } })
        .limit(LIST_LIMIT)
        .toArray(),
      documents
        .find({ customerId: customer._id }, { sort: { issuedAt: -1 } })
        .limit(LIST_LIMIT)
        .toArray(),
      liveFiles(customer._id),
    ]);
    res.json({
      customer: {
        id: customer._id,
        name: customer.name,
        email: customer.email,
      },
      profile: profileView(profile),
      deals: dealRows.map((d) => dealSummary(d, settings)),
      documents: docRows.map((d) => docView(d, live)),
      ready: readiness(settings),
      // The current default texts: a new client text starts as a copy.
      templates: settings.templates,
      storage: Boolean(s3),
      limited: dealRows.length === LIST_LIMIT || docRows.length === LIST_LIMIT,
    });
  });
  router.put(
    "/customers/:id/sales/profile",
    auth.permit("sales"),
    async (req, res) => {
      const cid = z.uuid().parse(req.params.id);
      const { rev, ...body } = req.body ?? {};
      const expected = z.number().int().min(0).parse(rev);
      const data = salesSchemas.profile.parse(body);
      // A client's own quotation and invoice terms print next to the payment
      // details, so changing them is a billing act (owner + step-up), like
      // bank details.
      const before = await profiles.findOne(
        { _id: cid },
        {
          projection: {
            "overrides.quotationTerms": 1,
            "overrides.invoiceTerms": 1,
          },
        },
      );
      const billingChange = PAYMENT_TEXTS.some(
        (key) =>
          (currentOverrides(before?.overrides)?.[key] ?? null) !==
          data.overrides[key],
      );
      if (billingChange) {
        ensure(
          can(req.staff.role, "billing"),
          403,
          "Only an owner can set a client's own quotation or invoice terms.",
        );
        auth.requireStepUp(req);
      }
      const saved = await transaction(client, async (session) => {
        await authorizeWrite(
          db,
          session,
          req.staff,
          billingChange ? "billing" : "sales",
        );
        await loadCustomer(cid, session);
        const now = new Date();
        if (expected === 0) {
          try {
            await profiles.insertOne(
              { _id: cid, rev: 1, ...data, updatedAt: now },
              { session },
            );
          } catch (error) {
            if (error.code === 11000)
              throw staleError(
                "Billing details changed. Reload and try again.",
              );
            throw error;
          }
        } else {
          const done = await profiles.updateOne(
            {
              _id: cid,
              rev: expected,
              // The step-up decision above holds only for these stored values.
              ...Object.fromEntries(
                PAYMENT_TEXTS.map((key) => [
                  `overrides.${key}`,
                  before?.overrides?.[key] ?? null,
                ]),
              ),
            },
            { $set: { ...data, updatedAt: now }, $inc: { rev: 1 } },
            { session },
          );
          if (!done.matchedCount)
            throw staleError("Billing details changed. Reload and try again.");
        }
        const custom = Object.entries(data.overrides)
          .filter(([, v]) => v !== null)
          .map(([k]) => k);
        await audit(
          db,
          session,
          req.staff,
          "sales.profile-updated",
          "sales",
          cid,
          custom.length
            ? `Custom texts: ${custom.join(", ")}`
            : "Billing details",
          req,
        );
        return profiles.findOne({ _id: cid }, { session });
      });
      res.json(profileView(saved));
    },
  );

  // ---- Deals -------------------------------------------------------------
  router.post(
    "/customers/:id/sales/deals",
    auth.permit("sales"),
    async (req, res) => {
      const cid = z.uuid().parse(req.params.id);
      const { title } = salesSchemas.newDeal.parse(req.body);
      const id = await transaction(client, async (session) => {
        await authorizeWrite(db, session, req.staff, "sales");
        const customer = await loadCustomer(cid, session),
          [settings, profile] = await Promise.all([
            loadSettings(session),
            loadProfile(customer, session),
          ]);
        const now = new Date(),
          row = {
            _id: randomUUID(),
            customerId: cid,
            rev: 1,
            status: "draft",
            title,
            billTo: profile.billTo,
            placeOfSupply:
              profile.billTo.stateCode || settings.company.stateCode || "",
            lines: [],
            discount: { type: "none", value: 0 },
            validUntil: "",
            notes: "",
            createdAt: now,
            createdBy: by(req.staff),
            updatedAt: now,
            finalizedAt: null,
          };
        await deals.insertOne(row, { session });
        // Titles are free text: the audit trail (open to every role) keeps ids.
        await audit(
          db,
          session,
          req.staff,
          "sales.deal-created",
          "sales",
          cid,
          `deal ${short(row._id)}`,
          req,
        );
        return row._id;
      });
      res.status(201).json(await dealReply(id));
    },
  );
  router.get("/sales/deals/:dealId", auth.permit("sales"), async (req, res) => {
    res.json(await dealReply(z.uuid().parse(req.params.dealId)));
  });
  router.put("/sales/deals/:dealId", auth.permit("sales"), async (req, res) => {
    const id = z.uuid().parse(req.params.dealId);
    const { rev, ...body } = req.body ?? {};
    const expected = z.number().int().min(1).parse(rev);
    const data = salesSchemas.deal.parse(body);
    await transaction(client, async (session) => {
      await authorizeWrite(db, session, req.staff, "sales");
      const ids = [
        ...new Set(data.lines.map((l) => l.productId).filter(Boolean)),
      ];
      if (ids.length)
        ensure(
          (await db
            .collection("products")
            .countDocuments({ _id: { $in: ids } }, { session })) === ids.length,
          400,
          "A line refers to a product that does not exist.",
        );
      const old = await claimDeal(session, id, expected, data);
      if (old.status !== "draft")
        throw conflict(
          "Only a draft deal can be edited. Reopen it first.",
          "deal-final",
        );
      await audit(
        db,
        session,
        req.staff,
        "sales.deal-updated",
        "sales",
        old.customerId,
        `deal ${short(id)}`,
        req,
      );
    });
    res.json(await dealReply(id));
  });
  router.post(
    "/sales/deals/:dealId/status",
    auth.permit("sales"),
    async (req, res) => {
      const id = z.uuid().parse(req.params.dealId);
      const { rev, action } = salesSchemas.status.parse(req.body);
      await transaction(client, async (session) => {
        await authorizeWrite(db, session, req.staff, "sales");
        const current = await loadDeal(id, session);
        const activeInvoice = await documents.findOne(
          { dealId: id, type: "invoice", status: "issued" },
          { session, projection: { _id: 1 } },
        );
        let next;
        if (action === "finalize") {
          ensure(
            current.status === "draft",
            409,
            "Only a draft deal can be finalised.",
          );
          if (!complete(current, await loadSettings(session)))
            throw conflict(
              "Complete the deal (bill-to, place of supply and at least one line) first.",
              "deal-incomplete",
            );
          next = { status: "final", finalizedAt: new Date() };
        } else if (action === "reopen") {
          ensure(
            current.status !== "draft",
            409,
            "This deal is already a draft.",
          );
          if (activeInvoice)
            throw conflict(
              "Cancel the deal's invoice before reopening it.",
              "invoice-active",
            );
          next = { status: "draft", finalizedAt: null };
        } else {
          ensure(
            current.status !== "lost",
            409,
            "This deal is already closed as lost.",
          );
          if (activeInvoice)
            throw conflict(
              "Cancel the deal's invoice before closing it.",
              "invoice-active",
            );
          next = { status: "lost" };
        }
        await claimDeal(session, id, rev, next);
        await audit(
          db,
          session,
          req.staff,
          `sales.deal-${action === "finalize" ? "finalized" : action === "reopen" ? "reopened" : "lost"}`,
          "sales",
          current.customerId,
          `deal ${short(id)}`,
          req,
        );
      });
      res.json(await dealReply(id));
    },
  );
  router.post(
    "/sales/deals/:dealId/preview",
    auth.permit("sales"),
    async (req, res) => {
      const { type } = salesSchemas.preview.parse(req.body);
      await consume(db, `sales-preview:${req.staff._id}`, 60, HOUR);
      const deal = await loadDeal(req.params.dealId);
      const [settings, profile] = await Promise.all([
        loadSettings(),
        profiles.findOne({ _id: deal.customerId }),
      ]);
      if (!valid(deal, settings))
        throw conflict(
          "Save a complete deal (bill-to, place of supply) before previewing.",
          "deal-incomplete",
        );
      const snapshot = snapshotOf({
        settings,
        overrides: currentOverrides(profile?.overrides),
        deal,
        type,
        number: null,
        version: 0,
        issuedAt: new Date(),
        draft: true,
      });
      sendPdf(res, await render(snapshot), `draft-${type}.pdf`);
    },
  );
  router.post(
    "/sales/deals/:dealId/issue",
    auth.permit("sales"),
    async (req, res) => {
      const id = z.uuid().parse(req.params.dealId);
      const { rev, type } = salesSchemas.issue.parse(req.body);
      const issued = await transaction(client, async (session) => {
        await authorizeWrite(db, session, req.staff, "sales");
        const deal = await claimDeal(session, id, rev, {
          lastIssuedAt: new Date(),
        });
        if (deal.status === "lost")
          throw conflict(
            "This deal is closed as lost. Reopen it first.",
            "deal-lost",
          );
        if (type !== "quotation" && deal.status !== "final")
          throw conflict(
            "Finalise the deal before issuing an agreement or invoice.",
            "deal-not-final",
          );
        const settings = await loadSettings(session),
          ready = readiness(settings);
        if (!complete(deal, settings))
          throw conflict(
            "Complete the deal (bill-to, place of supply and at least one line) first.",
            "deal-incomplete",
          );
        if (!ready[type]) {
          const missing = ready.missing[type];
          const error = conflict(
            `Add ${missing.map((m) => MISSING_TEXT[m]).join(", ")} in Sales settings first.`,
            "settings-incomplete",
          );
          error.items = missing;
          throw error;
        }
        if (type !== "quotation") {
          // Money printed on the earlier documents must stay the money of
          // this one: refuse when they were issued in the other GST mode.
          const registered = settings.gst.registered === true,
            stale = await documents.findOne(
              {
                dealId: id,
                status: "issued",
                type: {
                  $in: ["quotation", "agreement"].filter((t) => t !== type),
                },
                "snapshot.gstRegistered": registered ? false : { $ne: false },
              },
              { session, sort: { issuedAt: -1 } },
            );
          if (stale)
            throw conflict(
              `${DOC_TITLES[stale.type]} ${versionLabel(stale)} was issued ${modeText(modeOf(stale))}, but you are ${registered ? "now registered" : "no longer registered"}. Issue a new ${stale.type} version first${stale.type === "quotation" ? " (and then the agreement)" : ""}.${stale.type === "quotation" && deal.validUntil && deal.validUntil < istDate(new Date()) ? " The valid-until date has passed: reopen the deal and change it first." : ""}`,
              "gst-mode-changed",
            );
        }
        const issuedAt = new Date(),
          fy = fyOf(issuedAt);
        if (
          type === "quotation" &&
          deal.validUntil &&
          deal.validUntil < istDate(issuedAt)
        )
          throw conflict(
            "The quotation's valid-until date has passed. Change it first.",
            "valid-until-past",
          );
        if (
          type === "invoice" &&
          (await documents.findOne(
            { dealId: id, type: "invoice", status: "issued" },
            { session, projection: { _id: 1 } },
          ))
        )
          throw conflict(
            "This deal already has an invoice. Cancel it to issue a new one.",
            "invoice-exists",
          );
        const previous =
          type === "invoice"
            ? null
            : await documents.findOne(
                { dealId: id, type },
                { session, sort: { version: -1 } },
              );
        let number, version, seq, fyStart;
        if (previous) {
          ({ number, seq } = previous);
          fyStart = previous.fy;
          version = previous.version + 1;
        } else {
          const counter = await counters.findOneAndUpdate(
            { _id: `${type}:${fy.start}` },
            { $inc: { seq: 1 } },
            { session, upsert: true, returnDocument: "after" },
          );
          seq = counter.seq;
          fyStart = fy.start;
          version = 1;
          number = docNumber(settings.numbering[type].prefix, fy.label, seq);
          if (type === "invoice" && number.length > INVOICE_NUMBER_MAX)
            throw conflict(
              "The invoice number would exceed 16 characters. Shorten the invoice prefix.",
              "number-too-long",
            );
        }
        const quotation =
          type === "quotation"
            ? null
            : await documents.findOne(
                { dealId: id, type: "quotation", status: "issued" },
                { session, sort: { version: -1 } },
              );
        const profile = await profiles.findOne(
          { _id: deal.customerId },
          { session },
        );
        const snapshot = snapshotOf({
          settings,
          overrides: currentOverrides(profile?.overrides),
          deal,
          type,
          number,
          version,
          issuedAt,
          quotationRef: quotation ? versionLabel(quotation) : null,
        });
        // The image rows this document prints are written in this transaction:
        // a concurrent replacement that would delete them conflicts and retries.
        for (const sha of Object.values(snapshot.images).filter(Boolean))
          await assets.updateOne(
            { _id: sha },
            { $set: { usedAt: issuedAt } },
            { session },
          );
        // Pure work: a transaction retry renders again, nothing else happens.
        const pdf = await render(snapshot);
        const row = {
          _id: randomUUID(),
          dealId: id,
          customerId: deal.customerId,
          type,
          fy: fyStart,
          seq,
          number,
          version,
          status: "issued",
          issuedAt,
          issuedBy: by(req.staff),
          snapshot,
          pdf: { sha256: sha256(pdf), size: pdf.length, fileId: null },
          supersededBy: null,
          cancelled: null,
          emails: [],
        };
        await documents.insertOne(row, { session });
        if (previous)
          await documents.updateMany(
            { dealId: id, type, status: "issued", _id: { $ne: row._id } },
            { $set: { status: "superseded", supersededBy: row._id } },
            { session },
          );
        await audit(
          db,
          session,
          req.staff,
          "sales.issued",
          "sales",
          deal.customerId,
          `${type} ${versionLabel(row)}`,
          req,
        );
        return { row, pdf };
      });
      const fid = await storeCopy(issued.row, issued.pdf, req).catch(
        () => null,
      );
      res
        .status(201)
        .json(
          docView(
            { ...issued.row, pdf: { ...issued.row.pdf, fileId: fid || null } },
            new Set(fid ? [fid] : []),
          ),
        );
    },
  );

  // Seals the PDF into S3 as a customer file and links it to the document in
  // one transaction (replacing the link `replaces`, a copy deleted in Files).
  // Returns the file id, or false when storage is off; throws on failure.
  async function storeCopy(doc, pdf, req, replaces = null) {
    if (!s3) return false;
    const cid = doc.customerId,
      fid = randomUUID(),
      sealer = createSealer(cid, fid);
    sealer.update(pdf);
    const sealed = sealer.finish(c.VAULT_KEY),
      s3Key = fileKey(cid, fid);
    const { versionId } = await s3.put(s3Key, sealed.object);
    const entry = fileEntry({
      fid,
      name: fileName(doc),
      category: doc.type,
      size: pdf.length,
      sealed,
      ext: "pdf",
      s3Key,
      versionId,
      by: req.staff,
      now: new Date(),
    });
    try {
      await transaction(client, async (session) => {
        await authorizeWrite(db, session, req.staff, "sales");
        const linked = await documents.updateOne(
          { _id: doc._id, "pdf.fileId": replaces },
          { $set: { "pdf.fileId": fid } },
          { session },
        );
        if (!linked.matchedCount)
          throw conflict("This document's stored copy changed.", "stored");
        await pushEntry(customers, session, cid, entry);
        await audit(
          db,
          session,
          req.staff,
          "sales.stored",
          "sales",
          cid,
          `${doc.type} ${versionLabel(doc)}, ${pdf.length} bytes, ${short(fid)}`,
          req,
        );
      });
    } catch (error) {
      // As in the upload route: remove the object only when the record
      // verifiably does not point at it.
      const linked = await documents
        .findOne(
          { _id: doc._id, "pdf.fileId": fid },
          { projection: { _id: 1 } },
        )
        .catch(() => undefined);
      if (linked === null) await s3.del(s3Key).catch(() => {});
      throw error;
    }
    return fid;
  }
  // The archived copy when it exists and verifies; otherwise the PDF
  // re-rendered from the frozen snapshot (a cancelled one stamped CANCELLED).
  async function pdfOf(doc, req) {
    if (doc.status === "cancelled")
      return {
        pdf: await render(doc.snapshot, { stamp: "CANCELLED" }),
        source: "regenerated",
      };
    if (s3 && doc.pdf.fileId) {
      const row = await customers.findOne(
        {
          _id: doc.customerId,
          files: { $elemMatch: { id: doc.pdf.fileId, deletedAt: null } },
        },
        { projection: { files: { $elemMatch: { id: doc.pdf.fileId } } } },
      );
      const file = row?.files?.[0];
      if (file)
        try {
          const plain = await openSealed(
            s3,
            file,
            fileAad(doc.customerId, file.id),
            c.VAULT_KEY,
          );
          if (sha256(plain) === doc.pdf.sha256)
            return { pdf: plain, source: "archive" };
          throw new SealedIntegrityError();
        } catch (error) {
          const integrity = error instanceof SealedIntegrityError;
          // Storage trouble (503/410) also falls back to the snapshot.
          if (!integrity && error.s3Code === undefined) throw error;
          await audit(
            db,
            undefined,
            req.staff,
            integrity ? "sales.integrity-failed" : "sales.archive-unavailable",
            "sales",
            doc.customerId,
            `${doc.type} ${versionLabel(doc)}`,
            req,
          ).catch(() => {});
        }
    }
    return { pdf: await render(doc.snapshot), source: "regenerated" };
  }
  function sendPdf(res, pdf, name, source) {
    res
      .status(200)
      .set({
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeRfc3986(name)}`,
        "Content-Length": String(pdf.length),
        "X-Content-Type-Options": "nosniff",
        ...(source ? { "X-Document-Source": source } : {}),
      })
      .end(pdf);
  }

  // ---- Documents ---------------------------------------------------------
  router.get(
    "/sales/documents/:docId",
    auth.permit("sales"),
    async (req, res) => {
      res.json(await docReply(await loadDoc(req.params.docId)));
    },
  );
  router.post(
    "/sales/documents/:docId/download",
    auth.permit("sales"),
    async (req, res) => {
      z.object({})
        .strict()
        .parse(req.body ?? {});
      await consume(db, `sales-download:${req.staff._id}`, 120, HOUR);
      const doc = await loadDoc(req.params.docId);
      const { pdf, source } = await pdfOf(doc, req);
      await transaction(client, async (session) => {
        await authorizeWrite(db, session, req.staff, "sales");
        await audit(
          db,
          session,
          req.staff,
          "sales.downloaded",
          "sales",
          doc.customerId,
          `${doc.type} ${versionLabel(doc)}`,
          req,
        );
      });
      sendPdf(res, pdf, fileName(doc), source);
    },
  );
  router.post(
    "/sales/documents/:docId/store",
    auth.permit("sales"),
    async (req, res) => {
      z.object({})
        .strict()
        .parse(req.body ?? {});
      if (!s3) throw notConfigured("File storage is not configured.");
      const doc = await loadDoc(req.params.docId);
      ensure(
        doc.status !== "cancelled",
        409,
        "A cancelled document is not stored again.",
      );
      const live = await liveFiles(doc.customerId);
      ensure(
        !(doc.pdf.fileId && live.has(doc.pdf.fileId)),
        409,
        "This document already has a stored copy.",
      );
      const pdf = await render(doc.snapshot);
      ensure(
        sha256(pdf) === doc.pdf.sha256,
        409,
        "This document can no longer be reproduced exactly. Download it instead.",
      );
      // A copy deleted in Files is replaced inside storeCopy's transaction.
      const fid = await storeCopy(doc, pdf, req, doc.pdf.fileId);
      res.json(
        docView({ ...doc, pdf: { ...doc.pdf, fileId: fid } }, new Set([fid])),
      );
    },
  );
  router.post(
    "/sales/documents/:docId/email",
    auth.permit("sales"),
    async (req, res) => {
      const { to, message } = salesSchemas.email.parse(req.body);
      if (!sendDocument) throw notConfigured("E-mail is not configured.");
      const id = z.uuid().parse(req.params.docId);
      // Status and access are re-checked right before sending.
      const current = async () =>
        transaction(client, async (session) => {
          await authorizeWrite(db, session, req.staff, "sales");
          const doc = await loadDoc(id, session);
          ensure(
            doc.status === "issued",
            409,
            doc.status === "cancelled"
              ? "This document was cancelled."
              : "A newer version of this document exists. Send that one.",
          );
          return doc;
        });
      let doc = await current();
      await consume(db, `sales-email:${req.staff._id}`, 20, HOUR);
      await consume(db, `sales-email-doc:${doc._id}`, 5, HOUR);
      const { pdf } = await pdfOf(doc, req);
      doc = await current();
      const s = doc.snapshot,
        label = versionLabel(doc),
        title = docTitle(doc);
      const text = [
        `Dear ${s.buyer.name},`,
        "",
        `Please find attached ${title.toLowerCase()} ${label} from ${s.seller.legalName}${doc.type === "quotation" ? `, valid until ${formatDate(s.deal.validUntil)}` : doc.type === "invoice" ? `, due on ${formatDate(s.dueDate)}` : ""}.`,
        ...(message ? ["", message] : []),
        "",
        "Regards,",
        ...(s.signatory.name ? [s.signatory.name] : []),
        s.seller.legalName,
      ].join("\n");
      try {
        await sendDocument(to, {
          subject: `${title} ${label} - ${s.seller.legalName}`,
          text,
          replyTo: s.seller.email || undefined,
          filename: fileName(doc),
          content: pdf,
        });
      } catch {
        // SMTP text never reaches the client or the logs.
        throw new HttpError(
          502,
          "The e-mail could not be sent. Try again later.",
          true,
        );
      }
      const at = new Date();
      await transaction(client, async (session) => {
        await documents.updateOne(
          { _id: doc._id },
          {
            $push: {
              emails: { $each: [{ at, by: by(req.staff), to }], $slice: -50 },
            },
          },
          { session },
        );
        // Sent already: recorded even if the sender's access changed meanwhile.
        await audit(
          db,
          session,
          req.staff,
          "sales.emailed",
          "sales",
          doc.customerId,
          `${doc.type} ${label}, ${to.length} recipient${to.length === 1 ? "" : "s"}`,
          req,
        );
      });
      res.json(await docReply(await loadDoc(doc._id)));
    },
  );
  router.post(
    "/sales/documents/:docId/cancel",
    auth.permit("billing"),
    auth.requireStepUp,
    async (req, res) => {
      const { reason } = salesSchemas.cancel.parse(req.body);
      const id = z.uuid().parse(req.params.docId);
      const doc = await transaction(client, async (session) => {
        await authorizeWrite(db, session, req.staff, "billing");
        const current = await loadDoc(id, session);
        ensure(
          current.type !== "quotation",
          409,
          "Quotations are replaced by issuing a new version, not cancelled.",
        );
        ensure(
          current.status === "issued",
          409,
          "Only an issued document can be cancelled.",
        );
        await documents.updateOne(
          { _id: id, status: "issued" },
          {
            $set: {
              status: "cancelled",
              cancelled: { at: new Date(), by: by(req.staff), reason },
            },
          },
          { session },
        );
        await audit(
          db,
          session,
          req.staff,
          "sales.cancelled",
          "sales",
          current.customerId,
          `${current.type} ${versionLabel(current)}`,
          req,
        );
        return loadDoc(id, session);
      });
      res.json(await docReply(doc));
    },
  );
  return router;
}
