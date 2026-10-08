import { useState } from "react";
import {
  ShieldCheck,
  Plus,
  ExternalLink,
  Database,
  Archive,
  KeyRound,
  GitBranch,
  Cloud,
  ArrowUpRight,
} from "lucide-react";
import { useResource } from "../hooks/use-resource";
import {
  PageTitle,
  Resource,
  Badge,
  Empty,
  Pagination,
  Modal,
  Field,
  Select,
  Button,
  ErrorBox,
  Notice,
} from "../components/ui";
import { api, dateTime } from "../lib/api";
import { can } from "../../../shared/policy";
export function AuditPage() {
  const [page, setPage] = useState(1),
    resource = useResource(`/audit?page=${page}`);
  return (
    <>
      <PageTitle
        eyebrow="GOVERNANCE"
        title="Audit trail"
        description="Who changed what, and when. Operational changes are committed with their audit event."
      />
      <Resource resource={resource}>
        {(data) => (
          <>
            <div className="panel table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Action</th>
                    <th>Actor</th>
                    <th>Resource</th>
                    <th>Detail</th>
                    <th>Time</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => (
                    <tr key={row._id}>
                      <td className="mono small">{row.action}</td>
                      <td>{row.actorName}</td>
                      <td>
                        <span>{row.resource}</span>
                        <small className="cell-subtext mono">
                          {row.resourceId?.slice(0, 8)}
                        </small>
                      </td>
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
        )}
      </Resource>
      <p className="data-footnote">
        Audit records cannot be edited through this panel. Database
        administrators still control the database; this is not a tamper-proof
        compliance archive.
      </p>
    </>
  );
}
export function TeamPage({ user, onLogout }) {
  const resource = useResource("/team"),
    [invite, setInvite] = useState(false),
    [edit, setEdit] = useState(null),
    [error, setError] = useState("");
  async function revoke() {
    try {
      await api("/auth/revoke-sessions", { method: "POST", body: {} });
      onLogout();
    } catch (e) {
      setError(e.message);
    }
  }
  return (
    <>
      <PageTitle
        eyebrow="GOVERNANCE"
        title="Team & access"
        description="Internal permissions for the people behind your products."
        action={
          can(user.role, "team") && (
            <Button onClick={() => setInvite(true)}>
              <Plus size={16} />
              Add team member
            </Button>
          )
        }
      />
      {error && <ErrorBox>{error}</ErrorBox>}
      <Resource resource={resource}>
        {(data) => (
          <div className="panel table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Team member</th>
                  <th>Role</th>
                  <th>Access</th>
                  <th>Added</th>
                  <th>
                    <span className="sr-only">Manage</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <tr key={row._id}>
                    <td>
                      <strong>{row.name}</strong>
                      <small className="cell-subtext">{row.email}</small>
                    </td>
                    <td>
                      <Badge value={row.role}>
                        {row.role === "viewer" ? "Read-only" : row.role}
                      </Badge>
                    </td>
                    <td>
                      <Badge value={row.status} />
                    </td>
                    <td className="small subtle">{dateTime(row.createdAt)}</td>
                    <td>
                      {can(user.role, "team") && row.role !== "owner" && (
                        <Button
                          variant="secondary"
                          onClick={() => setEdit(row)}
                        >
                          Manage
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Resource>
      <div className="two-columns section-gap">
        <section className="panel aside-card">
          <ShieldCheck size={22} />
          <h2>Access by responsibility</h2>
          <dl className="permission-list">
            <dt>Owner</dt>
            <dd>Full administration, team and recovery.</dd>
            <dt>Admin</dt>
            <dd>Catalog, customers, installations and credentials.</dd>
            <dt>Operations</dt>
            <dd>Customer records, installations and work queue.</dd>
            <dt>Read-only</dt>
            <dd>View operational records without making changes.</dd>
          </dl>
        </section>
        <section className="panel aside-card">
          <KeyRound size={22} />
          <h2>Your account security</h2>
          <p>
            Every new session requires your password and an email code. Password
            recovery revokes existing sessions.
          </p>
          <Button variant="secondary" onClick={revoke}>
            Sign out all my sessions
          </Button>
          <p className="small">
            Invited staff use “First time here” on the login page with their
            approved email to set a password. No invitation email is sent
            automatically.
          </p>
        </section>
      </div>
      {(invite || edit) && (
        <TeamModal
          member={edit}
          onClose={() => {
            setInvite(false);
            setEdit(null);
          }}
          onSaved={() => {
            setInvite(false);
            setEdit(null);
            resource.reload();
          }}
        />
      )}
    </>
  );
}
function TeamModal({ member, onClose, onSaved }) {
  const [data, setData] = useState(
      member
        ? {
            role: member.role,
            status: member.status === "disabled" ? "disabled" : "active",
          }
        : { name: "", email: "", role: "operations" },
    ),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [done, setDone] = useState(false);
  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(`/team${member ? `/${member._id}` : ""}`, {
        method: member ? "PATCH" : "POST",
        body: { ...data, ...(member ? { revision: member.revision } : {}) },
      });
      if (member) onSaved();
      else setDone(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={member ? `Manage ${member.name}` : "Add team member"}
      onClose={done ? onSaved : onClose}
    >
      {done ? (
        <>
          <Notice>Staff access created for {data.email}.</Notice>
          <p>
            Share the admin URL with this person. They choose “First time here”,
            enter this email and verify the emailed code to set their password.
          </p>
          <Button onClick={onSaved}>Done</Button>
        </>
      ) : (
        <form onSubmit={save}>
          {error && <ErrorBox>{error}</ErrorBox>}
          {!member && (
            <>
              <Field label="Full name">
                <input
                  required
                  minLength={2}
                  maxLength={100}
                  value={data.name}
                  onChange={(e) => setData({ ...data, name: e.target.value })}
                />
              </Field>
              <Field label="Work email">
                <input
                  type="email"
                  required
                  maxLength={254}
                  value={data.email}
                  onChange={(e) => setData({ ...data, email: e.target.value })}
                />
              </Field>
            </>
          )}
          <Field label="Role">
            <Select
              value={data.role}
              onChange={(e) => setData({ ...data, role: e.target.value })}
              options={[
                "admin",
                "operations",
                { value: "viewer", label: "Read-only" },
              ]}
            />
          </Field>
          {member && (
            <>
              <Field label="Account access">
                <Select
                  value={data.status}
                  onChange={(e) => setData({ ...data, status: e.target.value })}
                  options={["active", "disabled"]}
                />
              </Field>
              <p className="form-note">
                Saving revokes this member’s current sessions immediately.
              </p>
            </>
          )}
          <Button type="submit" busy={busy}>
            {member ? "Update access" : "Create staff access"}
          </Button>
        </form>
      )}
    </Modal>
  );
}
export function StorePage() {
  const resource = useResource("/store");
  return (
    <>
      <PageTitle
        eyebrow="CONNECTED PLATFORM"
        title="Sandbee Store"
        description="A deliberately narrow, read-only view of your customer platform."
        action={
          <a
            className="button secondary"
            href="https://store.sandbee.in"
            target="_blank"
            rel="noreferrer"
          >
            Open Store
            <ExternalLink size={15} />
          </a>
        }
      />
      <Resource resource={resource}>
        {(data) =>
          !data.connected ? (
            <div className="panel">
              <Empty icon={Database} title="Connect your Store database">
                {data.reason} Configure STORE_MONGODB_URI with a read-only
                account, then restart Admin. No existing Store records will be
                modified.
              </Empty>
            </div>
          ) : (
            <>
              <div className="metric-grid two">
                <div className="metric-card">
                  <span>Store identities</span>
                  <strong>{data.users}</strong>
                </div>
                <div className="metric-card">
                  <span>Customer workspaces</span>
                  <strong>{data.workspaces}</strong>
                </div>
              </div>
              <div className="panel table-wrap">
                <div className="panel-title">
                  <h2>Recent workspaces</h2>
                  <Badge value="recorded">Read-only</Badge>
                </div>
                <table>
                  <thead>
                    <tr>
                      <th>Workspace</th>
                      <th>Workspace ID</th>
                      <th>Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recent.map((row) => (
                      <tr key={String(row._id)}>
                        <td>{row.name || "Unnamed workspace"}</td>
                        <td className="mono small">{String(row._id)}</td>
                        <td>{dateTime(row.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )
        }
      </Resource>
      <div className="notice section-gap">
        <ShieldCheck size={18} />
        <span>
          Customer authentication, API keys, licenses and app activation remain
          owned by Store. Admin credentials never grant customer API access.
        </span>
      </div>
    </>
  );
}
export function RecoveryPage() {
  const resource = useResource("/recovery"),
    [open, setOpen] = useState(false);
  const pillars = [
    [
      GitBranch,
      "Source & releases",
      "Keep the application source and each customer release in an off-machine repository or archive.",
    ],
    [
      Database,
      "Database snapshot",
      "Schedule encrypted backups away from the app server. Persistent Mongo storage is not a backup.",
    ],
    [
      KeyRound,
      "Separate recovery keys",
      "Keep the vault and backup keys in a secure, separately recoverable location.",
    ],
    [
      Cloud,
      "Customer accounts",
      "Confirm recovery access to each customer’s Vercel, MongoDB and Cloudflare accounts.",
    ],
  ];
  return (
    <>
      <PageTitle
        eyebrow="BUSINESS CONTINUITY"
        title="Ready beyond this computer."
        description="Recovery is a process you verify, not a green light you assume."
        action={
          <Button onClick={() => setOpen(true)}>
            <Plus size={16} />
            Record restore drill
          </Button>
        }
      />
      <div className="recovery-banner">
        <Archive size={28} />
        <div>
          <h2>Your recovery kit has four parts.</h2>
          <p>
            Source, database, keys and provider access. Store them separately,
            then test them together on another machine.
          </p>
        </div>
      </div>
      <div className="recovery-grid">
        {pillars.map(([Icon, title, text], index) => (
          <section className="panel aside-card" key={title}>
            <div className="recovery-card-top">
              <Icon size={23} />
              <span>0{index + 1}</span>
            </div>
            <h2>{title}</h2>
            <p>{text}</p>
          </section>
        ))}
      </div>
      <div className="two-columns section-gap">
        <section className="panel aside-card">
          <h2>Portable recovery workflow</h2>
          <ol className="steps">
            <li>
              <strong>Pause admin writes.</strong>
              <span>
                Stop all Admin API instances before taking an application
                snapshot.
              </span>
            </li>
            <li>
              <strong>Create an encrypted snapshot.</strong>
              <code>
                node --env-file=.env scripts/recovery.js backup --maintenance
              </code>
            </li>
            <li>
              <strong>Copy it off-machine.</strong>
              <span>
                Keep the source archive, .env and backup key in separate
                protected locations.
              </span>
            </li>
            <li>
              <strong>Restore into a new empty database.</strong>
              <span>
                Follow docs/DEPLOYMENT.md, verify login, record counts and
                credential decryption, then record the drill.
              </span>
            </li>
          </ol>
        </section>
        <section className="panel">
          <div className="panel-title">
            <div>
              <h2>Restore drill history</h2>
              <p>Operator evidence, not an automated backup guarantee</p>
            </div>
          </div>
          <Resource resource={resource}>
            {(data) =>
              data.rows.length ? (
                <div className="drill-list">
                  {data.rows.map((row) => (
                    <article key={row._id}>
                      <Badge value="recorded">{row.restoredAt}</Badge>
                      <h3>{row.location}</h3>
                      <p>{row.notes}</p>
                      <small>
                        {row.recordedBy} · Source {row.sourceRevision}
                      </small>
                    </article>
                  ))}
                </div>
              ) : (
                <Empty icon={ShieldCheck} title="No restore drill recorded">
                  Run a restore on a separate machine or scratch database and
                  record the result here.
                </Empty>
              )
            }
          </Resource>
        </section>
      </div>
      {open && (
        <RecoveryModal
          onClose={() => setOpen(false)}
          onSaved={() => {
            setOpen(false);
            resource.reload();
          }}
        />
      )}
    </>
  );
}
function RecoveryModal({ onClose, onSaved }) {
  const [data, setData] = useState({
      location: "",
      sourceRevision: "",
      restoredAt: new Date().toISOString().slice(0, 10),
      notes: "",
      keyStoredSeparately: false,
    }),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/recovery", { method: "POST", body: data });
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Record a restore drill" onClose={onClose}>
      <form onSubmit={submit}>
        {error && <ErrorBox>{error}</ErrorBox>}
        <Field
          label="Backup location reference"
          hint="A label or safe storage path. Do not paste credentials."
        >
          <input
            required
            minLength={3}
            maxLength={200}
            value={data.location}
            onChange={(e) => setData({ ...data, location: e.target.value })}
          />
        </Field>
        <Field label="Source revision / archive">
          <input
            required
            minLength={3}
            maxLength={160}
            value={data.sourceRevision}
            onChange={(e) =>
              setData({ ...data, sourceRevision: e.target.value })
            }
          />
        </Field>
        <Field label="Restore tested on">
          <input
            type="date"
            required
            value={data.restoredAt}
            onChange={(e) => setData({ ...data, restoredAt: e.target.value })}
          />
        </Field>
        <Field label="Verification results">
          <textarea
            required
            minLength={15}
            maxLength={2000}
            rows={4}
            value={data.notes}
            onChange={(e) => setData({ ...data, notes: e.target.value })}
          />
        </Field>
        <label className="check-row">
          <input
            required
            type="checkbox"
            checked={data.keyStoredSeparately}
            onChange={(e) =>
              setData({ ...data, keyStoredSeparately: e.target.checked })
            }
          />
          Encryption keys are recoverable separately from the backup
        </label>
        <Button type="submit" busy={busy}>
          Record verified drill
        </Button>
      </form>
    </Modal>
  );
}
