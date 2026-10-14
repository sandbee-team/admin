# Sales documents — quotation, agreement, invoice (plan)

**LIVE since 2026-10-15** (main @ 99809c8). **Revision 2 (D53, 2026-10-15, §15):** seller without
GST registration, new document design and standard texts — branch `sales-docs-2`.

Status: **APPROVED by the owner 2026-10-14** — every recommended default in §13 (no-dependency PDF
writer, `sales` = owner + admin and `billing` = owner + step-up, `QT/26-27/0001` numbering with the
round-off line, one invoice per deal); recorded as D52. Branch `sales-docs` from main @ 4082048
(not from `p5-stage3`; releasable on its own). Binding: `docs/ROADMAP.md` house method,
`docs/SECURITY.md`, `docs/POS-INTEGRATION.md` (next free decision D52).

Goal: from a customer's page, build a **deal** (products/services, quantities, unit prices,
discounts per line and overall, GST, validity, notes) and issue from it a **quotation** PDF; once the
deal is final, an **agreement** PDF and a **tax invoice** PDF from the same deal. Company profile,
numbering, GST handling and the texts (terms, agreement) are editable; per-client text overrides
never touch another client. Issued documents are immutable (a revision is a new version), audited,
stored through the existing sealed file store, and can be e-mailed through the existing mail module.

## 1. What the review found (verified in code)

| #  | Finding | Effect on the design |
| -- | ------- | -------------------- |
| F1 | Customers (`shared/schemas.js:27-43`) hold only name, email, company, phone, status, notes. No address, GSTIN or state. The generic PUT `$set`s every schema key (`backend/modules/records.js:317-322`), so adding optional fields to `customers` would let the existing customer form blank them. | Billing details live in a separate per-customer `sales_profiles` row, never in `customers`. |
| F2 | Catalog products (`shared/schemas.js:44-63`, seed `backend/modules/catalog-seed.js:2-49`) have name/slug/category/model/pricing enum but **no price, SAC or tax rate**. | A deal line copies the product's name as its description; price, SAC and GST rate are entered on the line (defaults from settings). The catalog is not changed. |
| F3 | Permissions are role grants (`shared/policy.js:2-19`); writes re-check the staff row inside the transaction (`authorizeWrite`, `records.js:12-28`); secret-grade actions add step-up (`auth.requireStepUp`, 428). | New grants `sales` (owner, admin) and `billing` (owner); every write uses `authorizeWrite` + `audit` in one transaction; billing writes need step-up. |
| F4 | File store (`backend/lib/file-store.js`): `createSealer` → `s3.put` → `pushEntry` into `customers.files` in a transaction with audit (`backend/modules/files.js:214-276`); download verifies magic, GCM tag and SHA-256 (`files.js:282-374`) but that code is private to the route. Categories `agreement, kyc, invoice, screenshot, db-backup, other`. | Issued PDFs are stored as normal customer files (new category `quotation`; `agreement`, `invoice` exist) → visible in the Files tab, covered by the snapshot box check. The download's verify/decrypt block is moved to `file-store.js` (`openSealed`) and reused; `files.js` behaviour unchanged. |
| F5 | Mail (`backend/modules/mail.js`): one nodemailer transport; `notifier` sends text only, no attachments. | New `documentMailer(c)` on the same transport (attachment, Reply-To). Injected as `sendDocument` like `sendCode`/`notify`, so tests use a fake. |
| F6 | JSON bodies are capped at 32 KB (`backend/app.js:89-95`); only the file upload route takes a raw body (`UPLOAD_PATH`). | Logo/signature upload = a second raw route (`PUT /sales/settings/images/:kind`, ≤ 512 KB) added to the raw-body matcher. |
| F7 | Snapshot (`backend/lib/snapshot.js:4-14,49-55`) refuses any snapshot whose collection set differs from `BACKUP_COLLECTIONS`; restore (`scripts/recovery.js:166-173`) inserts every listed collection. | New collections are added as **optional** in the snapshot check (older snapshots still restore; their sales collections are empty). |
| F8 | Audit rows filtered by `resourceId ∈ {customerId, its installations}` feed the customer Activity tab (`backend/modules/overview.js:223-260`). | Sales events use `resource: "sales"`, `resourceId: customerId` (settings: `sales-settings`), so they appear in the customer's Activity. |
| F9 | No PDF library in the tree. Fonts in `node_modules/@fontsource` are WOFF subsets without `₹`. Poppler `pdftotext` and PyMuPDF exist on this PC (verification only, not a dependency). | §5: a small no-dependency PDF writer (recommended) — standard Helvetica fonts, WinAnsi text, Flate streams, PNG/JPEG images. |
| F10 | Front end: customer workspace tabs (`frontend/src/pages/customer-workspace.jsx:27-33`), routing on 3 path segments (`frontend/src/main.jsx:116-136`), POST downloads through `download()` (`frontend/src/lib/api.js:72-93`), step-up through `withStepUp`. | New tab **Sales**, deal page as a 4th path segment, new page **Sales settings**. |

## 2. Decisions proposed (recorded as D52 after approval)

1. **Data in six new collections**, nothing embedded in `customers`: `sales_settings` (one row `company`), `sales_assets` (logo/signature bytes by SHA-256, immutable), `sales_counters` (`<type>:<fyStart>`), `sales_profiles` (`_id` = customerId), `sales_deals`, `sales_documents`.
2. **Immutable documents.** An issued document holds a frozen `snapshot` (seller, buyer, lines, computed totals, resolved texts, image hashes) and the PDF's SHA-256. No route ever `$set`s the snapshot; the only later changes are status (`issued` → `superseded`/`cancelled`), the one-time archive link (`pdf.fileId`) and the e-mail log. Quotation and agreement re-issues keep the number and add a version (`v2`); a tax invoice is never re-issued: cancel (owner + step-up, reason) and issue a new invoice with the next number.
3. **Money = integer paise**, BigInt for products, **half-up rounding to the paisa at each stated step** (§4), tax per line, optional round-off of the grand total to the rupee (shown as its own line). One shared module (`shared/sales.js`) computes the totals for the API, the PDF and the live editor, so the screen and the PDF cannot disagree.
4. **GST**: CGST + SGST (half each) when the place of supply's state equals the company's state, else IGST. Place of supply defaults to the bill-to state (registered recipient: recipient's location; unregistered: address on record), editable on the deal. India only (no export/SEZ in v1).
5. **Numbering**: per type and Indian financial year (April–March, by the issue date in IST), gapless (`$inc` inside the issue transaction), format `<prefix><yy-yy>/<0001>` (`QT/26-27/0001`, `AG/…`, `INV/…`); prefix ≤ 6 of `A-Z a-z 0-9 / -`; an invoice number must stay ≤ 16 characters (refused otherwise).
6. **Texts**: global templates in settings; a client override is a full copy stored on that client's `sales_profiles` row (copy-on-write); the text is resolved and frozen into the document at issue. Placeholders are a fixed whitelist (`{{client.name}}`, …), unknown ones are refused on save; no code, no HTML.
7. **PDF**: no new dependency (§5). Rupee amounts print as `Rs.` (the standard PDF fonts have no `₹`); text that the font cannot print is refused on save with the field named (never silently dropped).
8. **Storage**: on issue the PDF is sealed into S3 as a customer file (category = type) after the issue commits; if storage is off or fails, the document is still issued and the PDF is re-generated from the snapshot on download (`X-Document-Source: regenerated`); "Store copy" retries.

## 3. Data model

```
sales_settings {_id:"company", rev,
  company {legalName, tradeName, address[≤4 lines], city, stateCode, pincode, gstin, pan, email, phone, website},
  bank {accountName, accountNumber, ifsc, bankName, branch, upiId},
  signatory {name, title},
  numbering {quotation:{prefix}, agreement:{prefix}, invoice:{prefix}},
  gst {defaultSac, defaultRate (basis points, 1800 = 18 %), roundOff:bool},
  quotation {validityDays}, invoice {dueDays},
  templates {quotationTerms, agreementBody, invoiceTerms},
  images {logo|signature: {sha256, type, width, height, size} | null},
  updatedAt, updatedBy {id,name}}
sales_assets {_id: sha256, type:"png"|"jpeg", width, height, size, data: Binary, createdAt}
sales_counters {_id:"<type>:<fyStart>", seq}
sales_profiles {_id: customerId, rev, billTo {name, address[≤4], city, stateCode, pincode, gstin, pan, email, phone},
  overrides {quotationTerms|null, agreementBody|null, invoiceTerms|null}, updatedAt}
sales_deals {_id, customerId, rev, status: draft|final|lost, title, billTo{…}, placeOfSupply (state code),
  lines[≤50] {id, productId|"", description ≤300, sac, unit ≤12, qty (milli-units), unitPrice (paise),
              discount {type: none|percent|amount, value (basis points | paise)}, gstRate (basis points)},
  discount {type, value}, validUntil (date), notes ≤2000, createdAt, createdBy, updatedAt, finalizedAt}
sales_documents {_id, dealId, customerId, type: quotation|agreement|invoice, fy, seq, number, version,
  status: issued|superseded|cancelled, issuedAt, issuedBy, snapshot {…frozen…},
  pdf {sha256, size, fileId|null}, supersededBy|null, cancelled {at, by, reason}|null,
  emails[≤50] {at, by, to[]}}
```

Indexes: `sales_deals {customerId:1, updatedAt:-1}`; `sales_documents {customerId:1, issuedAt:-1}`,
`{dealId:1, issuedAt:-1}`, unique `{type:1, fy:1, seq:1, version:1}`. All six collections join
`indexes()` (`backend/db.js:62-75`) and the snapshot list (optional, F7). No secret boxes: bank
details are printed on every invoice by design and are not vault data.

## 4. Money and tax rules (`shared/sales.js`, unit-tested)

Inputs are integers: price in paise (≤ ₹10 crore), quantity in thousandths (≤ 1,00,000), percent in
basis points (0.01 %), GST rate in basis points from {0, 5, 12, 18, 28, 40} % (§6). Every division
rounds **half up** to the paisa (`roundDiv(a, b)` on BigInt; negative inputs never occur).

1. Line gross = qty × unit price (rounded).
2. Line discount = percent of gross (rounded) or a fixed amount ≤ gross. Line net = gross − discount.
3. Overall discount = percent of Σ net (rounded) or a fixed amount ≤ Σ net; spread over the lines in
   proportion to their net by the largest-remainder method (ties → earlier line), so the parts add up
   exactly. Line taxable value = net − its share (GST: a discount shown on the invoice reduces the
   taxable value — §6).
4. Tax per line: IGST = taxable × rate; CGST and SGST = taxable × rate/2 each (each rounded).
5. Total = Σ taxable + Σ tax. With round-off on: payable = total rounded half up to the rupee; the
   difference (−₹0.49 … +₹0.50) is printed as "Round off".
6. Amount in words: Indian system (crore, lakh, thousand), "Rupees … and … Paise Only".

## 5. PDF approach — recommended: no new dependency

`backend/lib/pdf.js` (≈ 350 lines): PDF 1.4 writer with the standard fonts Helvetica and
Helvetica-Bold (WinAnsiEncoding, width tables in `backend/lib/pdf-fonts.js` generated once from the
Base-14 metrics and pinned by a test), text width/wrap, lines, boxes, A4 pages with automatic page
breaks for long tables, Flate-compressed content streams (`node:zlib`), JPEG (DCTDecode) and 8-bit
PNG images (`backend/lib/pdf-images.js`: inflate, un-filter, alpha → SMask), fixed `/CreationDate`
(= issue time) and an `/ID` from the content hash, so the same snapshot gives the same bytes on the
same Node version. Text is real text (extractable, searchable). Pros: zero supply-chain surface,
small, fully testable, nothing to pin. Cons: no `₹` glyph (prints `Rs.`), Latin text only (Devanagari
names cannot be printed — refused with a clear message).

Alternative (needs your OK): `pdfkit` **0.17.2** (exact pin; brings fontkit, png-js, linebreak and
others) with an embedded TTF that has `₹`. More features (any Unicode font), much larger dependency
tree. Not recommended for v1.

Layouts (`backend/lib/sales-pdf.js`, A4, 40 pt margins, footer "Page n of N · number"):
- **Quotation**: logo + company block; title, number + version, date, valid until; bill-to with
  GSTIN and place of supply; line table (#, item + SAC, qty, rate, discount, taxable, GST, amount);
  totals (subtotal, line discounts, overall discount with its % or amount, taxable, CGST/SGST or
  IGST, round off, total), amount in words, notes, terms, bank/UPI, signature block.
- **Agreement**: parties (company and client with addresses, GSTIN/PAN), agreement body from the
  resolved template, "Schedule A — commercials" (same table and totals as the deal), signature
  blocks for both parties (company signature image if set; client lines blank).
- **Tax invoice**: "TAX INVOICE — Original for recipient"; every Rule 46 particular (§6): supplier
  name/address/GSTIN, invoice number and date, recipient name/address/GSTIN (or "Unregistered"),
  place of supply with state name and code, SAC per line, quantity and unit, value, discount,
  taxable value, CGST/SGST or IGST rate and amount per line, totals, reverse charge "No", signature
  (image or "Authorised signatory"), due date, bank/UPI, quotation reference.
- **Preview** of any type from a draft: same layout with a "DRAFT — not issued" mark and no number;
  never stored, never numbered.

## 6. GST rules applied (verified 2026-10-14)

| Rule | Applied as | Source (confidence) |
| ---- | ---------- | ------------------- |
| Tax invoice particulars, Rule 46 CGST Rules 2017 (a)–(q) | Invoice prints: supplier name, address, GSTIN; serial number; date; recipient name, address, GSTIN (or "Unregistered"); for an unregistered recipient name, address and **State name and code** (required ≥ ₹50,000, printed always); SAC; description; quantity and unit; total value; taxable value after discount; CGST/SGST or IGST rate and amount; place of supply with State name and code (printed always); reverse charge "No"; signature image or "Authorised signatory" (an electronic invoice needs no signature under the proviso). (r)/(s) QR/IRN and the e-invoice declaration apply only above the e-invoice threshold (not in v1). | Rule 46, CBIC tax repository `taxinformation.cbic.gov.in/content/html/tax_repository/gst/rules/cgst_rules/active/chapter6/rule46_v1.00.html` (high) |
| Serial number | "Consecutive serial number not exceeding sixteen characters … alphabets or numerals or special characters hyphen or dash and slash … unique for a financial year", one or more series → gapless counter per type and FY, allowed characters `A-Z a-z 0-9 - /`, ≤ 16 enforced for invoices | Rule 46(b) (high) |
| SAC digits | 4 digits mandatory up to ₹5 crore aggregate turnover, 6 above; we always print the full 6-digit SAC entered (default `998314`) | Notification 78/2020-Central Tax, 15-10-2020, from 01-04-2021, `gstcouncil.gov.in/sites/default/files/2024-05/notfctn-78-central-tax-english-2020.pdf` (high) |
| Place of supply (services) | Registered recipient: the recipient's location; unregistered: the address on record, else the supplier's location → default = bill-to state, editable; same state as the company → CGST + SGST (half each), else IGST | Section 12(2) IGST Act (rule high; official page not fetchable, wording from a secondary summary) |
| Rate | 18 % for IT services (SAC 998313/998314/998315), unchanged by the September 2025 rate rationalisation (Notification 15/2025-CT(Rate), 17-09-2025, from 22-09-2025, does not touch heading 9983). Allowed rates: 0, 5, 12, 18, 28, 40 %; default 18 %. Which SAC fits a SaaS subscription (998315 / 997331 / other) is the owner's/CA's choice per line. | Notification 11/2017-CT(Rate) heading 9983; 15/2025-CT(Rate) (medium-high; text read from a Gazette mirror) |
| Discount | A discount given before or at the time of supply and recorded on the invoice is not part of the value → printed per line and overall; taxable value = after both | Section 15(3) CGST Act, `cbic-gst.gov.in/pdf/CGST-Act-Updated-30092020.pdf` (high) |
| Rounding | Section 170 rounds tax/sums **payable** to the nearest rupee; it does not require whole-rupee invoice lines → tax kept to the paisa per line; optional "Round off" line on the total | Section 170 CGST Act (text high; interpretation medium, no official FAQ found) |
| E-invoicing | Mandatory only above ₹5 crore aggregate turnover in any FY since 2017-18 (Notification 10/2023-CT, from 01-08-2023); not implemented — the settings page states this limit | 10/2023-CT (high on threshold; original notification not fetched) |
| Corrections | An issued tax invoice is not edited: correction by credit/debit note (Section 34); a "revised invoice" (Section 31(3)(a)) only covers the registration gap. → Invoice never re-issued; Cancel is only for an invoice not yet reported (the UI says so); credit notes are a later item | Sections 31, 34 CGST Act (high); Rule 53 particulars (secondary) |
| Quotation | No GST requirement for quotations; printed "Quotation — not a tax invoice" | No provision in the Act/Rule 46 (medium-high) |
| State codes | The e-invoice master list (01–38 except 28, 97 Other Territory); 96/99 (other countries) excluded in v1 | `einvoice1.gst.gov.in/Others/MasterCodes` (high) |

Not verified on an official page (marked so in the code comments): the consolidated SAC
descriptions, Rule 53's text, the IGST section 12(2) wording, the original of 10/2023-CT. A CA should
confirm the SAC choice per product and the round-off preference once.

## 7. API (`backend/modules/sales.js`, new; mounted in `backend/app.js` before `recordRoutes`)

| Route | Permission | Notes |
| ----- | ---------- | ----- |
| `GET /sales/settings` | `sales` | Whitelist view + `ready {quotation, invoice, missing[]}` |
| `PUT /sales/settings` | `billing` + step-up | `{rev, …}`; 409 `stale` |
| `PUT /sales/settings/images/:kind` (raw, ≤ 512 KB) | `billing` + step-up | `logo`/`signature`; PNG (8-bit) or JPEG, ≤ 2000 px |
| `DELETE /sales/settings/images/:kind` | `billing` + step-up | |
| `GET /customers/:id/sales` | `sales` | `{profile, deals[], documents[]}` (summaries) |
| `PUT /customers/:id/sales/profile` | `sales` | `{rev, billTo, overrides}` |
| `POST /customers/:id/sales/deals` | `sales` | New draft (bill-to copied from the profile) |
| `GET /sales/deals/:dealId` | `sales` | Deal + computed totals + its documents |
| `PUT /sales/deals/:dealId` | `sales` | Draft only (409 `deal-final`); `{rev, …}` |
| `POST /sales/deals/:dealId/status` | `sales` | `{rev, action: finalize\|reopen\|lost}`; reopen refused while an invoice is active |
| `POST /sales/deals/:dealId/preview` | `sales` | `{type}` → PDF (DRAFT); 60/h per person |
| `POST /sales/deals/:dealId/issue` | `sales` | `{rev, type}` → 201 `{document}`; agreement/invoice need `final`; 409 `settings-incomplete` with `items` |
| `GET /sales/documents/:docId` | `sales` | View (snapshot summary, status, e-mails) |
| `POST /sales/documents/:docId/download` | `sales` | PDF attachment; archive copy if stored (integrity-checked), else regenerated |
| `POST /sales/documents/:docId/email` | `sales` | `{to[1-3], message ≤ 1000}`; 20/h per person, 5/h per document; Reply-To = company e-mail |
| `POST /sales/documents/:docId/store` | `sales` | Retry the archive copy (idempotent) |
| `POST /sales/documents/:docId/cancel` | `billing` + step-up | Invoices and agreements; `{reason 5-300}` |

Every write: Origin + CSRF + JSON (existing middleware), zod `.strict()` schemas, `authorizeWrite`
and the audit row in the same transaction (`sales.*` actions; detail = type, number, version, recipient
count; never amounts, addresses, e-mail addresses or bank data). Errors never echo submitted values.

## 8. UI

- **Customer → Sales tab** (`frontend/src/pages/customer-sales.jsx`): billing details + client texts
  (each text: "Use default" or "Custom for this client"), deals list (New deal), documents list
  (Download, E-mail, Store copy, Cancel for owner).
- **Deal page** `/customers/:id/sales/:dealId`: title, valid until, place of supply, bill-to, line
  editor (table ≥ 768 px, stacked cards below), overall discount, live totals from `shared/sales.js`,
  actions: Save, Preview PDF, Issue quotation, Finalize / Reopen / Mark lost, Issue agreement, Issue
  invoice; the deal's documents.
- **Sales settings** `/sales-settings` (nav item for `sales`): company, bank/UPI, signatory, logo and
  signature, numbering (with the next number shown), GST defaults and round-off, templates with the
  placeholder list. Owner edits (step-up on save); admin sees it read-only.
- Restricted roles see an Empty state. Styles in `frontend/src/styles/sales.css`.

## 9. Files

New: `shared/sales.js`, `backend/lib/pdf.js`, `backend/lib/pdf-fonts.js`, `backend/lib/pdf-images.js`,
`backend/lib/sales-pdf.js`, `backend/modules/sales.js`, `frontend/src/pages/customer-sales.jsx`,
`frontend/src/pages/sales-deal.jsx`, `frontend/src/pages/sales-settings.jsx`,
`frontend/src/styles/sales.css`, `test/sales-math.test.js`, `test/sales-pdf.test.js`,
`test/sales-api.test.js`, `test/ui/sales.spec.js`, `test/fixtures/logo.png`.
Changed: `shared/policy.js` (grants), `shared/schemas.js` (`quotation` file category),
`frontend/src/pages/customer-files.jsx` (category mirror), `backend/db.js` (collections, indexes),
`backend/lib/snapshot.js` + `scripts/recovery.js` (optional collections), `backend/lib/file-store.js`
+ `backend/modules/files.js` (`openSealed` extracted), `backend/modules/mail.js`
(`documentMailer`), `backend/app.js` (mount, raw image route), `backend/server.js` (`sendDocument`),
`frontend/src/main.jsx`, `frontend/src/components/shell.jsx`,
`frontend/src/pages/customer-workspace.jsx`, `frontend/src/styles.css`, `test/ui-server.js`
(sales owner with authenticator, fake document mailer), docs (`API.md`, `SECURITY.md`,
`ROADMAP.md`, `POS-INTEGRATION.md`).

## 10. Tests (failing first)

- `sales-math`: rounding half-up, line/overall discounts (percent and amount), largest-remainder
  spread sums exactly, CGST/SGST vs IGST, mixed rates, round-off ±, amount in words (0, 1 paisa,
  lakh, crore), FY boundary 31 Mar / 1 Apr IST, number format and the 16-character limit, GSTIN
  format + checksum + state, WinAnsi text check, placeholder whitelist.
- `sales-pdf`: valid structure (xref offsets), deterministic bytes, multi-page table, PNG/JPEG embed,
  WinAnsi escaping; sample quotation (with discounts), agreement and invoice written to
  `test-results/sales-samples/`, text extracted and totals asserted (own extractor; `pdftotext`
  cross-check when installed).
- `sales-api`: role matrix (viewer/operations 403, admin `sales`, owner `billing` + 428 without
  step-up), stale `rev` 409, draft-only edits, finalize/reopen rules, gapless numbering per type and
  FY, re-issue = new version with v1 byte-identical, invoice never re-issued, cancel rules,
  settings-incomplete, per-client override isolation (A's override never changes B; a template
  change never changes an issued document), archive in S3 as a customer file + integrity-checked
  download + regenerate fallback, e-mail (attachment, rate limits, audit), audit rows, snapshot with
  and without the sales collections.
- `ui/sales.spec.js`: settings (step-up), deal with line + overall discount, totals on screen,
  issue quotation → finalize → agreement → invoice, download, e-mail dialog, viewer restricted;
  320/390/768/1440 px without horizontal overflow; axe (wcag2a/aa, 21aa) on the three screens.

## 11. Work units

W1 `shared/sales.js` + math tests · W2 PDF writer, fonts, images, layouts + PDF tests · W3 backend
module, db/snapshot/file-store/mail/app wiring + API tests · W4 UI + Playwright · W5 samples,
review, docs. W1 → W2/W3 (disjoint files) → W4 → W5.

## 12. Risks

- **Legal text**: the default agreement and terms are neutral samples marked as such; the owner
  replaces them (lawyer review, as for P7).
- **E-invoicing (IRN/QR)** is not implemented; required only above the turnover threshold (§6).
- **One invoice per deal** (no advance/milestone split), no credit/debit notes, no export/SEZ, no
  multi-currency in v1.
- **Byte-identical regeneration** depends on the Node zlib version; the S3 archive copy is the
  authoritative one, regeneration is the fallback.
- Bank details changed by a compromised owner session could redirect payments: billing writes need
  step-up and are audited; issued documents keep the old details.

## 13. Owner questions (recommended default in bold)

1. **PDF engine**: **no new dependency (own writer, `Rs.` instead of `₹`, Latin text only)** / `pdfkit` 0.17.2 exact pin with an embedded font.
2. **Who may do what**: **`sales` = owner + admin (deals, quotations, agreements, invoices, download, e-mail); `billing` = owner with step-up (company, bank, numbering, templates, cancel)** / also let Operations create deals and quotations.
3. **Numbering**: **`QT/26-27/0001`, `AG/26-27/0001`, `INV/26-27/0001`, restart every 1 April; a quotation/agreement revision keeps its number as v2; an invoice is never revised (cancel + next number)** / other format.
4. **Round-off**: **total rounded to the nearest rupee with a "Round off" line (setting, on)** / exact paise.
5. **Scope v1**: **one full invoice per deal; no advance/milestone invoices, credit notes, e-invoice IRN or export** / add milestone invoices now.

## 14. As built (2026-10-14, one session, branch `sales-docs` from main @ 4082048)

Built as planned (§2-§10, D52). Differences and details:

- **Files.** New: `shared/sales.js` (money, GST, numbering, GSTIN, WinAnsi text, templates, editor
  parsing), `shared/sales-schemas.js` (zod, server only; the front end imports `shared/sales.js`
  only), `backend/lib/pdf.js`, `backend/lib/pdf-fonts.js` (widths from the Base-14 metrics, pinned
  by a test), `backend/lib/pdf-images.js`, `backend/lib/sales-pdf.js` (`snapshotOf`,
  `renderDocument`), `backend/modules/sales.js`, `frontend/src/components/sales.jsx`,
  `frontend/src/pages/{customer-sales,sales-deal,sales-settings}.jsx`,
  `frontend/src/styles/sales.css`, `test/sales-{math,pdf,api}.test.js`, `test/sales-fixtures.js`,
  `test/ui/sales.spec.js`. Changed as listed in §9; `files.js`' download now calls
  `file-store.js` `openSealed` (same checks, same order, same audit); `app.js` also gives the three
  sales text PUTs (settings, client profile, deal) the 128 KB JSON limit.
- **Unit price** is capped at Rs. 1 crore per unit (not Rs. 10 crore as §4 said); quantity at
  1,00,000; a line description at 300 characters and 8 lines.
- **Deal lifecycle.** `draft` (editable; quotations may be issued) → `final` (locked; agreement and
  invoice) → `reopen` (refused while an invoice is issued) or `lost`. Every deal mutation, including
  an issue, bumps the deal's `rev`, so a double click or a second tab gets 409 `stale` and exactly
  one document is created (tested with three concurrent issues). A quotation whose valid-until date
  has passed is refused (`valid-until-past`).
- **Issue transaction.** Claim the deal by `rev` → checks (status, completeness, settings
  readiness, one active invoice, valid-until) → counter `$inc` (new number) or the previous
  version's number → frozen snapshot → PDF rendered and hashed (pure work, safe on a transaction
  retry) → insert → older versions `superseded` → audit. The S3 archive is written after the commit
  and linked in its own transaction (`sales.stored`); a failure leaves `stored: false` and the
  "Store copy" action. `stored` is true only while the linked customer file is not deleted; a copy
  deleted in Files can be stored again (the old link is replaced inside the same transaction,
  only if the snapshot still re-renders to the issue hash). Downloads serve the archive when it
  verifies and equals the issue hash, else re-render from the snapshot (`X-Document-Source`;
  integrity failures audit `sales.integrity-failed`, S3 outages `sales.archive-unavailable`). A
  cancelled agreement/invoice always downloads re-rendered with a CANCELLED watermark and cannot be
  e-mailed.
- **PDF content.** Each line prints its taxable value, the rate split and each tax amount
  (CGST/SGST, or IGST), plus a tax-by-rate summary; union territories without a legislature
  (04, 25, 26, 31, 35, 38, 97) print UTGST instead of SGST. Party, bank and header values wrap
  inside their columns. Quotations and invoices end with a fixed line "Pay only to the account
  above. Our bank details never change by e-mail or phone."
- **Texts.** A client text starts as a copy of the current default (copy-on-write) and is kept on
  `sales_profiles`; it is resolved and frozen at issue. A client's own **quotation and invoice
  terms** print next to the payment details, so setting or changing them needs `billing` + step-up
  (owner); the agreement text and the billing details stay `sales`. The default agreement text starts with
  "SAMPLE TEXT - replace it…" until the owner replaces it.
- **Numbering.** The three prefixes must differ and the invoice prefix cannot be empty (counters
  are per type). Sales settings show the real next number of each type. Snapshot collections are
  read with `sales_counters` last, so a restore never has a counter behind a stored document.
- **Images.** Replacing or removing the logo/signature deletes the old bytes unless an issued
  document prints them; parsed images are cached by hash (8 entries).
- **Audit.** Deal events record `deal <8-char id>` (titles are free text and `/audit` is open to
  every role); document events record type and number; never amounts, addresses or bank data.

**Reviews.** Two independent read-only opus reviews on a fingerprinted tree (unchanged before and
after): backend (0 critical/high; medium: party blocks not wrapped, no per-line tax amounts, equal
prefixes possible) and UI/tests (high: an image upload discarded unsaved settings edits; medium:
silent stale reloads and a Save→Issue race, Radix selects openable on a locked deal, `stored` after
deletion, hidden totals errors, missing tests). Every critical/high/medium and most low findings
were fixed with tests; a third read-only review (fingerprinted) confirmed the fixes and found three
layout gaps (a long place-of-supply value printed over its label, the payment block not measured
before placing it, an unwrapped signatory title) and the remaining payment-text risk (client
quotation terms editable by admin); all four were fixed afterwards (owner-only quotation terms,
measured closing blocks, a cancelled document is never archived again, an issue claims the image
rows it prints so a concurrent image replacement cannot delete them). Accepted (low, recorded): a cancelled document's archive copy stays the issued bytes (downloads
are stamped); deal notes and line descriptions are `sales` free text on documents (the fixed
"Pay only to the account above" line stays); reusing an old prefix of another type within the same
financial year could repeat a printed number (the counters are per type); edits typed in Sales
settings while an image upload is in flight are lost on the reload; only the per-document e-mail
limit has a test (download, preview, image and per-person limits use the same `consume`); focus is
not moved to the status message; a UI spec run crossing midnight IST on 1 April could fail its
number assertions. **Capacity:** every issued document (snapshot + PDF hash, 5-40 KB) is in the
in-app encrypted snapshot, capped at 50 MB (`backend/lib/snapshot.js`); at roughly a thousand
agreements switch the admin database to managed snapshots (Atlas/backups) as SECURITY.md already
advises for larger installations.

**Samples** (generated by `test/sales-pdf.test.js` into `test-results/sales-samples/`, text
extracted by the test's own reader and by `pdftotext`, totals asserted): `quotation.pdf` (10 %
line discount, Rs. 9.99 amount discount, 5 % overall discount, CGST/SGST 9 % + 9 % per line and by
rate, round off +0.20, total Rs. 11,199.00), `agreement.pdf` (client-specific text, schedule, two
signature blocks), `invoice.pdf` (Rule 46 particulars, intra-state), `invoice-igst.pdf`
(unregistered client in Karnataka: IGST 1,539.00 + 169.29 = 1,708.29, round off +0.21, total
Rs. 11,199.00). Each is one A4 page.

**Evidence** (Windows dev PC, 2026-10-14, branch `sales-docs`): `node --test test/sales-math.test.js
test/sales-pdf.test.js test/sales-api.test.js` → tests 62, pass 62, fail 0; `npm test` → tests 789,
suites 157, pass 783, fail 0, cancelled 0, skipped 6 (the Linux-only ones), todo 0 (727 before + 62
new; an earlier full run had the 22 sales API tests cancelled when an in-memory mongod crashed at
start, `fassert`, and passed on the rerun); `npm run build` → ✓ built (the existing > 500 kB chunk
warning only); `npx playwright test --reporter=line` → 52 passed (7.9m) (48 existing + 4 new). Two
earlier full Playwright runs each had one different existing timing-sensitive test fail under load
(`usage.spec.js` "fleet reads in 25 s while stalled", `security.spec.js` "concurrent step-up
prompts"); both pass alone and in the third full run, and their code and specs are unchanged on this
branch. Changed and new files were formatted with prettier (only those files). No new dependency.

**Release (house method step 4, needs the owner):** `bash scripts/test-linux.sh` on the server
(0 fail), merge `sales-docs` into main, push, rebuild and restart the app container (no new
container, volume, `.env` variable or dependency; the six collections and their indexes are created
at start). Then, as the owner: Sales settings → company, GSTIN, bank/UPI, signatory, logo and
signature, review the three default texts (the agreement text is a SAMPLE until replaced; have it
reviewed like the P7 terms), and confirm the SAC and GST rate with your CA. After the merge, merge
main into `p5-stage3` before its W7 (expected conflicts: `docs/POS-INTEGRATION.md` D51/D52 rows,
`docs/ROADMAP.md`, `docs/API.md`, `docs/SECURITY.md`, `backend/app.js`, `backend/db.js`,
`test/ui-server.js`).

**Released 2026-10-15** (main @ 99809c8): Linux suite on the server 789 tests, 787 pass, 0 fail,
2 skipped; app and worker healthy, `/ready` ok; the owner checked the panel.

## 15. Revision 2 (2026-10-15, D53): seller without GST registration, design, texts

The owner's company is not registered under GST and wants to give clients only its name, email and
phone; the PDFs must look like a large SaaS product's; and the documents need standard terms and a
proper agreement. Branch `sales-docs-2` from main @ 99809c8.

- **GST switch** (`settings.gst.registered`, default off; rows saved before read as off). Off: an
  unregistered person may not collect tax (CGST Act s.32), so `computeTotals(…, {registered:
  false})` charges no tax on any line and returns no rate rows; no seller GSTIN (also blanked in
  `{{company.gstin}}`), SAC, rates or place of supply on any screen or PDF; the invoice is titled
  "Invoice" everywhere (PDF, view, e-mail, file name); `{{tax.note}}` = "GST is not charged: the
  supplier is not registered under GST." On: D52's Rule 46 behaviour. Place of supply and the
  client's state are required only when registered; the seller GSTIN-state check runs only then.
- **Readiness per type** (`missing: {quotation, agreement, invoice}`): legal name, email, phone;
  the agreement also `company.jurisdiction` (city of its courts and arbitration seat); registered
  adds address and state, and the GSTIN for invoices.
- **Mode switches mid-deal**: an agreement or invoice is refused (409 `gst-mode-changed`, with the
  next step) while the deal's latest issued quotation/agreement of another type was issued in the
  other mode; quotations are never blocked; the deal page shows the same advice (`modeChanged`,
  empty once an invoice is active).
- **Texts**: new `DEFAULT_TEMPLATES` (quotation terms, a 16-section Service Agreement, invoice
  terms) with no address/GSTIN/PAN; new placeholders `{{tax.note}}`, `{{company.jurisdiction}}`.
  `LEGACY_DEFAULT_TEMPLATES` = D52's defaults: a stored text (or client copy) exactly equal to one
  is read as the new default; edited texts are kept. Settings: "Restore default text" per text and
  a warning when an unregistered seller's text mentions GST (also on client copies).
- **Design** (snapshot format 2): accent colour `settings.design.accent` (default `#355E45`), top
  bar, header with logo or wordmark and a facts grid, From/Bill to (Provider/Client) cards with
  only filled fields, items table with tinted header and repeated header on new pages, totals card,
  payment card only when filled, texts with headings (`N. TITLE IN CAPITALS`, `# Title` ≤ 80
  characters) and hanging-indent clauses, agreement with Schedule A and two signature blocks,
  footer with contact and "Page X of Y". `pdf.js` gained Helvetica-Oblique, letter spacing (Tc)
  and rounded rectangles; output without them is byte-identical to D52's.
- **Format-1 documents** (issued under D52) render with the frozen D52 renderer
  (`backend/lib/sales-pdf-v1.js`): byte-identical re-renders keep "Store copy" and the hash checks
  working (a differential run of 2,400 random format-1 snapshots: 0 differences).
- **Reviews**: one read-only opus review (1 high: stored D52 default texts kept printing GST; 3
  medium: a ReDoS in the clause parser, GST mode switches changing a deal's money, a hidden GSTIN
  blocking saves; 7 low) — all fixed except L5 (the API's draft totals still show IGST for a
  registered deal without a place of supply; issuing is blocked) and L7 (kept: registered readiness
  also needs email/phone/jurisdiction); re-review: all fixed, 3 new lows fixed.
- `tools/sales-samples.mjs` (dev only) writes sample PDFs/PNGs to `test-results/sales-samples-v2/`.

**Evidence** (Windows dev PC, 2026-10-15, branch `sales-docs-2`): `node --test
test/sales-math.test.js test/sales-pdf.test.js test/sales-api.test.js` → 77 before the review
fixes, all pass; `npm test` → tests 814, suites 159, pass 808, fail 0, cancelled 0, skipped 6 (the
Linux-only ones), todo 0; `npm run build` → `✓ built in 2.90s` (the existing > 500 kB chunk warning
only); `npx playwright test --reporter=line` → `52 passed (7.2m)`. Samples checked by eye
(quotation, agreement, invoice without GST; tax invoice; 34-line quotation; GST draft).

**Release** (house method step 4, `docs/DEPLOYMENT.md` "Sales documents release checklist"):
`bash scripts/test-linux.sh` on the server, merge `sales-docs-2` into main, push, rebuild, reload
open panel tabs, then the owner fills the jurisdiction city and checks one quotation. Owner: have a
lawyer review the agreement text and the stamp duty; switch GST on once registered.
