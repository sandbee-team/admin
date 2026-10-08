export const PROVIDERS = ["vercel", "mongodb", "cloudflare", "aws", "other"];
const serviceChecks = [
  "ownership",
  "configuration",
  "verification",
  "handover",
];
export const PRODUCT_MODELS = {
  "hosted-api": {
    label: "Hosted API",
    description:
      "Sandbee hosts the endpoint; customers integrate using their authorized API access.",
    checks: serviceChecks,
    endpointRequired: true,
    releaseRequired: false,
    sourceRequired: false,
    sourceLabel: "API documentation URL",
    releaseLabel: "API version (optional)",
  },
  "customer-package": {
    label: "Installed package",
    description:
      "Processing runs on the customer’s server. Track the package version, installation and access handover.",
    checks: [
      "ownership",
      "source",
      "configuration",
      "verification",
      "handover",
    ],
    endpointRequired: false,
    releaseRequired: true,
    sourceRequired: true,
    sourceLabel: "Package or distribution URL",
    releaseLabel: "Installed package version",
  },
  "prepaid-service": {
    label: "Prepaid service",
    description:
      "A hosted service with prepaid access. Operational readiness is separate from payment and wallet settlement.",
    checks: serviceChecks,
    endpointRequired: true,
    releaseRequired: false,
    sourceRequired: false,
    sourceLabel: "Service documentation URL",
    releaseLabel: "Service version (optional)",
  },
  "customer-deployment": {
    label: "Customer deployment",
    description:
      "The customer owns the infrastructure. Verify the product’s required providers, release, backups and handover.",
    checks: [
      "ownership",
      "source",
      "configuration",
      "backup",
      "verification",
      "handover",
    ],
    endpointRequired: true,
    releaseRequired: true,
    sourceRequired: true,
    sourceLabel: "Source or archive location",
    releaseLabel: "Release / commit reference",
  },
  saas: {
    label: "SaaS application",
    description:
      "A Sandbee-hosted workspace or application. Track customer provisioning and service access.",
    checks: serviceChecks,
    endpointRequired: true,
    releaseRequired: false,
    sourceRequired: false,
    sourceLabel: "Application documentation URL",
    releaseLabel: "Application version (optional)",
  },
};
export function modelFor(product) {
  return PRODUCT_MODELS[product?.model] || PRODUCT_MODELS.saas;
}
export function providersFor(product) {
  // Backward compatibility for the original seeded POS record only. Other
  // customer-deployed products never inherit POS-specific infrastructure.
  return (
    product?.requiredProviders ??
    (product?.slug === "pos" && product?.model === "customer-deployment"
      ? ["vercel", "mongodb", "cloudflare"]
      : [])
  );
}
export function checksFor(product) {
  const model = modelFor(product);
  const labels = {
    ownership:
      product?.model === "customer-deployment"
        ? "Customer account ownership confirmed"
        : "Customer and product access confirmed",
    source:
      product?.model === "customer-package"
        ? "Package version and distribution source recorded"
        : "Source and release available off this computer",
    configuration: "Configuration and required provider accounts recorded",
    backup: "Database backup and recovery access confirmed",
    verification:
      product?.model === "customer-package"
        ? "Package startup and extraction tested on the customer server"
        : "Service access and application endpoint tested",
    handover: "Customer handover completed",
  };
  return model.checks.map((id) => ({ id, label: labels[id] }));
}
