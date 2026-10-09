import { useEffect } from "react";
import { ArrowUpRight, Database, FileUp } from "lucide-react";
import { definitions } from "./records-config";
import { useResource } from "../hooks/use-resource";
import {
  PageTitle,
  Resource,
  Badge,
  Empty,
  NewLink,
  Pagination,
  SearchInput,
  Select,
  Loading,
} from "../components/ui";
import { Link, setQuery, useSearch } from "../lib/router";
import { dateTime, label } from "../lib/api";
import { ProductCatalog } from "../components/product-catalog";
import { PRODUCT_MODELS } from "../../../shared/product-models";
import { can } from "../../../shared/policy";
// A page number beyond the last one (a stale link, a shrunk list) moves to the
// last page instead of claiming the list is empty.
function LastPage({ to }) {
  useEffect(() => to(), []);
  return <Loading />;
}
export function RecordList({ kind, user }) {
  const def = definitions[kind],
    // The URL is the source of truth, so filters survive reloads and a link to
    // the same list with another search re-reads it.
    query = new URLSearchParams(useSearch()),
    page = Math.min(10000, Math.max(1, parseInt(query.get("page"), 10) || 1)),
    search = (query.get("search") || "").slice(0, 100),
    status = query.get("status") || "",
    model = query.get("model") || "",
    filters = { search, status, model };
  const change = (next, replace = false) =>
      setQuery({ ...filters, page, ...next }, { replace }),
    setPage = (value) => change({ page: value }),
    pick = (name) => (event) => change({ [name]: event.target.value, page: 1 });
  const resource = useResource(
      `/${kind}?page=${page}&search=${encodeURIComponent(search)}&status=${encodeURIComponent(status)}&model=${encodeURIComponent(model)}`,
    ),
    writable = can(user.role, def.permission);
  return (
    <>
      <PageTitle
        eyebrow={def.eyebrow}
        title={def.title}
        description={def.description}
        action={
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {kind === "customers" && can(user.role, "secrets") && (
              <Link className="button secondary" href="/pos-import">
                <FileUp size={16} />
                Import from go-live file
              </Link>
            )}
            {writable && (
              <NewLink href={`/${kind}/new`}>Add {def.singular}</NewLink>
            )}
          </div>
        }
      />
      <div className="list-toolbar">
        <SearchInput
          value={search}
          onChange={(value) => change({ search: value, page: 1 }, true)}
          placeholder={`Search ${def.title.toLowerCase()}…`}
        />
        {kind === "products" && (
          <Select
            aria-label="Filter by delivery model"
            value={model}
            onChange={pick("model")}
            options={[
              { value: "", label: "All delivery models" },
              ...Object.entries(PRODUCT_MODELS).map(([value, model]) => ({
                value,
                label: model.label,
              })),
            ]}
          />
        )}
        <Select
          aria-label="Filter by status"
          value={status}
          onChange={pick("status")}
          options={[{ value: "", label: "All statuses" }, ...def.statuses]}
        />
      </div>
      <Resource resource={resource}>
        {(data) =>
          !data.rows.length && page > 1 && data.total > 0 ? (
            <LastPage
              to={() =>
                change({ page: Math.ceil(data.total / data.pageSize) }, true)
              }
            />
          ) : !data.rows.length ? (
            <div className="panel">
              <Empty
                icon={Database}
                title={
                  search || status || model
                    ? "No matching records"
                    : `Your ${def.title.toLowerCase()} start here`
                }
              >
                {search || status || model
                  ? "Try another search or status filter."
                  : `Add your first ${def.singular} to start managing it from your operations workspace.`}
              </Empty>
            </div>
          ) : (
            <>
              {kind === "products" ? (
                <ProductCatalog rows={data.rows} />
              ) : (
                <div className="table-wrap panel">
                  <table>
                    <thead>
                      <tr>
                        {def.columns.map(([key, title]) => (
                          <th key={key}>{title}</th>
                        ))}
                        <th>
                          <span className="sr-only">Open record</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.rows.map((row) => (
                        <tr key={row._id}>
                          {def.columns.map(([key], index) => (
                            <td key={key}>
                              {index === 0 ? (
                                <Link
                                  className="table-name"
                                  href={`/${kind}/${row._id}`}
                                >
                                  {row[key]}
                                </Link>
                              ) : ["status", "priority", "pricing"].includes(
                                  key,
                                ) ? (
                                <Badge value={row[key]} />
                              ) : key === "updatedAt" ? (
                                <span className="small subtle">
                                  {dateTime(row[key])}
                                </span>
                              ) : key === "hasCredential" ? (
                                <span
                                  className={
                                    row[key] ? "text-accent" : "subtle"
                                  }
                                >
                                  {row[key] ? "Encrypted" : "Not stored"}
                                </span>
                              ) : (
                                label(row[key])
                              )}
                            </td>
                          ))}
                          <td>
                            <Link
                              className="icon-button"
                              aria-label={`Open ${row.name || row.title}`}
                              href={`/${kind}/${row._id}`}
                            >
                              <ArrowUpRight size={16} />
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <Pagination data={data} page={page} onPage={setPage} />
            </>
          )
        }
      </Resource>
      {kind === "connections" && (
        <p className="data-footnote">
          Connection status is operator recorded. Credentials are write-only;
          this release does not call provider APIs.
        </p>
      )}
    </>
  );
}
