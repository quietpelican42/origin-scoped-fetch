# origin-scoped-fetch

`fetch` that stops your own `authorization`, `cookie`, and custom API-key headers
from following a redirect onto a different origin.

```
A: http://127.0.0.1:51429  --302-->  B: http://localhost:51428  (different origin: different host)

headers sent: authorization, cookie, x-api-key

native fetch       -> server B received: { authorization: null, cookie: null, 'x-api-key': 'my-custom-api-key' }
originScopedFetch  -> server B received: { authorization: null, cookie: null, 'x-api-key': null }
```

That's `node examples/leak-demo.ts`. Native `fetch` already drops `Authorization`
and `Cookie` across an origin change — that part of the Fetch spec is implemented.
It does **not** touch anything else you set. `x-api-key`, a bearer token in a
custom header, a signed-URL header, an internal auth scheme: all of it rides the
redirect straight to whatever origin the `Location` header points at.

## The problem

Per the [Fetch spec](https://fetch.spec.whatwg.org/#http-redirect-fetch), when a
redirect crosses an origin, the browser (and Node's `fetch`, which follows the
same algorithm) strips exactly three request headers: `Authorization`, `Cookie`,
and `Proxy-Authorization`. Any header *you* set — `x-api-key`, `x-auth-token`, a
custom `Authorization`-shaped scheme under a different name — is not on that
list and is forwarded verbatim.

This matters whenever the redirect target isn't fully trusted: webhook delivery
to a user-supplied URL, an internal proxy that fetches on a caller's behalf, a
link unfurler, a client for a third-party API you don't control the redirect
chain of. A single `302` from `api.example.com` to `attacker.example.com`
exfiltrates whatever header carries your credential, unless it happens to be
one of the three the spec covers.

The obvious defenses don't hold up:

- **"Just check `Authorization` and `Cookie` are stripped."** They are — by
  the runtime, already. That's not the gap. The gap is every other header.
- **Reading `res.redirected` and deciding after the fact.** By the time you can
  inspect that, `fetch` already made the second request with your headers
  attached. There's nothing left to prevent.
- **`redirect: 'manual'` alone.** This stops fetch from following the redirect
  for you, but now *you* have to resolve `Location`, decide whether to strip
  headers, and re-request — which is exactly what this package does, correctly,
  including the method/body degradation rules for 301/302/303/307/308.

## Node-only, and why

This package sends the request itself with `redirect: 'manual'`, reads the
resulting `Location` header, and re-fetches. That only works because Node's
`fetch` (undici) returns the *real* 3xx response — status, headers, `Location`
— for `redirect: 'manual'`. Browser `fetch` returns an
[opaque redirect response](https://developer.mozilla.org/en-US/docs/Web/API/Response/type)
instead: `type: 'opaqueredirect'`, status `0`, no readable headers. There is
nothing to resolve a `Location` from. If the underlying `fetch` you pass in
(via `createOriginScopedFetch({ fetch })`) ever returns an opaque redirect,
this package throws `OpaqueRedirectError` rather than silently treating it as
an ordinary empty response.

## Install

```sh
npm install origin-scoped-fetch
```

Node >= 20.6. No runtime dependencies.

## Use

```ts
import { originScopedFetch } from 'origin-scoped-fetch';

// Same signature as fetch. authorization/cookie/x-api-key survive same-origin
// redirects and get dropped the moment a redirect crosses an origin.
const res = await originScopedFetch('https://api.example.com/resource', {
  headers: { authorization: 'Bearer ...', 'x-api-key': '...' },
});
```

Need a non-default allowlist, redirect cap, or an underlying `fetch` (e.g. one
wrapped by another library)?

```ts
import { createOriginScopedFetch } from 'origin-scoped-fetch';

const scopedFetch = createOriginScopedFetch({
  allowCrossOriginHeaders: ['x-request-id'], // never authorization/cookie-shaped headers
  maxRedirects: 10,
});
```

## Options (`createOriginScopedFetch`)

| Option | Default | What it does |
| --- | --- | --- |
| `fetch` | global `fetch` | The underlying fetch to wrap. Must have Node fetch semantics (see above). |
| `allowCrossOriginHeaders` | `[]` | Extra header names (case-insensitive) to keep across an origin change, in addition to the built-in safe list. |
| `maxRedirects` | `20` | Redirect hops to follow before throwing `TooManyRedirectsError`, matching browser `fetch`'s default. |

The built-in cross-origin-safe list is `accept`, `accept-language`,
`content-language`, `user-agent` — headers with no credential value. Everything
else you set is dropped the moment the redirect chain's origin changes, unless
you added it to `allowCrossOriginHeaders`. This is intentionally stricter than
the Fetch spec's own three-header strip list: the point of this package is to
default-deny, not to special-case a few more known-bad names.

`method`, `headers`, `body`, `signal`, and the rest of `RequestInit` behave as
in `fetch`. `redirect: 'manual'` and `redirect: 'error'` are passed straight
through to the underlying `fetch` untouched — this package only intervenes
when it is the one following the redirect (the default, `redirect: 'follow'`
or unset).

### Redirect semantics

Followed faithfully to the Fetch spec, on top of Node's manual-redirect fetch:

- **301, 302 on POST** → method becomes `GET`, body and body-related headers
  (`content-type`, `content-length`, `content-encoding`) are dropped.
- **303** → method becomes `GET`, except when the original method was `HEAD`.
- **307, 308** → method and body are preserved unchanged. If the body is a
  `ReadableStream`, it was already consumed sending the first request and
  cannot be resent — this throws `UnreplayableRedirectBodyError` rather than
  silently sending a request with no body or hanging. A `string`, `Buffer`/
  `TypedArray`, `Blob`, or `FormData` body has no such problem and is resent.
- Relative `Location` values are resolved against the current URL.
- An https → http downgrade is treated the same as any other origin change:
  `URL.origin` includes the scheme, so the header-stripping rule applies
  automatically. There's no separate scheme check.
- Redirects beyond `maxRedirects` throw `TooManyRedirectsError`.
- A redirect status with no `Location` header, or a non-redirect status, ends
  the chain and returns that response.

### `res.url` and `res.redirected`

A `Response` object returned by `fetch` carries `url` and `redirected` as
internal state you cannot reassign. When no redirect was followed, this
package returns the original `Response` completely untouched — same object,
same everything. When a redirect *was* followed, it wraps the same body
stream and headers in a fresh `Response` and defines `url` (the final URL)
and `redirected` (`true`) as own properties on that instance. Status,
headers, and body bytes are otherwise identical to what the server actually
sent.

## What it does not do

- **It does not stop all credential leaks, only this one shape of it.** It
  scopes caller-set *request headers* to the origin across redirects *this
  package follows*. That's the whole scope.
- **Query-string credentials** (`?api_key=...`) are part of the URL, not a
  header, and travel with the redirect target regardless — this package
  can't and doesn't touch them.
- **URL userinfo** (`https://user:pass@host/`) is likewise untouched.
- **Request bodies on 307/308** are resent as-is, including to a
  cross-origin target, exactly as the Fetch spec requires (the method/body
  can't be dropped on 307/308 the way headers are). If your body carries a
  credential, a 307/308 redirect to another origin still sends it. Only
  *headers* get the origin-scoped treatment.
- **Cookies.** Node's `fetch` has no cookie jar; this package doesn't add
  one or invent cookie semantics.
- **Other HTTP clients.** axios and got are not `fetch` and have their own
  redirect/header options — e.g. axios's `follow-redirects` transport has an
  opt-in `sensitiveHeaders` option. This package wraps `fetch` only; it was
  not verified against axios or got and makes no claim about their defaults.
- **Non-Node runtimes.** Requires Node's `fetch` semantics for
  `redirect: 'manual'` (see "Node-only, and why" above); browser `fetch`
  cannot be wrapped by this package.

## Develop

Tests are TypeScript run directly by Node's test runner — no build, no install:

```sh
node --test "test/*.test.ts"    # full suite, needs node 24+ for type stripping
node examples/leak-demo.ts

npm run build && npm run test:dist   # what CI runs against node 20 and 22
```

## License

MIT
