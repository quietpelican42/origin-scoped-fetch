import { OpaqueRedirectError, TooManyRedirectsError, UnreplayableRedirectBodyError } from './errors.ts';

export * from './errors.ts';

type FetchFn = typeof fetch;

/** Headers that carry no credential and are safe to forward across an origin change. */
const CROSS_ORIGIN_SAFE_HEADERS = new Set([
  'accept',
  'accept-language',
  'content-language',
  'user-agent',
]);

/** Headers dropped whenever a redirect degrades the request to a bodyless GET. */
const BODY_HEADERS = new Set(['content-type', 'content-length', 'content-encoding']);

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MAX_REDIRECTS = 20;

export interface OriginScopedFetchOptions {
  /** The underlying fetch to wrap. Default: the global `fetch`. Must have Node fetch semantics. */
  fetch?: FetchFn;
  /** Extra header names (case-insensitive) to keep when a redirect crosses origins. */
  allowCrossOriginHeaders?: string[];
  /** Redirect hops to follow before giving up. Default 20, matching browser `fetch`. */
  maxRedirects?: number;
}

export type OriginScopedFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Build an `originScopedFetch` bound to the given options. Use this when you
 * want a non-default `allowCrossOriginHeaders` list, `maxRedirects`, or an
 * underlying `fetch` (e.g. one wrapped by another library).
 */
export function createOriginScopedFetch(options: OriginScopedFetchOptions = {}): OriginScopedFetch {
  const underlying = options.fetch ?? globalThis.fetch;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const allowCrossOrigin = new Set(
    (options.allowCrossOriginHeaders ?? []).map((h) => h.toLowerCase()),
  );

  return async function originScopedFetch(
    input: string | URL | Request,
    init: RequestInit = {},
  ): Promise<Response> {
    // `redirect: 'manual'` and `redirect: 'error'` are the caller opting out of
    // automatic following entirely. Node's own fetch already implements both
    // correctly (manual: return the raw 3xx; error: throw a TypeError), so
    // those pass straight through untouched rather than being reimplemented.
    if (init.redirect === 'manual' || init.redirect === 'error') {
      const res = await underlying(input, init);
      assertNotOpaqueRedirect(res);
      return res;
    }

    // A `Request` input contributes its url/method/headers/body as defaults;
    // `init` overrides them field by field, same as native `fetch(req, init)`.
    // Other `Request`-only options (credentials, mode, cache, integrity,
    // signal) are NOT re-read per hop — pass those via `init` instead.
    const req = input instanceof Request ? input : null;
    let url = new URL(req ? req.url : input.toString());
    let method = (init.method ?? req?.method ?? 'GET').toUpperCase();
    let headers = new Headers(init.headers ?? req?.headers);
    let body: BodyInit | null = init.body !== undefined ? init.body : (req ? req.body : null);
    let origin = url.origin;
    let hops = 0;

    for (let hop = 0; ; hop++) {
      const res = await underlying(url, {
        ...init,
        method,
        headers,
        body,
        redirect: 'manual',
      });
      assertNotOpaqueRedirect(res);

      const status = res.status;
      const location = res.headers.get('location');

      if (!REDIRECT_STATUS.has(status) || location === null) {
        return hops === 0 ? res : rebuildResponse(res, url, true);
      }

      if (hop >= maxRedirects) {
        await res.body?.cancel();
        throw new TooManyRedirectsError(maxRedirects);
      }

      await res.body?.cancel(); // we're not reading this body; release the connection
      url = new URL(location, url);
      hops++;

      // Per the fetch spec: 303 (except on HEAD), and 301/302 on POST, degrade
      // the next request to a bodyless GET.
      if (status === 303 ? method !== 'HEAD' : (status === 301 || status === 302) && method === 'POST') {
        method = 'GET';
        body = null;
        headers = stripHeaders(headers, BODY_HEADERS);
      } else if (status === 307 || status === 308) {
        // Method and body are preserved. A ReadableStream body was already
        // consumed sending the previous hop and cannot be resent.
        if (isReadableStream(body)) {
          throw new UnreplayableRedirectBodyError(status);
        }
      }

      if (url.origin !== origin) {
        headers = scopeToOrigin(headers, allowCrossOrigin);
        origin = url.origin;
      }
    }
  };
}

/** Default instance, equivalent to `createOriginScopedFetch()`. */
export const originScopedFetch: OriginScopedFetch = createOriginScopedFetch();

export default originScopedFetch;

function isReadableStream(body: unknown): body is ReadableStream {
  return typeof ReadableStream !== 'undefined' && body instanceof ReadableStream;
}

/** Drop every header except a small cross-origin-safe allowlist plus the caller's own. */
function scopeToOrigin(headers: Headers, allow: Set<string>): Headers {
  const out = new Headers();
  headers.forEach((value, name) => {
    if (CROSS_ORIGIN_SAFE_HEADERS.has(name) || allow.has(name)) out.set(name, value);
  });
  return out;
}

function stripHeaders(headers: Headers, names: Set<string>): Headers {
  const out = new Headers(headers);
  for (const name of names) out.delete(name);
  return out;
}

/**
 * Browser `fetch` returns an opaque response (`type: 'opaqueredirect'`, status 0,
 * no readable headers) for `redirect: 'manual'`. Node's fetch does not — it
 * returns the real 3xx — which is the behaviour this whole package depends on.
 * If a caller-supplied `fetch` behaves like a browser's, fail loudly instead of
 * quietly treating a redirect as a normal 0-status response.
 */
function assertNotOpaqueRedirect(res: Response): void {
  if (res.type === 'opaqueredirect') throw new OpaqueRedirectError();
}

/**
 * Rebuild the terminal response so `url` and `redirected` reflect the redirect
 * chain. A `Response` returned by `fetch` carries those as read-only getters
 * from its internal state, which we cannot mutate directly — so instead we
 * wrap the same body stream and headers in a fresh `Response` and shadow the
 * two properties on that instance. Everything else (status, statusText,
 * headers, body bytes) is untouched.
 */
function rebuildResponse(res: Response, finalUrl: URL, redirected: boolean): Response {
  const wrapped = new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
  Object.defineProperty(wrapped, 'url', { value: finalUrl.toString(), enumerable: true });
  Object.defineProperty(wrapped, 'redirected', { value: redirected, enumerable: true });
  return wrapped;
}
