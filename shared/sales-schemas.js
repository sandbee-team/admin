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
      // Optional in both: a seller without GST registration needs no state
      // (complete(deal) demands it only when registered).
      stateCode: z.union([stateCode, z.literal("")]),
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

// Default texts (owner-editable in Sales settings; a client copy overrides
// one). Layout the PDF renderer understands: a line "N. TITLE IN CAPITALS" is
// a section heading, a line starting "N." or "N.N" is a numbered paragraph
// with a hanging indent, and an empty line separates paragraphs. They assume
// no address, GSTIN or PAN: {{tax.note}} says whether GST is charged.
export const DEFAULT_TEMPLATES = {
  quotationTerms: [
    "1. All prices are in Indian Rupees (INR). {{tax.note}}",
    "2. This quotation is valid until {{deal.validUntil}}. After that date, prices and scope may change.",
    "3. Payment: one-time fees (setup, onboarding and customisation) are payable 100% in advance. Subscription fees are payable in advance for each billing period.",
    "4. Work starts after we receive the signed Service Agreement, the advance payment and the details we need from you, such as logins, menu or product data and branding.",
    "5. Charges of third-party services (hosting, database, domain, SMS, WhatsApp, payment gateway and similar) are not included unless listed above; they are paid by you directly to those providers.",
    "6. Anything not listed in this quotation is out of scope and will be quoted separately.",
    "7. Our services are provided under our Service Agreement, which is signed before work starts.",
    "8. To accept this quotation, reply to {{company.email}} or call {{company.phone}}, quoting {{document.number}}.",
  ].join("\n"),
  agreementBody: [
    'This Service Agreement (the "Agreement") is made on {{document.date}} (the "Effective Date") between {{company.legalName}} (the "Provider") and {{client.name}} (the "Client"), whose details are set out above. Each is a "Party" and together they are the "Parties".',
    "",
    "1. DEFINITIONS",
    '1.1 "Services" means the software, setup, customisation, hosting management, support and other services listed in Schedule A.',
    '1.2 "Software" means the Provider\'s software applications made available to the Client as part of the Services, including their updates.',
    '1.3 "Client Data" means all data entered into or generated by the Software for the Client, such as products, menus, orders, bills, customer and staff records.',
    '1.4 "Client Accounts" means the third-party accounts in the Client\'s name on which the Services run, such as hosting, database, domain, storage, messaging and payment accounts.',
    '1.5 "Fees" means the amounts set out in Schedule A and in the Provider\'s invoices.',
    "",
    "2. SERVICES",
    "2.1 The Provider will provide the Services described in Schedule A with reasonable skill and care, in line with good industry practice.",
    "2.2 Setup work starts after this Agreement is signed, the advance payment is received and the Client has provided the information and access the Provider reasonably needs.",
    "2.3 Changes to the scope must be agreed in writing; email is enough. Work outside Schedule A will be quoted and billed separately.",
    "2.4 The Provider may update and improve the Software from time to time, provided that the features the Client has paid for are not materially reduced.",
    "",
    "3. TERM AND RENEWAL",
    "3.1 This Agreement starts on the Effective Date and continues for the subscription period stated in Schedule A or, if none is stated, for 12 months.",
    "3.2 It then renews automatically for further periods of the same length, unless either Party gives written notice at least 30 days before the end of the current period.",
    "3.3 The Provider may revise the subscription Fees for a renewal period by giving written notice at least 30 days before that period starts.",
    "",
    "4. FEES AND PAYMENT",
    "4.1 The Client will pay the Fees set out in Schedule A, which total {{deal.total}} ({{deal.totalWords}}) for the items listed there.",
    "4.2 One-time fees are payable 100% in advance. Subscription Fees are payable in advance for each billing period.",
    "4.3 Invoices are payable by the due date stated on them. {{tax.note}}",
    "4.4 Charges of third-party providers for the Client Accounts (such as hosting, database, domain, SMS, WhatsApp and payment gateway charges) are not part of the Fees and are paid by the Client directly to those providers, unless Schedule A says otherwise.",
    "4.5 If an invoice is still unpaid 7 days after its due date, the Provider may suspend the Services after written notice until all dues are cleared. Suspension does not reduce the Fees payable.",
    "4.6 Fees once paid are non-refundable, except as stated in clause 12.4.",
    "",
    "5. CLIENT ACCOUNTS AND THIRD-PARTY SERVICES",
    "5.1 The Software runs on Client Accounts opened in the Client's name. The Client owns these accounts and is responsible for keeping them active and paid.",
    "5.2 The Client authorises the Provider to access and operate the Client Accounts, with the access the Client provides, only as needed to provide the Services. The Provider will keep that access confidential and secure.",
    "5.3 Third-party services are governed by their own terms. The Provider is not responsible for their outages, limits, price changes or policy decisions, but will reasonably help the Client to work around them.",
    "",
    "6. CLIENT RESPONSIBILITIES",
    "6.1 The Client will: (a) provide accurate information and timely approvals; (b) keep its passwords and staff logins confidential and remove the access of staff who leave; (c) use the Services only for lawful business purposes and in line with applicable laws, including tax, consumer protection and data protection laws; and (d) check the bills, reports, tax figures and other outputs it relies on.",
    "6.2 The Client is responsible for the content and data it enters, and for obtaining any consent needed from its customers and staff.",
    "",
    "7. SUPPORT AND AVAILABILITY",
    "7.1 The Provider will give support by email and phone ({{company.email}}, {{company.phone}}) during its business hours, will respond promptly, and will handle first the issues that stop the Client's operations.",
    "7.2 The Provider will use reasonable efforts to keep the Services available, but does not promise uninterrupted or error-free operation. Planned maintenance will, where practical, be done outside the Client's main business hours.",
    "",
    "8. DATA PROTECTION AND CONFIDENTIALITY",
    "8.1 The Client owns the Client Data. The Provider will access and use Client Data only to provide and support the Services, or as required by law.",
    "8.2 Each Party will keep the other Party's confidential information secret and use it only for this Agreement. This does not apply to information that is public, already known to the receiving Party, independently developed, or required to be disclosed by law.",
    "8.3 The Provider will take reasonable security measures to protect Client Data and access credentials, and will inform the Client without undue delay of any security incident that affects them.",
    "8.4 Each Party will comply with the data protection laws of India that apply to it, including the Digital Personal Data Protection Act, 2023 and its rules as they come into force.",
    "8.5 These obligations continue for 3 years after this Agreement ends and, for access credentials and personal data, for as long as they are held.",
    "",
    "9. INTELLECTUAL PROPERTY",
    "9.1 The Software, its source code, designs and documentation, and all improvements to them, remain the property of the Provider or its licensors.",
    "9.2 During the term, and subject to payment of the Fees, the Provider grants the Client a non-exclusive, non-transferable right to use the Software for the Client's own business, including the outlets or locations listed in Schedule A, if any.",
    "9.3 The Client will not copy, resell, sublicense, modify or reverse engineer the Software, or try to obtain its source code, except as the law allows.",
    "9.4 The Client's name, logo, content and Client Data remain the property of the Client, who allows the Provider to use them only to provide the Services.",
    "",
    "10. WARRANTIES",
    "10.1 Each Party confirms that it is entitled to enter into this Agreement.",
    '10.2 Except as stated in this Agreement, the Services are provided "as is", and the Provider gives no other warranty, express or implied, including any warranty of fitness for a particular purpose.',
    "",
    "11. LIMITATION OF LIABILITY",
    "11.1 Neither Party is liable for any indirect or consequential loss, or for loss of profit, revenue, business or goodwill.",
    "11.2 The Provider's total liability under or in connection with this Agreement is limited to the Fees paid by the Client in the 12 months before the event that gave rise to the claim.",
    "11.3 Nothing in this Agreement limits liability for fraud, or any liability that cannot be limited by law.",
    "",
    "12. SUSPENSION AND TERMINATION",
    "12.1 Either Party may end this Agreement by written notice if the other Party commits a material breach and does not cure it within 15 days after receiving notice of it.",
    "12.2 The Provider may suspend the Services at once if continued use would break the law or seriously threaten the security of the Services or of other clients.",
    "12.3 When this Agreement ends: (a) the Client pays all Fees due up to the end date; (b) the Client's right to use the Software ends; and (c) for 30 days the Provider will, on request, help the Client export the Client Data in a common format and hand back control of the Client Accounts. After that, the Provider may delete its copies of Client Data and access credentials, unless the law requires otherwise.",
    "12.4 If the Client ends this Agreement under clause 12.1 because of the Provider's breach, the Provider will refund the prepaid subscription Fees for the unused period.",
    "",
    "13. FORCE MAJEURE",
    "13.1 Neither Party is liable for a delay or failure caused by events beyond its reasonable control, such as natural disasters, epidemics, war, government action, power or internet failures, or outages of third-party providers. This does not excuse payment for Services already provided.",
    "",
    "14. NOTICES",
    "14.1 Notices under this Agreement must be in writing and may be sent by email to the email addresses stated in this Agreement, or to another address a Party notifies. An email notice is treated as received on the next business day after it is sent, unless the sender receives a delivery failure message.",
    "",
    "15. GOVERNING LAW AND DISPUTES",
    "15.1 This Agreement is governed by the laws of India.",
    "15.2 The Parties will first try in good faith to settle any dispute by discussion within 30 days.",
    "15.3 A dispute that is not settled will be referred to a sole arbitrator appointed by the Parties under the Arbitration and Conciliation Act, 1996. The seat and venue of arbitration will be {{company.jurisdiction}}, and the language English.",
    "15.4 Subject to clause 15.3, the courts at {{company.jurisdiction}} have exclusive jurisdiction.",
    "",
    "16. GENERAL",
    "16.1 This Agreement, with Schedule A and the accepted quotation, is the entire agreement between the Parties on its subject and replaces earlier discussions. If they conflict, this Agreement prevails over the quotation.",
    "16.2 Changes to this Agreement are valid only if made in writing and accepted by both Parties; email is enough.",
    "16.3 Neither Party may assign this Agreement without the other's written consent, except to a successor of its whole business.",
    "16.4 The Parties are independent contractors. Nothing in this Agreement creates a partnership, agency or employment.",
    "16.5 If any provision is found invalid, the rest of this Agreement remains in force.",
    "16.6 A delay in enforcing a right is not a waiver of it.",
    "16.7 This Agreement may be signed in counterparts and signed and exchanged electronically, as permitted by the Information Technology Act, 2000.",
  ].join("\n"),
  invoiceTerms: [
    "1. {{tax.note}}",
    "2. Please pay the full amount by the due date shown above, quoting {{document.number}} as the payment reference.",
    "3. Fees once paid are non-refundable, except as stated in the Service Agreement.",
    "4. If this invoice is still unpaid 7 days after the due date, services may be suspended after notice until the dues are cleared.",
    "5. For billing questions, write to {{company.email}} or call {{company.phone}}.",
  ].join("\n"),
};

// The default texts of the first release (GST assumed, address and GSTIN
// printed). Settings and client texts stored equal to these were never edited
// and read as the current defaults.
export const LEGACY_DEFAULT_TEMPLATES = {
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
          // City whose courts and arbitration seat the agreement names.
          jurisdiction: pdfText(60).default(""),
        })
        .strict()
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
          // false: no GST on any document (the seller is not registered).
          registered: z.boolean().default(false),
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
      design: z
        .object({
          // The documents' accent colour; default = the panel's brand green.
          accent: z
            .string()
            .regex(/^#[0-9A-Fa-f]{6}$/, "must be a colour like #355E45")
            .transform((v) => v.toUpperCase())
            .default("#355E45"),
        })
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
    .strict()
    // The seller's GSTIN is only used (and its state only checked) while
    // registered: an unregistered seller may keep or clear either freely.
    .superRefine((v, ctx) => {
      const c = v.company;
      if (v.gst.registered && c.gstin && c.gstin.slice(0, 2) !== c.stateCode)
        ctx.addIssue({
          code: "custom",
          path: ["company"],
          message: "GSTIN state does not match the state",
        });
    }),
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
      // "" only for a seller without GST registration (checked in complete()).
      placeOfSupply: z.union([stateCode, z.literal("")]),
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
