// api.txt says /coap_push accepts "raw hex text, raw binary, JSON with hex
// field, or JSON with base64". Platforms (AEP, OneNet) also wrap the payload
// at varying depths under varying key names, so rather than hardcoding a shape
// we walk the JSON for the first string that decodes to a plausible frame.

const FRAME_START = 0x68;
const FRAME_END = 0x16;

const looksLikeFrame = (buf) =>
  buf.length >= 16 && buf[0] === FRAME_START && buf[buf.length - 1] === FRAME_END;

function fromHex(text) {
  const compact = text.replace(/[\s:,-]/g, '');
  if (compact.length === 0 || compact.length % 2 !== 0) return null;
  if (!/^[0-9a-fA-F]+$/.test(compact)) return null;
  return Buffer.from(compact, 'hex');
}

function fromBase64(text) {
  const compact = text.trim();
  if (!/^[A-Za-z0-9+/=_-]+$/.test(compact) || compact.length % 4 !== 0) return null;
  const buf = Buffer.from(compact, 'base64');
  return buf.length ? buf : null;
}

/** Every string in a JSON value, outermost first. */
function* strings(value, depth = 0) {
  if (depth > 8) return;
  if (typeof value === 'string') yield value;
  else if (Array.isArray(value)) for (const v of value) yield* strings(v, depth + 1);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) yield* strings(v, depth + 1);
}

/**
 * Pull a CJ/T 188 frame out of whatever the platform posted.
 * Returns { frame, encoding } or null if nothing frame-shaped was found.
 */
export function extractFrame(body) {
  if (!Buffer.isBuffer(body) || body.length === 0) return null;

  // Raw binary: a frame starts with 68H, which is 'h' -- never a hex digit, so
  // binary and hex-text bodies can't be confused with each other.
  if (looksLikeFrame(body)) return { frame: body, encoding: 'binary' };

  const text = body.toString('utf8').trim();
  if (!text) return null;

  if (text.startsWith('{') || text.startsWith('[')) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
    for (const candidate of strings(parsed)) {
      const hex = fromHex(candidate);
      if (hex && looksLikeFrame(hex)) return { frame: hex, encoding: 'json-hex' };
      const b64 = fromBase64(candidate);
      if (b64 && looksLikeFrame(b64)) return { frame: b64, encoding: 'json-base64' };
    }
    return null;
  }

  const hex = fromHex(text);
  if (hex) return { frame: hex, encoding: 'hex' };
  const b64 = fromBase64(text);
  if (b64) return { frame: b64, encoding: 'base64' };
  return null;
}
