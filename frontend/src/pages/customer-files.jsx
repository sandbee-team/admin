import { useEffect, useRef, useState } from "react";
import { Download, FileText, RotateCcw, Trash2, Upload } from "lucide-react";
import { useResource } from "../hooks/use-resource";
import {
  PageTitle,
  Resource,
  Badge,
  Button,
  Empty,
  ErrorBox,
  Field,
  Notice,
  Select,
} from "../components/ui";
import { ConfirmModal } from "../components/confirm";
import { withStepUp } from "../components/step-up";
import { api, upload, download, dateTime } from "../lib/api";
import { can } from "../../../shared/policy";
// Mirror shared/schemas.js (FILE_CATEGORIES, FILE_EXTENSIONS, MAX_FILE_BYTES);
// the API enforces them again.
const CATEGORIES = [
  { value: "agreement", label: "Agreement" },
  { value: "kyc", label: "KYC" },
  { value: "invoice", label: "Invoice" },
  { value: "screenshot", label: "Screenshot" },
  { value: "db-backup", label: "Database backup" },
  { value: "other", label: "Other" },
];
const EXTENSIONS = [
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "txt",
  "csv",
  "json",
  "zip",
  "gz",
  "docx",
  "xlsx",
];
const MAX_BYTES = 20 * 1024 * 1024;
const categoryName = (value) =>
  CATEGORIES.find((item) => item.value === value)?.label || value;
const size = (bytes) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
function problemWith(file) {
  if (!file) return "Choose a file to upload.";
  if (file.size < 1) return "The file is empty.";
  if (file.size > MAX_BYTES) return "Files can be at most 20 MB.";
  const ext = file.name.includes(".")
    ? file.name.split(".").pop().toLowerCase()
    : "";
  if (!EXTENSIONS.includes(ext))
    return `This file type is not allowed. Use ${EXTENSIONS.join(", ")}.`;
  return "";
}
export function FilesSection({ customerId, user }) {
  const allowed = can(user.role, "credentials"),
    resource = useResource(allowed ? `/customers/${customerId}/files` : null);
  return (
    <>
      <PageTitle
        eyebrow="CUSTOMER VAULT"
        title="Files"
        description="Agreements, KYC and backups. Each file is encrypted before it leaves this server."
      />
      {!allowed ? (
        <div className="panel">
          <Empty icon={FileText} title="Files are restricted">
            Your role cannot open the file vault. Ask an owner or admin.
          </Empty>
        </div>
      ) : (
        <Resource resource={resource}>
          {(data) => (
            <FileList customerId={customerId} initial={data.rows} user={user} />
          )}
        </Resource>
      )}
    </>
  );
}
function FileList({ customerId, initial, user }) {
  const [rows, setRows] = useState(initial),
    [category, setCategory] = useState("agreement"),
    [error, setError] = useState(""),
    [storageOff, setStorageOff] = useState(false),
    [busy, setBusy] = useState(""),
    [confirm, setConfirm] = useState(null),
    [probe, setProbe] = useState(null),
    input = useRef(),
    urls = useRef(new Set());
  const base = `/customers/${customerId}/files`,
    owner = can(user.role, "secrets");
  // Blob URLs outlive the click so slow browsers can finish the download.
  useEffect(() => {
    const held = urls.current;
    return () => held.forEach((url) => URL.revokeObjectURL(url));
  }, []);
  function fail(e) {
    if (e.cancelled) return;
    if (e.code === "not-configured") setStorageOff(true);
    else
      setError(
        e.status === 408
          ? "Upload timed out — try a faster connection or a smaller file."
          : e.message,
      );
  }
  const refresh = async () => setRows((await api(base)).rows);
  async function send(event) {
    event.preventDefault();
    const file = input.current.files[0],
      problem = problemWith(file);
    setError("");
    if (problem) return setError(problem);
    setBusy("upload");
    try {
      const saved = await upload(base, file, {
        "X-File-Name": encodeURIComponent(file.name),
        "X-File-Category": category,
      });
      setRows((list) => [...list, saved]);
      input.current.value = "";
    } catch (e) {
      fail(e);
    } finally {
      setBusy("");
    }
  }
  async function save(file) {
    setError("");
    setBusy(`download-${file.id}`);
    try {
      const { blob, filename } = await withStepUp(() =>
        download(`${base}/${file.id}/download`, {}),
      );
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      urls.current.add(url);
      setTimeout(() => {
        urls.current.delete(url);
        URL.revokeObjectURL(url);
      }, 30000);
    } catch (e) {
      fail(e);
    } finally {
      setBusy("");
    }
  }
  async function remove(file) {
    await withStepUp(() =>
      api(`${base}/${file.id}`, { method: "DELETE", body: {} }),
    );
    await refresh();
    setConfirm(null);
  }
  async function restore(file) {
    setError("");
    setBusy(`restore-${file.id}`);
    try {
      const saved = await api(`${base}/${file.id}/restore`, {
        method: "POST",
        body: {},
      });
      setRows((list) => list.map((row) => (row.id === saved.id ? saved : row)));
    } catch (e) {
      fail(e);
      if (e.status === 410) refresh().catch(() => {});
    } finally {
      setBusy("");
    }
  }
  async function selfTest() {
    setError("");
    setProbe(null);
    setBusy("test");
    try {
      setProbe(await api("/files/self-test", { method: "POST", body: {} }));
    } catch (e) {
      fail(e);
    } finally {
      setBusy("");
    }
  }
  return (
    <>
      {storageOff && (
        <div className="notice notice-warning">
          <FileText size={16} />
          <span>
            File storage is not configured on this server, so uploads and
            downloads are unavailable. Existing file records are still listed.
          </span>
        </div>
      )}
      {error && <ErrorBox>{error}</ErrorBox>}
      {probe &&
        (probe.ok && probe.versioning ? (
          <Notice>
            Storage test passed: write, versioned read, delete and listing all
            work.
          </Notice>
        ) : (
          <div className="notice notice-warning" role="status">
            <FileText size={16} />
            <span>
              Storage test failed. Versioning:{" "}
              {probe.versioning ? "ok" : "not confirmed"}. Listing:{" "}
              {probe.listing ? "ok" : "failed"}. Check the bucket and its
              versioning setting.
            </span>
          </div>
        ))}
      <form className="panel upload-panel" onSubmit={send}>
        <Field
          label="File"
          hint="Up to 20 MB. PDF, images, text, CSV, JSON, ZIP, GZ, DOCX or XLSX."
        >
          <input
            ref={input}
            type="file"
            required
            accept={EXTENSIONS.map((ext) => `.${ext}`).join(",")}
          />
        </Field>
        <Field label="Category">
          <Select
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            options={CATEGORIES}
          />
        </Field>
        <div className="account-actions">
          <Button type="submit" busy={busy === "upload"}>
            <Upload size={15} />
            Upload file
          </Button>
          {owner && (
            <Button
              type="button"
              variant="secondary"
              busy={busy === "test"}
              onClick={selfTest}
            >
              Test storage
            </Button>
          )}
        </div>
      </form>
      {rows.length ? (
        <div className="panel table-wrap">
          <table>
            <thead>
              <tr>
                <th>File</th>
                <th>Category</th>
                <th>Size</th>
                <th>Uploaded by</th>
                <th>Uploaded</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((file) => (
                <tr key={file.id}>
                  <td>
                    <span className="table-name">{file.name}</span>
                    {file.deletedAt && (
                      <small className="cell-subtext">
                        <Badge value="retired">Deleted</Badge>
                      </small>
                    )}
                  </td>
                  <td>{categoryName(file.category)}</td>
                  <td>{size(file.size)}</td>
                  <td>{file.uploadedBy}</td>
                  <td className="small subtle">{dateTime(file.uploadedAt)}</td>
                  <td>
                    <div className="file-actions">
                      {file.deletedAt ? (
                        file.restorable ? (
                          <Button
                            variant="secondary"
                            busy={busy === `restore-${file.id}`}
                            aria-label={`Restore ${file.name}`}
                            onClick={() => restore(file)}
                          >
                            <RotateCcw size={14} />
                            Restore
                          </Button>
                        ) : (
                          <span className="small subtle">Cannot restore</span>
                        )
                      ) : (
                        owner && (
                          <>
                            <Button
                              variant="secondary"
                              busy={busy === `download-${file.id}`}
                              aria-label={`Download ${file.name}`}
                              onClick={() => save(file)}
                            >
                              <Download size={14} />
                              Download
                            </Button>
                            <Button
                              variant="danger"
                              aria-label={`Delete ${file.name}`}
                              onClick={() => setConfirm(file)}
                            >
                              <Trash2 size={14} />
                              Delete
                            </Button>
                          </>
                        )
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="panel">
          <Empty icon={FileText} title="No files yet">
            Upload an agreement, KYC document or database backup to keep it with
            this customer.
          </Empty>
        </div>
      )}
      {confirm && (
        <ConfirmModal
          title="Delete this file?"
          action="Delete file"
          onClose={() => setConfirm(null)}
          onConfirm={() => remove(confirm)}
        >
          <p>
            {confirm.name} is removed from storage now. You can restore it for
            29 days.
          </p>
        </ConfirmModal>
      )}
    </>
  );
}
