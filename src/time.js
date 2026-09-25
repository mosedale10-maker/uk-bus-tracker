const UK_TZ = "Europe/London";
const NAIVE_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;
const HAS_TIMEZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

// One-day D&G Route 27 message: hide it from 3pm UK time on 25 September 2026.
const SIMON_NOTE_END = Date.parse("2026-09-25T15:00:00+01:00");

export function isSimonNoteActive(now = Date.now()) {
  const at = Number(now);
  return !Number.isFinite(at) || at < SIMON_NOTE_END;
}

let ukPartsFormatter;
function ukTimeZoneOffsetMs(date) {
  try {
    ukPartsFormatter ||= new Intl.DateTimeFormat("en-US", {
      timeZone: UK_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    const parts = Object.fromEntries(
      ukPartsFormatter
        .formatToParts(date)
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, Number(part.value)]),
    );
    const localAsUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    return localAsUtc - date.getTime();
  } catch {
    return 0;
  }
}

/**
 * Parse a feed timestamp. NextStop's AT timestamps are UK wall-clock values
 * without an offset; treating them as UTC makes them appear one hour in the
 * future during BST and causes the recorder to reject/reset the trail.
 */
export function parseUkFeedTimestamp(raw, fallback = NaN) {
  const text = String(raw ?? "").trim();
  if (!text) return fallback;
  const direct = Date.parse(text);
  if (!Number.isFinite(direct)) return fallback;
  if (!NAIVE_DATE_TIME.test(text) || HAS_TIMEZONE.test(text)) return direct;
  const wallAsUtc = Date.parse(`${text}Z`);
  if (!Number.isFinite(wallAsUtc)) return direct;
  return wallAsUtc - ukTimeZoneOffsetMs(new Date(wallAsUtc));
}

export function normalizeUkFeedTimestamp(raw, fallback = Date.now()) {
  const value = parseUkFeedTimestamp(raw, fallback);
  return Number.isFinite(value) ? new Date(value).toISOString() : "";
}
