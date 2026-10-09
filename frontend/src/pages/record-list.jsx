import { useState } from "react";
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
} from "../components/ui";
import { Link } from "../lib/router";
import { dateTime, label } from "../lib/api";
import { ProductCatalog } from "../components/product-catalog";
import { PRODUCT_MODELS } from "../../../shared/product-models";
import { can } from "../../../shared/policy";
export function RecordList({ kind, user }) {
  const def = definitions[kind],
    [page, setPage] = useState(1),
    [search, setSearch] = useState(() =>
      (new URLSearchParams(location.search).get("search") || "").slice(0, 100),
    ),
    [status, setStatus] = useState(""),
    [model, setModel] = useState("");
  const resource = useResource(
      `/${kind}?page=${page}&search=${encodeURIComponent(search)}&status=${status}&model=${model}`,
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
          onChange={(value) => {
            setSearch(value);
            setPage(1);
          }}
          placeholder={`Search ${def.title.toLowerCase()}…`}
        />
        {kind === "products" && (
          <Select
            aria-label="Filter by delivery model"
            value={model}
            onChange={(event) => {
              setModel(event.target.value);
              setPage(1);
            }}
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
          onChange={(event) => {
            setStatus(event.target.value);
            setPage(1);
          }}
          options={[{ value: "", label: "All statuses" }, ...def.statuses]}
        />
      </div>
      <Resource resource={resource}>
        {(data) =>
          !data.rows.length ? (
            <div className="panel">
              <Empty
                icon={Database}
                title={
                  search || status
                    ? "No matching records"
                    : `Your ${def.title.toLowerCase()} start here`
                }
              >
                {search || status
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
