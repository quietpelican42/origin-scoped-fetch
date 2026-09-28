# origin-scoped-fetch

`fetch` that stops your own `authorization`, `cookie`, and custom API-key headers from following a redirect onto a different origin.

```ts
import { originScopedFetch } from 'origin-scoped-fetch';

// Same signature as fetch. authorization/cookie/x-api-key survive same-origin
// redirects and get dropped the moment a redirect crosses an origin.
const res = await originScopedFetch('https://api.example.com/resource', {
  headers: { authorization: 'Bearer ...', 'x-api-key': '...' },
});
```

## Why

Per the [Fetch spec](https://fetch.spec.whatwg.org/#http-redirect-fetch), when a redirect crosses an origin, the browser (and Node's `fetch`, which follows the same algorithm) strips exactly three request headers: `Authorization`, `Cookie`, and `Proxy-Authorization`. Any header you set yourself — `x-api-key`, `x-auth-token`, a custom `Authorization`-shaped scheme under a different name — is not on that list and is forwarded verbatim.

This matters whenever the redirect target isn't fully trusted: webhook delivery to a user-supplied URL, an internal proxy that fetches on a caller's behalf, a link unfurler, a client for a third-party API you don't control the redirect chain of. A single `302` from `api.example.com` to `attacker.example.com` exfiltrates whatever header carries your credential, unless it happens to be one of the three the spec covers.

The obvious defenses don't hold up:

- Checking that `Authorization` and `Cookie` are stripped: they are, by the runtime, already. That is not the gap. The gap is every other header.
- Reading `res.redirected` and deciding after the fact: by the time you can inspect that, `fetch` already made the second request with your headers attached. There is nothing left to prevent.
- `redirect: 'manual'` alone: this stops fetch from following the redirect for you, but now you have to resolve `Location`, decide whether to strip headers, and re-request — which is what this package does, including the method/body degradation rules for 301/302/303/307/308.

Measured: `node examples/leak-demo.ts` — server A redirects to server B on a different origin, with `authorization`, `cookie`, and `x-api-key` set on the request:

```
  A: http://127.0.0.1:54493  --302-->  B: http://localhost:54492  (different origin: different host)

  headers sent: authorization, cookie, x-api-key

  native fetch  -> server B received: { authorization: null, cookie: null, 'x-api-key': 'my-custom-api-key' }
  originScopedFetch -> server B received: { authorization: null, cookie: null, 'x-api-key': null }
```

Native `fetch` already drops `Authorization` and `Cookie` across an origin change — that part of the Fetch spec is implemented. It does not touch anything else set on the request; `originScopedFetch` drops `x-api-key` too. Checked incumbents: axios and got were read for their redirect/header handling but not run against this package's test matrix — see Limitations.

## Installation

```sh
npm install origin-scoped-fetch
```

Node >= 20.6. No runtime dependencies.

## Usage

### Default header scoping

```ts
import { originScopedFetch } from 'origin-scoped-fetch';

const res = await originScopedFetch('https://api.example.com/resource', {
  headers: { authorization: 'Bearer ...', 'x-api-key': '...' },
});
```

### Custom allowlist, redirect cap, or underlying fetch

```ts
import { createOriginScopedFetch } from 'origin-scoped-fetch';

const scopedFetch = createOriginScopedFetch({
  allowCrossOriginHeaders: ['x-request-id'], // never authorization/cookie-shaped headers
  maxRedirects: 10,
});
```

### Request input

`originScopedFetch(new Request(url, init))` works like `fetch(request)`: url, method, headers, and body come from the `Request` unless `init` overrides them. A `Request`'s body is a `ReadableStream`; it is read into an `ArrayBuffer` once, up front (`await request.clone().arrayBuffer()`), rather than passed through as a stream. That is what makes a `Request` with a body a true drop-in replacement — sending a stream body requires Node's `duplex: 'half'` even on the very first hop, and a stream cannot be replayed if a 307/308 needs to resend it — and it costs nothing extra for a request that never redirects.

A `Request`'s `signal` is forwarded and honored: aborting it aborts `originScopedFetch` on every hop, and this is covered by a test. `credentials`, `keepalive`, `integrity`, and `referrerPolicy` are forwarded the same way on a best-effort basis — Node's `fetch` accepts them without erroring — but only `signal` propagation is individually tested here. `mode` and `cache` are not carried over from a `Request` at all.

## Reference

### `originScopedFetch(input, init?)`

Same signature as `fetch`. Uses the built-in cross-origin-safe header list and the defaults below.

### `createOriginScopedFetch(options?)`

Returns a `fetch`-compatible function with the given options applied.

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `fetch` | function | global `fetch` | The underlying fetch to wrap. Must have Node fetch semantics (see How it works). |
| `allowCrossOriginHeaders` | `string[]` | `[]` | Extra header names (case-insensitive) to keep across an origin change, in addition to the built-in safe list. |
| `maxRedirects` | `number` | `20` | Redirect hops to follow before throwing `TooManyRedirectsError`, matching browser `fetch`'s default. |

The built-in cross-origin-safe list is `accept`, `accept-language`, `content-language`, `user-agent` — headers with no credential value. Everything else set on the request is dropped the moment the redirect chain's origin changes, unless added to `allowCrossOriginHeaders`. This is intentionally stricter than the Fetch spec's own three-header strip list: the point of this package is to default-deny, not to special-case a few more known-bad names.

`method`, `headers`, `body`, `signal`, and the rest of `RequestInit` behave as in `fetch`. `redirect: 'manual'` and `redirect: 'error'` are passed straight through to the underlying `fetch` untouched — this package only intervenes when it is the one following the redirect (the default, `redirect: 'follow'` or unset).

### Redirect semantics

Followed to the Fetch spec, on top of Node's manual-redirect fetch:

- 301, 302 on POST — method becomes `GET`, body and body-related headers (`content-type`, `content-length`, `content-encoding`) are dropped.
- 303 — method becomes `GET`, except when the original method was `HEAD`.
- 307, 308 — method and body are preserved unchanged, including across an origin change. The Fetch spec gives no mechanism to drop the body on 307/308, so it is resent to the new origin exactly as given. The headers that describe that body (`content-type`, `content-encoding`, `content-language`) are kept too, even cross-origin: the body is going there either way, and stripping the label without stripping the body would just relabel it, not protect it. Every other header still gets scoped to the new origin as usual. If the body is a `ReadableStream`, it was already consumed sending the first request and cannot be resent — this throws `UnreplayableRedirectBodyError` rather than silently sending a request with no body or hanging. A `string`, `Buffer`/`TypedArray`, `Blob`, or `FormData` body has no such problem and is resent. A `Request` input's body is read once up front into an `ArrayBuffer` specifically so it survives a 307/308 replay (see Request input above).
- Relative `Location` values are resolved against the current URL.
- An https to http downgrade is treated the same as any other origin change: `URL.origin` includes the scheme, so the header-stripping rule applies automatically. There is no separate scheme check.
- Redirects beyond `maxRedirects` throw `TooManyRedirectsError`.
- A redirect status with no `Location` header, or a non-redirect status, ends the chain and returns that response.

### `res.url` and `res.redirected`

A `Response` object returned by `fetch` carries `url` and `redirected` as internal state that cannot be reassigned. When no redirect was followed, this package returns the original `Response` untouched — same object, same everything. When a redirect was followed, it wraps the same body stream and headers in a fresh `Response` and defines `url` (the final URL) and `redirected` (`true`) as own properties on that instance. Status, headers, and body bytes are otherwise identical to what the server actually sent.

### Errors

| Name | Description |
| --- | --- |
| `OpaqueRedirectError` | Thrown if the underlying `fetch` returns an opaque redirect (browser `fetch` semantics) instead of a real 3xx response. |
| `TooManyRedirectsError` | Thrown when a redirect chain exceeds `maxRedirects`. |
| `UnreplayableRedirectBodyError` | Thrown when a 307/308 needs to resend a `ReadableStream` body that was already consumed. |

## How it works

This package sends the request itself with `redirect: 'manual'`, reads the resulting `Location` header, and re-fetches. That only works because Node's `fetch` (undici) returns the real 3xx response — status, headers, `Location` — for `redirect: 'manual'`. Browser `fetch` returns an [opaque redirect response](https://developer.mozilla.org/en-US/docs/Web/API/Response/type) instead: `type: 'opaqueredirect'`, status `0`, no readable headers. There is nothing to resolve a `Location` from. If the underlying `fetch` passed in (via `createOriginScopedFetch({ fetch })`) ever returns an opaque redirect, this package throws `OpaqueRedirectError` rather than silently treating it as an ordinary empty response.

## Limitations

- It does not stop all credential leaks, only this one shape of it. It scopes caller-set request headers to the origin across redirects this package follows. That's the whole scope.
- Query-string credentials (`?api_key=...`) are part of the URL, not a header, and travel with the redirect target regardless — this package can't and doesn't touch them.
- URL userinfo (`https://user:pass@host/`) is likewise untouched.
- Request bodies on 307/308 are resent cross-origin unscrubbed, exactly as the Fetch spec requires (the method/body can't be dropped on 307/308 the way headers are). If the body carries a credential, a 307/308 redirect to another origin still sends it — and so do the headers describing that body (`content-type`, `content-encoding`, `content-language`), deliberately kept even cross-origin so the body isn't mislabeled on arrival. Only headers that don't describe the body get the origin-scoped treatment on 307/308.
- Cookies: Node's `fetch` has no cookie jar; this package doesn't add one or invent cookie semantics.
- Other HTTP clients: axios and got are not `fetch` and have their own redirect/header options — e.g. axios's `follow-redirects` transport has an opt-in `sensitiveHeaders` option. This package wraps `fetch` only; it was not verified against axios or got and makes no claim about their defaults.
- Non-Node runtimes: requires Node's `fetch` semantics for `redirect: 'manual'` (see How it works); browser `fetch` cannot be wrapped by this package.

## Compatibility

- Tested on Node 24.20.0 (`npm install`, `npx tsc --noEmit`, `npm test`, `npm run build`, `npm run test:dist` all run against this version in this repo).
- Node 20.6, 22, and 24 run in CI against the built `dist` smoke tests (the TypeScript test suite itself needs Node 24+ for type stripping, so it runs only on 24 in CI).

## Development

```sh
npm install
npx tsc --noEmit                # or: npm run typecheck
node --test "test/*.test.ts"    # full suite, needs node 24+ for type stripping
node examples/leak-demo.ts
npm run build && npm run test:dist   # what CI runs against node 20 and 22
```

## License

MIT — see [LICENSE](./LICENSE).
