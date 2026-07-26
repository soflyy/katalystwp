// Tiny logger that redacts known secret values and token-shaped strings, so a
// stray interpolation can never print the GitHub / Claude tokens.

let SECRETS = [];

// Token-ish substrings to scrub even if not in the known-secrets list.
const TOKEN_PATTERNS = [
  /\bsk_[A-Za-z0-9_-]{10,}/g, // cursor-style
  /\bgh[posru]_[A-Za-z0-9]{20,}/g, // github tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
];

export function initLog(secrets = []) {
  SECRETS = secrets.filter((s) => typeof s === 'string' && s.length >= 6);
}

// Merge more secret values into the redaction set at runtime (e.g. after a token
// is changed on the Settings page), so they're scrubbed from subsequent logs.
export function addSecrets(secrets = []) {
  for (const s of secrets) {
    if (typeof s === 'string' && s.length >= 6 && !SECRETS.includes(s)) SECRETS.push(s);
  }
}

export function redact(value) {
  let s = typeof value === 'string' ? value : safeStringify(value);
  for (const secret of SECRETS) s = s.split(secret).join('***');
  for (const re of TOKEN_PATTERNS) s = s.replace(re, '***');
  return s;
}

function safeStringify(v) {
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  try {
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  } catch {
    return String(v);
  }
}

function emit(stream, level, args) {
  const line = args.map((a) => redact(a)).join(' ');
  stream.write(`${new Date().toISOString()} ${level} ${line}\n`);
}

export const log = {
  info: (...a) => emit(process.stdout, 'INFO ', a),
  warn: (...a) => emit(process.stderr, 'WARN ', a),
  error: (...a) => emit(process.stderr, 'ERROR', a),
};
