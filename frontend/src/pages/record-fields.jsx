import { useState } from "react";
import { Field, Select, Picker, SearchInput } from "../components/ui";
import { MODELS, TRANSITIONS } from "../../../shared/policy";
import { useResource } from "../hooks/use-resource";
import {
  modelFor,
  checksFor,
  providersFor,
  PROVIDERS,
  PRODUCT_MODELS,
} from "../../../shared/product-models";
export function RecordFields({ kind, value, set, existing, product }) {
  const model = modelFor(product);
  const input = (name, title, props = {}) => (
    <Field label={title} key={name}>
      <input
        value={value[name] || ""}
        onChange={(event) => set(name, event.target.value)}
        {...props}
      />
    </Field>
  );
  const select = (name, title, options, props = {}) => (
    <Field label={title}>
      <Select
        value={value[name]}
        onChange={(event) => set(name, event.target.value)}
        options={options}
        {...props}
      />
    </Field>
  );
  const notes = (
    <Field
      label="Internal notes"
      hint="Keep passwords and tokens in the encrypted credential field, not in notes."
    >
      <textarea
        rows={4}
        maxLength={2000}
        value={value.notes || ""}
        onChange={(event) => set("notes", event.target.value)}
      />
    </Field>
  );
  if (kind === "customers")
    return (
      <>
        <div className="form-section">
          <h2>Customer details</h2>
          <div className="form-grid">
            {input("name", "Contact name", {
              required: true,
              minLength: 2,
              maxLength: 120,
            })}
            {input("company", "Company", { maxLength: 160 })}
            {input("email", "Email address", {
              required: true,
              type: "email",
              maxLength: 254,
            })}
            {input("phone", "Phone number", { type: "tel", maxLength: 32 })}
          </div>
        </div>
        <div className="form-section">
          <h2>Relationship</h2>
          <div className="form-grid">
            {select("status", "Status", [
              "lead",
              "active",
              "paused",
              "archived",
            ])}
            {input("storeWorkspaceId", "Store workspace ID", {
              maxLength: 100,
              placeholder: "Optional — paste the exact workspace ID",
            })}
          </div>
          {notes}
        </div>
      </>
    );
  if (kind === "products")
    return (
      <>
        <div className="form-section">
          <h2>Product identity</h2>
          <div className="form-grid">
            {input("name", "Product name", { required: true, maxLength: 120 })}
            {input("slug", "Product identifier", {
              required: true,
              pattern: "[a-z][a-z0-9-]{1,48}",
              disabled: Boolean(existing),
              placeholder: "e.g. inventory",
            })}
            {input("category", "Category", { required: true, maxLength: 80 })}
            {select("status", "Availability", ["active", "planned", "retired"])}
          </div>
          <Field label="Description">
            <textarea
              required
              rows={3}
              maxLength={500}
              value={value.description}
              onChange={(event) => set("description", event.target.value)}
            />
          </Field>
        </div>
        <div className="form-section">
          <h2>Delivery & commercial model</h2>
          <div className="form-grid">
            {select(
              "model",
              "Delivery model",
              MODELS.map((value) => ({
                value,
                label: PRODUCT_MODELS[value].label,
              })),
            )}
            {select("pricing", "Pricing model", [
              "free",
              "prepaid",
              "one-time",
              "subscription",
              "custom",
            ])}
          </div>
          <h3>Required infrastructure providers</h3>
          <p className="form-note">
            Choose only what this product needs before an installation is ready.
            Leave empty if no customer provider accounts are needed.
          </p>
          <div className="provider-options">
            {PROVIDERS.map((provider) => (
              <label className="check-row" key={provider}>
                <input
                  type="checkbox"
                  checked={value.requiredProviders.includes(provider)}
                  onChange={(event) =>
                    set(
                      "requiredProviders",
                      event.target.checked
                        ? [...value.requiredProviders, provider]
                        : value.requiredProviders.filter(
                            (item) => item !== provider,
                          ),
                    )
                  }
                />
                {provider}
              </label>
            ))}
          </div>
          {input("website", "Product website", {
            type: "url",
            placeholder: "https://",
            maxLength: 500,
          })}
          <p className="form-note">
            Pricing models describe the offering. Payment processing and wallet
            balances are integrated separately.
          </p>
        </div>
      </>
    );
  if (kind === "connections")
    return (
      <>
        <div className="form-section">
          <h2>Provider ownership</h2>
          <div className="form-grid">
            {input("name", "Connection name", {
              required: true,
              maxLength: 120,
            })}
            <Picker
              kind="customers"
              label="Customer"
              value={value.customerId}
              onChange={(id) => set("customerId", id)}
              disabled={existing}
            />
            {select("provider", "Provider", [
              "vercel",
              "mongodb",
              "cloudflare",
              "aws",
              "other",
            ])}
            {select("ownership", "Account owned by", ["customer", "sandbee"])}
          </div>
        </div>
        <div className="form-section">
          <h2>Account references</h2>
          <div className="form-grid">
            {input("accountId", "Account / team ID", { maxLength: 160 })}
            {input("resourceId", "Project / zone / cluster ID", {
              maxLength: 160,
            })}
            {input("expiresAt", "Credential expiry", { type: "date" })}
            {select("status", "Recorded status", [
              "recorded",
              "attention",
              "revoked",
            ])}
          </div>
          {notes}
          <p className="form-note">
            Use identifiers here. Save the credential separately after creating
            this connection. Provider connectivity has not been tested by
            Sandbee.
          </p>
        </div>
      </>
    );
  if (kind === "tasks")
    return (
      <>
        <div className="form-section">
          <h2>Work details</h2>
          {input("title", "Task title", { required: true, maxLength: 120 })}
          <div className="form-grid">
            {select("status", "Progress", ["open", "in-progress", "done"])}
            {select("priority", "Priority", ["normal", "high", "urgent"])}
            {input("dueAt", "Due date", { type: "date" })}
            <Picker
              kind="staff"
              label="Assignee"
              optional
              value={value.assigneeId}
              onChange={(id) => set("assigneeId", id)}
            />
          </div>
        </div>
        <div className="form-section">
          <h2>Context</h2>
          <div className="form-grid">
            <Picker
              kind="customers"
              label="Customer"
              optional
              value={value.customerId}
              onChange={(id) => {
                set("customerId", id);
                set("installationId", "");
              }}
            />
            <Picker
              kind="installations"
              label="Installation"
              optional
              customerId={value.customerId}
              value={value.installationId}
              onChange={(id) => set("installationId", id)}
            />
          </div>
          {notes}
        </div>
      </>
    );
  return (
    <>
      <div className="form-section">
        <h2>Installation identity</h2>
        {input("name", "Installation name", {
          required: true,
          maxLength: 120,
          placeholder: "e.g. Acme Cafe · Production",
        })}
        <div className="form-grid">
          <Picker
            kind="customers"
            label="Customer"
            value={value.customerId}
            onChange={(id) => {
              set("customerId", id);
              set("connectionIds", []);
            }}
            disabled={existing}
          />
          <Picker
            kind="products"
            label="Product"
            value={value.productId}
            onChange={(id) => {
              set("productId", id);
              set("checks", []);
              set("connectionIds", []);
            }}
            disabled={existing}
          />
          {select(
            "environment",
            "Environment",
            ["production", "staging", "development"],
            { disabled: existing },
          )}
          {select(
            "status",
            "Lifecycle",
            existing
              ? [existing.status, ...TRANSITIONS[existing.status]]
              : ["planned"],
          )}
        </div>
      </div>
      <div className="form-section">
        <h2>{product ? model.label : "Product configuration"}</h2>
        <p className="form-note">
          {product
            ? model.description
            : "Choose a product to load its configuration and readiness checks."}
        </p>
        <div className="form-grid">
          {input("release", model.releaseLabel, {
            maxLength: 160,
            placeholder: "Version or exact source commit",
          })}
          {input("sourceUrl", model.sourceLabel, {
            type: "url",
            placeholder: "https://",
            maxLength: 500,
          })}
        </div>
        {input(
          "endpoint",
          model.endpointRequired
            ? "Application endpoint"
            : "Application endpoint (optional)",
          {
            type: "url",
            placeholder: "https://customer.example.com",
            maxLength: 500,
          },
        )}
        <ConnectionChecks
          customerId={value.customerId}
          selected={value.connectionIds}
          onChange={(ids) => set("connectionIds", ids)}
        />
      </div>
      <div className="form-section">
        <h2>Readiness checklist</h2>
        <p className="form-note">
          Confirm only what you have actually verified for this product.
          {product &&
            providersFor(product).length > 0 &&
            ` Required providers: ${providersFor(product).join(", ")}.`}
        </p>
        <div className="checklist">
          {(product ? checksFor(product) : []).map((check) => (
            <label key={check.id}>
              <input
                type="checkbox"
                checked={value.checks.includes(check.id)}
                onChange={(event) =>
                  set(
                    "checks",
                    event.target.checked
                      ? [...value.checks, check.id]
                      : value.checks.filter((id) => id !== check.id),
                  )
                }
              />
              <span>{check.label}</span>
            </label>
          ))}
        </div>
        <Field
          label="Verification & handover evidence"
          hint="Record test results, handover date and provider deployment IDs. This panel does not deploy or probe the application."
        >
          <textarea
            rows={3}
            maxLength={2000}
            value={value.evidence}
            onChange={(event) => set("evidence", event.target.value)}
          />
        </Field>
        {notes}
      </div>
    </>
  );
}
function ConnectionChecks({ customerId, selected, onChange }) {
  const [search, setSearch] = useState("");
  const resource = useResource(
    customerId
      ? `/options/connections?customerId=${customerId}&search=${encodeURIComponent(search)}`
      : null,
  );
  if (!customerId)
    return (
      <p className="form-note">
        Choose a customer to link provider connections.
      </p>
    );
  return (
    <div className="connection-checks">
      <h3>Linked provider accounts</h3>
      <SearchInput
        value={search}
        onChange={setSearch}
        placeholder="Find customer connections…"
      />
      {resource.error && <p role="alert">{resource.error}</p>}
      <div className="checklist">
        {resource.data?.rows.map((row) => (
          <label key={row._id}>
            <input
              type="checkbox"
              checked={selected.includes(row._id)}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...selected, row._id]
                    : selected.filter((id) => id !== row._id),
                )
              }
            />
            <span>
              {row.name}
              <small>
                {row.provider} · {row.status}
              </small>
            </span>
          </label>
        ))}
      </div>
      {!resource.loading && !resource.data?.rows.length && (
        <p className="form-note">
          No matching connections. Add provider records in Connections first.
        </p>
      )}
    </div>
  );
}
