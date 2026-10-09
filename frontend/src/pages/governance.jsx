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
  TextLink,
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
                    <th>IP address</th>
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
                      <td className="small subtle mono">{row.ip || "—"}</td>
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
            Every new session requires your password and an email code, plus
            your authenticator code once it is set up. Password recovery revokes
            existing sessions.
          </p>
          <TextLink href="/account">Authenticator and backup codes</TextLink>
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
      "Database dump",
      "Take a mongodump of sandbee_admin to your own PC by hand. Secrets inside are sealed and useless without the vault key. Persistent Mongo storage is not a backup.",
    ],
    [
      KeyRound,
      "Vault key copies",
      "Keep VAULT_KEY in three places: the server, a password manager and an offline sealed copy. Never next to the dumps.",
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
      <Resource resource={resource}>
        {(data) => <KeyCopies data={data} />}
      </Resource>
      <div className="two-columns section-gap">
        <section className="panel aside-card">
          <h2>Portable recovery workflow</h2>
          <ol className="steps">
            <li>
              <strong>Dump the admin database.</strong>
              <code>
                mongodump --uri "&lt;sandbee_admin URI&gt;" --out &lt;folder&gt;
              </code>
              <span>
                Run it on your own PC. Customer files are not in the dump: the
                S3 bucket is their copy.
              </span>
            </li>
            <li>
              <strong>Keep the keys apart from the dump.</strong>
              <span>
                Verify each key copy above after you save or change it.
              </span>
            </li>
            <li>
              <strong>Restore on a scratch machine.</strong>
              <span>
                Follow docs/DEPLOYMENT.md: restore into a new database, start
                Admin with the same VAULT_KEY, sign in and reveal one test
                secret. Then record the drill.
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
            {(data) => (
              <>
                <DrillStatus status={data.drillStatus} />
                {data.rows.length ? (
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
                )}
              </>
            )}
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
const COPIES = [
  ["server", "Server copy"],
  ["password-manager", "Password manager copy"],
  ["offline", "Offline sealed copy"],
];
const verifyCommand = (kind, copy) =>
  copy === "server"
    ? `docker compose -f compose.production.yaml exec -T app node scripts/recovery.js verify-key --kind=${kind} --copy=server --from-env`
    : `docker compose -f compose.production.yaml exec app node scripts/recovery.js verify-key --kind=${kind} --copy=${copy}`;
function KeyCopyList({ kind, checks }) {
  return (
    <ul className="key-list">
      {COPIES.map(([copy, name]) => {
        const check = checks?.[copy];
        return (
          <li key={copy}>
            <div className="key-list-head">
              <strong>{name}</strong>
              {check?.current ? (
                <Badge value="live">Verified {dateTime(check.at)}</Badge>
              ) : check ? (
                <Badge value="attention">
                  Verified {dateTime(check.at)} against an older key
                </Badge>
              ) : (
                <Badge value="attention">Never verified</Badge>
              )}
            </div>
            <code>{verifyCommand(kind, copy)}</code>
          </li>
        );
      })}
    </ul>
  );
}
function KeyCopies({ data }) {
  const { vault, backup } = data.keys;
  return (
    <section className="panel aside-card section-gap" aria-labelledby="keys-h">
      <h2 id="keys-h">Key copies</h2>
      <p>
        The vault key unlocks every saved secret. A dump of the database is
        useless without it, so each copy must be proven correct, not assumed.
        The command asks for the key with hidden input (or reads it from stdin);
        the key is never shown here, only its fingerprint.
      </p>
      <p className="key-print">
        Vault key fingerprint <code>{vault.fingerprint}</code>
      </p>
      <KeyCopyList kind="vault" checks={data.keyChecks.vault} />
      {backup.state === "configured" ? (
        <>
          <p className="key-print">
            Backup key fingerprint <code>{backup.fingerprint}</code>
          </p>
          <KeyCopyList kind="backup" checks={data.keyChecks.backup} />
        </>
      ) : backup.state === "invalid" ? (
        <ErrorBox>
          BACKUP_KEY is set but is not a valid 64-character key. Fix or remove
          it.
        </ErrorBox>
      ) : (
        <p className="key-print">
          Backup key: not used — admin backups are manual mongodumps.
        </p>
      )}
    </section>
  );
}
function DrillStatus({ status }) {
  const text = {
    green: "Drill up to date",
    amber: "Drill due soon",
    red: status.lastDrill ? "Drill overdue" : "No drill yet",
  }[status.state];
  return (
    <p className="drill-status">
      <Badge
        value={
          status.state === "green"
            ? "live"
            : status.state === "amber"
              ? "attention"
              : "disabled"
        }
      >
        {text}
      </Badge>
      <span>
        {status.lastDrill
          ? `Last drill ${status.lastDrill} (${status.daysSince} days ago). Aim for one every 100 days.`
          : "Aim for a restore drill every 100 days."}
      </span>
    </p>
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
