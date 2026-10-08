import {
  useEffect,
  useRef,
  useState,
  useId,
  Children,
  cloneElement,
  isValidElement,
} from "react";
import {
  ArrowRight,
  AlertCircle,
  Plus,
  X,
  Search,
  ChevronLeft,
  ChevronRight,
  Check,
  LoaderCircle,
} from "lucide-react";
import { Link } from "../lib/router";
import { useResource } from "../hooks/use-resource";
import { label } from "../lib/api";
import { Select } from "./select";
export { Select };
export function Brand({ compact = false }) {
  return (
    <span className="brand">
      <img src="/mark.svg" alt="" width="34" height="34" />
      {!compact && (
        <span>
          sandbee<span className="brand-suffix">ADMIN</span>
        </span>
      )}
    </span>
  );
}
export function Badge({ value, children }) {
  return (
    <span className={`badge badge-${value}`}>{children || label(value)}</span>
  );
}
export function PageTitle({ eyebrow, title, description, action }) {
  return (
    <header className="page-title">
      <div>
        <p className="eyebrow">{eyebrow || "WORKSPACE"}</p>
        <h1>{title}</h1>
        {description && <p className="subtle">{description}</p>}
      </div>
      {action}
    </header>
  );
}
export function Button({
  children,
  busy,
  variant = "primary",
  className = "",
  ...props
}) {
  return (
    <button
      className={`button ${variant} ${className}`}
      {...props}
      disabled={props.disabled || busy}
    >
      {busy && <LoaderCircle size={15} className="spin" />}
      {children}
    </button>
  );
}
export function NewLink({ href, children }) {
  return (
    <Link href={href} className="button primary">
      <Plus size={16} />
      {children}
    </Link>
  );
}
export function ErrorBox({ children, retry }) {
  return (
    <div className="error-box" role="alert">
      <AlertCircle size={18} />
      <span>{children}</span>
      {retry && <button onClick={retry}>Try again</button>}
    </div>
  );
}
export function Loading() {
  return (
    <div className="loading" role="status">
      <img src="/mark.svg" alt="" />
      <span>Loading your workspace…</span>
    </div>
  );
}
export function Resource({ resource, children }) {
  if (resource.loading) return <Loading />;
  if (resource.error)
    return <ErrorBox retry={resource.reload}>{resource.error}</ErrorBox>;
  return children(resource.data);
}
export function Empty({ icon: Icon, title, children, action }) {
  return (
    <div className="empty">
      {Icon && (
        <span className="empty-icon">
          <Icon size={25} />
        </span>
      )}
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}
export function Field({ label: title, hint, children, ...props }) {
  const id = useId();
  return (
    <div className="field" {...props}>
      <label htmlFor={id}>{title}</label>
      {Children.map(children, (child) =>
        isValidElement(child) &&
        (["input", "select", "textarea"].includes(child.type) ||
          child.type === Select)
          ? cloneElement(child, {
              id,
              ...(hint ? { "aria-describedby": `${id}-hint` } : {}),
            })
          : child,
      )}
      {hint && <small id={`${id}-hint`}>{hint}</small>}
    </div>
  );
}
export function Picker({
  kind,
  value,
  onChange,
  customerId,
  optional = false,
  disabled,
  label: title,
  initialLabel,
}) {
  const id = useId();
  const [search, setSearch] = useState("");
  const resource = useResource(
    `/options/${kind}?search=${encodeURIComponent(search)}${customerId ? `&customerId=${customerId}` : ""}`,
  );
  const rows = resource.data?.rows || [],
    options = [
      {
        value: "",
        label: optional ? "Not assigned" : `Select ${title.toLowerCase()}`,
      },
      ...rows.map((row) => ({ value: row._id, label: row.name })),
    ];
  if (value && !rows.some((row) => row._id === value))
    options.push({
      value,
      label: initialLabel || `Selected record · ${value.slice(0, 8)}`,
    });
  return (
    <div className="field">
      <label htmlFor={id}>{title}</label>
      <div className="picker">
        <input
          aria-label={`Search ${title.toLowerCase()}`}
          placeholder="Type to find a record…"
          value={search}
          disabled={disabled}
          onChange={(event) => setSearch(event.target.value)}
        />
        <Select
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled || resource.loading}
          required={!optional}
          options={options}
        />
      </div>
      {resource.error && <small role="alert">{resource.error}</small>}
      {resource.data?.limited && (
        <small>Showing 100 records. Refine your search.</small>
      )}
    </div>
  );
}
export function Pagination({ data, page, onPage }) {
  return (
    <div className="pagination">
      <span>
        {data.total
          ? `${(page - 1) * data.pageSize + 1}–${Math.min(page * data.pageSize, data.total)} of ${data.total}`
          : "0 records"}
      </span>
      <div>
        <button
          aria-label="Previous page"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          <ChevronLeft size={17} />
        </button>
        <span>Page {page}</span>
        <button
          aria-label="Next page"
          disabled={page * data.pageSize >= data.total}
          onClick={() => onPage(page + 1)}
        >
          <ChevronRight size={17} />
        </button>
      </div>
    </div>
  );
}
export function SearchInput({
  value,
  onChange,
  placeholder = "Search records…",
}) {
  return (
    <div className="search">
      <Search size={16} />
      <input
        type="search"
        aria-label={placeholder}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
export function Modal({ title, onClose, children }) {
  const ref = useRef();
  useEffect(() => {
    ref.current.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="modal-head">
        <h2>{title}</h2>
        <button
          className="icon-button"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <X size={19} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function Notice({ children }) {
  return (
    <div className="notice">
      <Check size={16} />
      <span>{children}</span>
    </div>
  );
}
export function TextLink({ href, children }) {
  return (
    <Link href={href} className="text-link">
      {children}
      <ArrowRight size={15} />
    </Link>
  );
}
