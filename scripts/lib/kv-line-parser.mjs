function maybeCoerce(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
}

export function parseKeyValueLine(line) {
  const text = String(line || "").trim();
  if (!text) return null;
  const out = {};
  for (const part of text.split(/\s+/)) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx);
    const value = part.slice(idx + 1);
    out[key] = maybeCoerce(value);
  }
  return Object.keys(out).length > 0 ? out : null;
}
