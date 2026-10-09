import { useState } from "react";
import { Modal, Button, ErrorBox } from "./ui";
// Asks before a destructive action. `onConfirm` may throw; its message is shown
// in the dialog. Cancelled step-ups (error.cancelled) stay quiet.
export function ConfirmModal({ title, children, action, onConfirm, onClose }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function confirm() {
    setBusy(true);
    setError("");
    try {
      await onConfirm();
    } catch (e) {
      if (!e.cancelled) setError(e.message);
      setBusy(false);
    }
  }
  return (
    <Modal title={title} onClose={onClose}>
      <div className="subtle">{children}</div>
      {error && <ErrorBox>{error}</ErrorBox>}
      <div className="confirm-actions">
        <Button type="button" variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button type="button" variant="danger" busy={busy} onClick={confirm}>
          {action}
        </Button>
      </div>
    </Modal>
  );
}
