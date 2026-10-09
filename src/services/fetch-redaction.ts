/**
 * @fileoverview Keeps request URLs out of the text of fetch rejections. Runtimes can
 * quote the whole request URL in a rejection message (Bun 1.4 does, for some malformed
 * responses, in both the header and the body phase), and these services' query strings
 * carry an API key, the operator's contact email, and the caller's query. The message
 * becomes caller-facing error text, and the rejection rides `cause` into the log
 * record's cause chain, so every URL in it is cut to its origin first.
 * @module src/services/fetch-redaction
 */

/** An absolute `http:`/`https:` URL inside free text, up to the first quote, bracket, or space. */
const EMBEDDED_URL = /https?:\/\/[^\s"'`<>]+/gi;

/**
 * Names a URL by its origin, path and query elided behind markers
 * (`https://host/…?…`); an unparseable one becomes a fixed placeholder.
 */
function redactUrl(url: string): string {
  const parsed = URL.parse(url);
  if (!parsed) return '[unparseable URL]';
  const path = parsed.pathname === '/' ? '' : '/…';
  const query = parsed.search ? '?…' : '';
  return `${parsed.origin}${path}${query}`;
}

/**
 * A fetch rejection with every URL its text quotes reduced to the URL's origin. An
 * `Error` is rewritten in place, keeping its identity and transport `code`; one whose
 * `message` refuses the write is replaced by a stand-in carrying its `name` and `code`.
 * A non-`Error` rejection comes back as its redacted text.
 */
export function redactRejection(error: unknown): unknown {
  if (!(error instanceof Error)) return String(error).replace(EMBEDDED_URL, redactUrl);
  const message = error.message.replace(EMBEDDED_URL, redactUrl);
  if (message === error.message) return error;
  try {
    error.message = message;
  } catch {
    // A frozen or read-only `message`; the stand-in below takes over.
  }
  if (error.message === message) return error;
  const standIn = new Error(message);
  standIn.name = error.name;
  const { code } = error as { code?: unknown };
  return typeof code === 'string' ? Object.assign(standIn, { code }) : standIn;
}

/**
 * Awaits a response-body read (`response.text()`, `.json()`, `.arrayBuffer()`),
 * rethrowing its rejection with {@link redactRejection} applied. A failure while the
 * body streams is otherwise unchanged: same error, same classification.
 */
export async function readBody<T>(read: Promise<T>): Promise<T> {
  try {
    return await read;
  } catch (error: unknown) {
    throw redactRejection(error);
  }
}
