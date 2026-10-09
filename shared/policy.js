export const ROLES = ["owner", "admin", "operations", "viewer"];
const grants = {
  owner: [
    "read",
    "operate",
    "catalog",
    "credentials",
    "team",
    "recovery",
    "secrets",
  ],
  admin: ["read", "operate", "catalog", "credentials"],
  operations: ["read", "operate"],
  viewer: ["read"],
};
export const can = (role, permission) =>
  grants[role]?.includes(permission) ?? false;
export const CHECKS = [
  { id: "ownership", label: "Customer account ownership confirmed" },
  { id: "source", label: "Source and release available off this computer" },
  {
    id: "configuration",
    label: "Environment and provider configuration recorded",
  },
  { id: "backup", label: "Database backup and recovery access confirmed" },
  { id: "verification", label: "Application and custom domain tested" },
  { id: "handover", label: "Customer handover completed" },
];
export const MODELS = [
  "hosted-api",
  "customer-package",
  "prepaid-service",
  "customer-deployment",
  "saas",
];
export const INSTALL_STATES = ["planned", "ready", "live", "paused", "retired"];
export const TRANSITIONS = {
  planned: ["ready", "retired"],
  ready: ["planned", "live", "retired"],
  live: ["paused", "retired"],
  paused: ["live", "retired"],
  retired: [],
};
