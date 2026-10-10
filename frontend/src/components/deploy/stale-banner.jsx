import { TriangleAlert } from "lucide-react";
const time = (ms) =>
  new Date(ms).toLocaleTimeString("en-GB", { hour12: false });
// Shown while a poll keeps failing after data was loaded; clears on success.
export function StaleBanner({ poll }) {
  if (!poll.stale) return null;
  return (
    <div className="notice notice-warning stale-banner" role="status">
      <TriangleAlert size={16} aria-hidden="true" />
      <span>
        Last updated {time(poll.updatedAt)} — retrying… What you see may be out
        of date.
      </span>
    </div>
  );
}
