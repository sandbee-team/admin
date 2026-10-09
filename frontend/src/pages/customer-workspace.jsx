import { useState } from "react";
import {
  FileText,
  KeyRound,
  LayoutDashboard,
  Rocket,
  ScrollText,
  Users,
} from "lucide-react";
import { useResource } from "../hooks/use-resource";
import {
  Resource,
  PageTitle,
  Badge,
  NewLink,
  Empty,
  Pagination,
} from "../components/ui";
import { WorkspaceFrame } from "../components/workspace-frame";
import { Link } from "../lib/router";
import { dateTime } from "../lib/api";
import { can } from "../../../shared/policy";
import { RecordEditor } from "./record-editor";
import { AccountsSection } from "./customer-accounts";
import { FilesSection } from "./customer-files";
const TABS = [
  ["", "Summary", LayoutDashboard],
  ["installations", "Installations", Rocket],
  ["accounts", "Accounts", KeyRound],
  ["files", "Files", FileText],
  ["activity", "Activity", ScrollText],
];
export function CustomerWorkspace({ id, section = "", user }) {
  const resource = useResource(`/customers/${id}`);
  return (
    <Resource resource={resource}>
      {(customer) => (
        <WorkspaceFrame
          back="/customers"
          backLabel="All customers"
          icon={Users}
          title={customer.name}
          subtitle={customer.company || customer.email}
          base={`/customers/${id}`}
          tabs={TABS}
          section={section}
          navLabel="Customer navigation"
        >
          {section === "" ? (
            <RecordEditor
              kind="customers"
              id={id}
              user={user}
              onSaved={() => resource.refresh().catch(() => {})}
            />
          ) : section === "installations" ? (
            <CustomerInstallations customer={customer} user={user} />
          ) : section === "accounts" ? (
            <AccountsSection customerId={id} user={user} />
          ) : section === "files" ? (
            <FilesSection customerId={id} user={user} />
          ) : section === "activity" ? (
            <Activity customerId={id} />
          ) : (
            <Empty title="Page not found">
              Choose a customer section to continue.
            </Empty>
          )}
        </WorkspaceFrame>
      )}
    </Resource>
  );
}
function CustomerInstallations({ customer, user }) {
  const [page, setPage] = useState(1),
    resource = useResource(
      `/installations?customerId=${customer._id}&page=${page}`,
    );
  return (
    <>
      <PageTitle
        eyebrow={customer.name}
        title="Installations"
        description="Product environments set up for this customer."
        action={
          can(user.role, "operate") && (
            <NewLink href="/installations/new">Add installation</NewLink>
          )
        }
      />
      <Resource resource={resource}>
        {(data) =>
          data.rows.length ? (
            <>
              <div className="panel table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Installation</th>
                      <th>Environment</th>
                      <th>Release</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((row) => (
                      <tr key={row._id}>
                        <td>
                          <Link
                            className="table-name"
                            href={`/installations/${row._id}`}
                          >
                            {row.name}
                          </Link>
                        </td>
                        <td>{row.environment}</td>
                        <td>{row.release || "Not recorded"}</td>
                        <td>
                          <Badge value={row.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination data={data} page={page} onPage={setPage} />
            </>
          ) : (
            <div className="panel">
              <Empty icon={Rocket} title="No installations yet">
                Add an installation to track this customer’s product setup.
              </Empty>
            </div>
          )
        }
      </Resource>
    </>
  );
}
function Activity({ customerId }) {
  const [page, setPage] = useState(1),
    resource = useResource(`/audit?customerId=${customerId}&page=${page}`);
  return (
    <>
      <PageTitle
        eyebrow="CUSTOMER"
        title="Activity"
        description="Changes to this customer and its installations, including every reveal and download."
      />
      <Resource resource={resource}>
        {(data) =>
          data.rows.length ? (
            <>
              <div className="panel table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Action</th>
                      <th>Actor</th>
                      <th>Detail</th>
                      <th>Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((row) => (
                      <tr key={row._id}>
                        <td className="mono small">{row.action}</td>
                        <td>{row.actorName}</td>
                        <td>{row.detail || "—"}</td>
                        <td className="small subtle">
                          {dateTime(row.createdAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination data={data} page={page} onPage={setPage} />
            </>
          ) : (
            <div className="panel">
              <Empty icon={ScrollText} title="No activity yet">
                Events appear here as this customer’s record changes.
              </Empty>
            </div>
          )
        }
      </Resource>
    </>
  );
}
