import { CRIT_PCT, WARN_PCT, levelOf } from "../../../../shared/usage";
// A single ratio against a free-tier limit (dataviz "meter"): a thin bar whose
// FILL carries the severity and whose TRACK is the light step of the same ramp,
// with hairline marks at the warning (75 %) and critical (90 %) thresholds.
// The value and, when it needs attention, the level word are always written
// next to it, so nothing depends on colour. No hover layer: the text is the
// whole reading.
const clamp = (value) => Math.min(100, Math.max(0, value));
const MARKS = [WARN_PCT, CRIT_PCT];
export function Meter({ fraction, label, text }) {
  const level = levelOf(fraction),
    percent = clamp(Number.isFinite(fraction) ? fraction * 100 : 0),
    now = Math.round(percent * 10) / 10;
  return (
    <div className={`usage-meter usage-meter-${level}`}>
      <div
        className="usage-meter-bar"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={now}
        aria-valuetext={text}
      >
        <span className="usage-meter-track">
          <span className="usage-meter-fill" style={{ width: `${percent}%` }} />
        </span>
        {MARKS.map((mark) => (
          <span
            key={mark}
            className="usage-meter-mark"
            style={{ left: `${mark * 100}%` }}
            aria-hidden="true"
          />
        ))}
      </div>
      {/* Visible and readable text too: `meter` support in screen readers
          is uneven, so the value never lives only in aria-valuetext. */}
      <p className="usage-meter-text">{text}</p>
    </div>
  );
}
