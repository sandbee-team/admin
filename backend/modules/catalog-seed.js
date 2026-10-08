import { randomUUID } from "node:crypto";
const items = [
  [
    "ecom",
    "Sandbee Ecom",
    "Seller operations",
    "saas",
    "subscription",
    "Multi-account seller reporting, source imports and settlement reconciliation. Subscription access is managed by Sandbee Admin.",
    "https://ecom.sandbee.in",
  ],
  [
    "gst",
    "GSTIN",
    "Business data",
    "hosted-api",
    "free",
    "Registered business details through the Sandbee hosted API.",
    "https://gstapi.sandbee.in",
  ],
  [
    "ocr",
    "Document OCR",
    "Developer tools",
    "customer-package",
    "free",
    "Customer-hosted Node.js document extraction with Sandbee licensing.",
    "https://ocr.sandbee.in",
  ],
  [
    "messaging",
    "Sandbee Messaging",
    "Communication",
    "prepaid-service",
    "prepaid",
    "WhatsApp QR-session messaging through a panel and API.",
    "https://store.sandbee.in",
  ],
  [
    "pos",
    "Sandbee POS",
    "Business software",
    "customer-deployment",
    "one-time",
    "One-time setup in the customer’s Vercel, MongoDB and Cloudflare accounts.",
    "https://sandbee.in/products/pos",
  ],
];
export async function seedCatalog(db) {
  for (const [
    slug,
    name,
    category,
    model,
    pricing,
    description,
    website,
  ] of items) {
    await db.collection("products").updateOne(
      { slug },
      {
        $setOnInsert: {
          _id: randomUUID(),
          slug,
          name,
          category,
          model,
          requiredProviders:
            slug === "pos" ? ["vercel", "mongodb", "cloudflare"] : [],
          pricing,
          description,
          website,
          status: slug === "ecom" ? "planned" : "active",
          revision: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
      { upsert: true },
    );
  }
}
