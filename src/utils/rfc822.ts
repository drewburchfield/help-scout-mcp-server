/**
 * Minimal RFC 822 / RFC 5322 parser for email source returned by the
 * Help Scout `original-source` endpoint. We only need the header block
 * for auto-reply / bulk-mail detection, so this is intentionally small —
 * no MIME decoding, no transfer-encoding handling, no body parsing.
 *
 * Handles:
 *  - CRLF, LF, or CR line endings (normalised to LF)
 *  - Header folding (continuation lines starting with whitespace)
 *  - Repeated headers (collapsed to an array, e.g. multiple `Received:`)
 *  - The blank-line header/body separator
 */

export interface ParsedMessage {
  // header name preserved with original case from the wire; values trimmed
  headers: Record<string, string | string[]>;
  body: string;
}

export function parseRfc822(raw: string): ParsedMessage {
  // normalise line endings so we can scan for a blank line consistently
  const normalised = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // headers and body are separated by the first blank line
  const sepIdx = normalised.indexOf('\n\n');
  const headerBlock = sepIdx === -1 ? normalised : normalised.slice(0, sepIdx);
  const body = sepIdx === -1 ? '' : normalised.slice(sepIdx + 2);

  // unfold continuation lines: any line starting with whitespace belongs to
  // the previous header. Per RFC 5322 §2.2.3 the leading WSP is significant
  // but a single space is the conventional join.
  const rawLines = headerBlock.split('\n');
  const unfolded: string[] = [];
  for (const line of rawLines) {
    if (line.length > 0 && /^[ \t]/.test(line) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += ' ' + line.replace(/^[ \t]+/, '');
    } else {
      unfolded.push(line);
    }
  }

  const headers: Record<string, string | string[]> = {};
  for (const line of unfolded) {
    if (line === '') continue;

    const colonIdx = line.indexOf(':');
    // skip malformed lines (e.g. the unix mbox `From ` envelope line has no colon)
    if (colonIdx === -1) continue;

    const name = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (!name) continue;

    if (Object.prototype.hasOwnProperty.call(headers, name)) {
      const existing = headers[name];
      headers[name] = Array.isArray(existing)
        ? [...existing, value]
        : [existing as string, value];
    } else {
      headers[name] = value;
    }
  }

  return { headers, body };
}
