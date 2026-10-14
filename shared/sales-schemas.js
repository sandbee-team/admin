// Strict request schemas for the sales module (server side; the editor uses
// shared/sales.js only). Messages never echo submitted values.
import { z } from "zod";
import {
  STATES,
  GST_RATES,
  DOC_TYPES,
  DISCOUNT_TYPES,
  MAX_LINES,
  MAX_QTY,
  MAX_UNIT_PRICE,
  PREFIX_RE,
  SAC_RE,
  PAN_RE,
  IFSC_RE,
  PIN_RE,
  UPI_RE,
  INVOICE_NUMBER_MAX,
  TEMPLATE_KEYS,
  validGstin,
  normalizeText,
  unprintable,
  unknownPlaceholders,
  computeTotals,
} from "./sales.js";

const CANNOT_PRINT =
  "contains characters the PDF cannot print (use Latin letters, digits and common punctuation)";
// Text that ends up in a PDF: normalised (₹ → Rs.), trimmed, printable.
const pdfText = (max, { multiline = false, min = 0 } = {}) =>
  z
    .string()
    .max(max * 2 + 100)
    .transform((v) => normalizeText(v).trim())
    .refine((v) => v.length <= max, `must be at most ${max} characters`)
    .refine((v) => v.length >= min, `must be at least ${min} characters`)
    .refine((v) => unprintable(v, { multiline }).length === 0, CANNOT_PRINT);
const blankOr = (re, message) =>
  z
    .string()
    .max(300)
    .transform((v) => v.trim())
    .refine((v) => v === "" || re.test(v), message);
const STATE_CODES = STATES.map(([code]) => code);
const stateCode = z.enum(STATE_CODES);
const gstin = z
  .string()
  .max(20)
  .transform((v) => v.trim().toUpperCase())
  .refine((v) => v === "" || validGstin(v), "is not a valid GSTIN");
const email = z.union([z.literal(""), z.email().max(254)]);
const date = z.union([z.iso.date(), z.literal("")]);
const rev = z.number().int().min(1);

const billToShape = (strict) =>
  z
    .object({
      name: strict ? pdfText(160, { min: 2 }) : pdfText(160),
      address: z.array(pdfText(160)).max(4).default([]),
      city: pdfText(60).default(""),
      stateCode: strict ? stateCode : z.union([stateCode, z.literal("")]),
      pincode: blankOr(PIN_RE, "must be a 6-digit PIN code").default(""),
      gstin: gstin.default(""),
      pan: blankOr(PAN_RE, "is not a valid PAN").default(""),
      email: email.default(""),
      phone: pdfText(32).default(""),
    })
    .strict()
    .refine(
      (b) => !b.gstin || b.gstin.slice(0, 2) === b.stateCode,
      "GSTIN state does not match the state",
    );
const discount = z
  .object({
    type: z.enum(DISCOUNT_TYPES),
    value: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .refine(
    (d) => d.type !== "percent" || d.value <= 10000,
    "percent is at most 100",
  );
const line = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{1,40}$/),
    productId: z.union([z.uuid(), z.literal("")]).default(""),
    description: pdfText(300, { multiline: true, min: 1 }).refine(
      (v) => v.split("\n").length <= 8,
      "can have at most 8 lines",
    ),
    sac: z.string().regex(SAC_RE, "SAC must be 4-8 digits"),
    unit: pdfText(12).default(""),
    qty: z.number().int().min(1).max(MAX_QTY),
    unitPrice: z.number().int().min(0).max(MAX_UNIT_PRICE),
    discount,
    gstRate: z
      .number()
      .int()
      .refine((v) => GST_RATES.includes(v), "is not an allowed GST rate"),
  })
  .strict();
const template = (max) =>
  pdfText(max, { multiline: true }).refine(
    (v) => unknownPlaceholders(v).length === 0,
    "uses an unknown {{placeholder}}",
  );
const MAX_TEXT = {
  quotationTerms: 4000,
  agreementBody: 20000,
  invoiceTerms: 4000,
};

export const DEFAULT_TEMPLATES = {
  quotationTerms: [
    "1. Prices are in Indian Rupees. GST is charged at the rates shown.",
    "2. This quotation is valid until {{deal.validUntil}}.",
    "3. Payment: 100% in advance unless agreed otherwise in writing.",
    "4. Work starts after the signed agreement and the payment are received.",
  ].join("\n"),
  agreementBody: [
    "SAMPLE TEXT - replace it with your reviewed agreement before use.",
    "",
    "This Service Agreement is made on {{document.date}} between {{company.legalName}}, {{company.address}} (GSTIN {{company.gstin}}) (the Provider) and {{client.name}}, {{client.address}} (the Client).",
    "",
    "1. Services. The Provider will supply the products and services listed in Schedule A.",
    "2. Fees. The Client will pay {{deal.total}} ({{deal.totalWords}}) as set out in Schedule A, including the taxes shown.",
    "3. Payment. Fees are payable as stated in the invoice.",
    "4. Confidentiality. Each party keeps the other party's confidential information private.",
    "5. Governing law. This agreement is governed by the laws of India.",
  ].join("\n"),
  invoiceTerms: [
    "1. Please pay by the due date to the bank account or UPI ID shown.",
    "2. Please quote the invoice number with your payment.",
  ].join("\n"),
};

export const salesSchemas = {
  settings: z
    .object({
      company: z
        .object({
          legalName: pdfText(160).default(""),
          tradeName: pdfText(160).default(""),
          address: z.array(pdfText(160)).max(4).default([]),
          city: pdfText(60).default(""),
          stateCode: z.union([stateCode, z.literal("")]).default(""),
          pincode: blankOr(PIN_RE, "must be a 6-digit PIN code").default(""),
          gstin: gstin.default(""),
          pan: blankOr(PAN_RE, "is not a valid PAN").default(""),
          email: email.default(""),
          phone: pdfText(32).default(""),
          website: pdfText(120).default(""),
        })
        .strict()
        .refine(
          (c) => !c.gstin || c.gstin.slice(0, 2) === c.stateCode,
          "GSTIN state does not match the state",
        )
        .prefault({}),
      bank: z
        .object({
          accountName: pdfText(160).default(""),
          accountNumber: blankOr(
            /^[0-9A-Z]{6,24}$/,
            "is not a valid account number",
          ).default(""),
          ifsc: blankOr(IFSC_RE, "is not a valid IFSC").default(""),
          bankName: pdfText(120).default(""),
          branch: pdfText(120).default(""),
          upiId: blankOr(UPI_RE, "is not a valid UPI ID").default(""),
        })
        .strict()
        .prefault({}),
      signatory: z
        .object({
          name: pdfText(120).default(""),
          title: pdfText(120).default("Authorised Signatory"),
        })
        .strict()
        .prefault({}),
      numbering: z
        .object(
          Object.fromEntries(
            [
              ["quotation", "QT/"],
              ["agreement", "AG/"],
              ["invoice", "INV/"],
            ].map(([type, prefix]) => [
              type,
              z
                .object({
                  prefix: z
                    .string()
                    .regex(
                      PREFIX_RE,
                      "prefix: up to 6 of A-Z, a-z, 0-9, / and -",
                    )
                    .default(prefix),
                })
                .strict()
                .prefault({}),
            ]),
          ),
        )
        .strict()
        .refine(
          // <prefix><yy-yy>/<0001> must fit Rule 46(b)'s 16 characters.
          (n) => n.invoice.prefix.length + 10 <= INVOICE_NUMBER_MAX,
          "invoice numbers must stay within 16 characters",
        )
        // Counters are per type: the prefixes alone keep a quotation, an
        // agreement and an invoice from printing the same number.
        .refine(
          (n) =>
            n.invoice.prefix !== "" &&
            new Set([n.quotation.prefix, n.agreement.prefix, n.invoice.prefix])
              .size === 3,
          "the three prefixes must differ and the invoice prefix cannot be empty",
        )
        .prefault({}),
      gst: z
        .object({
          defaultSac: z.string().regex(SAC_RE).default("998314"),
          defaultRate: z
            .number()
            .int()
            .refine((v) => GST_RATES.includes(v))
            .default(1800),
          roundOff: z.boolean().default(true),
        })
        .strict()
        .prefault({}),
      quotation: z
        .object({ validityDays: z.number().int().min(1).max(365).default(15) })
        .strict()
        .prefault({}),
      invoice: z
        .object({ dueDays: z.number().int().min(0).max(365).default(7) })
        .strict()
        .prefault({}),
      templates: z
        .object(
          Object.fromEntries(
            TEMPLATE_KEYS.map((key) => [
              key,
              template(MAX_TEXT[key]).default(DEFAULT_TEMPLATES[key]),
            ]),
          ),
        )
        .strict()
        .prefault({}),
    })
    .strict(),
  profile: z
    .object({
      billTo: billToShape(false),
      overrides: z
        .object(
          Object.fromEntries(
            TEMPLATE_KEYS.map((key) => [
              key,
              z.union([template(MAX_TEXT[key]), z.null()]).default(null),
            ]),
          ),
        )
        .strict()
        .prefault({}),
    })
    .strict(),
  deal: z
    .object({
      title: pdfText(160, { min: 2 }),
      billTo: billToShape(true),
      placeOfSupply: stateCode,
      lines: z.array(line).max(MAX_LINES),
      discount,
      validUntil: date.default(""),
      notes: pdfText(2000, { multiline: true }).default(""),
    })
    .strict()
    .refine(
      (d) => new Set(d.lines.map((l) => l.id)).size === d.lines.length,
      "line ids must be unique",
    )
    .superRefine((d, ctx) => {
      try {
        computeTotals(d, { sellerState: d.placeOfSupply, roundOff: false });
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        ctx.addIssue({ code: "custom", message: error.message });
      }
    }),
  newDeal: z.object({ title: pdfText(160, { min: 2 }) }).strict(),
  status: z
    .object({ rev, action: z.enum(["finalize", "reopen", "lost"]) })
    .strict(),
  issue: z.object({ rev, type: z.enum(DOC_TYPES) }).strict(),
  preview: z.object({ type: z.enum(DOC_TYPES) }).strict(),
  email: z
    .object({
      to: z
        .array(z.email().max(254))
        .min(1)
        .max(3)
        .transform((v) => [...new Set(v.map((e) => e.toLowerCase()))]),
      message: z
        .string()
        .max(1000)
        .transform((v) =>
          normalizeText(v)
            .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "")
            .trim(),
        )
        .default(""),
    })
    .strict(),
  cancel: z
    .object({
      reason: z
        .string()
        .max(600)
        .transform((v) => normalizeText(v).trim())
        .refine(
          (v) => v.length >= 5 && v.length <= 300,
          "must be 5-300 characters",
        )
        .refine((v) => unprintable(v).length === 0, CANNOT_PRINT),
    })
    .strict(),
  withRev: z.object({ rev }).strict(),
};
