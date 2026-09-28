/** Base class for every error this library throws. */
export class OriginScopedFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The server redirected more times than `maxRedirects` allows. */
export class TooManyRedirectsError extends OriginScopedFetchError {
  maxRedirects: number;
  constructor(maxRedirects: number) {
    super(`Exceeded maxRedirects (${maxRedirects})`);
    this.maxRedirects = maxRedirects;
  }
}

/**
 * A 307/308 redirect needs to resend the request body, but the body was a
 * `ReadableStream` that this library already consumed sending the first
 * request. Streams are single-use; there is nothing left to resend.
 */
export class UnreplayableRedirectBodyError extends OriginScopedFetchError {
  status: number;
  constructor(status: number) {
    super(
      `Cannot follow a ${status} redirect: the request body is a ReadableStream, ` +
        `which was already consumed sending the original request and cannot be replayed. ` +
        `Pass the body as a string, Buffer/TypedArray, Blob, or FormData instead, or set ` +
        `redirect: 'manual' and resend it yourself.`,
    );
    this.status = status;
  }
}

/**
 * The underlying `fetch` returned an opaque redirect (`response.type ===
 * 'opaqueredirect'`) instead of a readable 3xx with a `Location` header.
 * That is how *browser* `fetch` behaves under `redirect: 'manual'`; this
 * library is Node-only and requires Node's `fetch`, which exposes the real
 * status and headers.
 */
export class OpaqueRedirectError extends OriginScopedFetchError {
  constructor() {
    super(
      "The underlying fetch returned an opaque redirect response (type: 'opaqueredirect') " +
        "instead of a readable 3xx. origin-scoped-fetch is Node-only: it relies on Node's " +
        "fetch (undici) returning the real status and a readable Location header for " +
        "redirect: 'manual', which browser fetch implementations do not do. If you passed " +
        'a custom `fetch` via createOriginScopedFetch({ fetch }), it must have Node fetch semantics.',
    );
  }
}
