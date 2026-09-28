import assert from 'node:assert/strict';
import http from 'node:http';
import { test, before, after, describe } from 'node:test';

import {
  originScopedFetch,
  createOriginScopedFetch,
  TooManyRedirectsError,
  UnreplayableRedirectBodyError,
  OpaqueRedirectError,
} from '../src/index.ts';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

/** One server bound to 127.0.0.1, one bound to ::1/localhost — two distinct origins. */
let serverA: http.Server;
let serverB: http.Server;
let baseA: string; // http://127.0.0.1:<port>
let baseB: string; // http://localhost:<port>
let handlerA: Handler = (_req, res) => res.end('a');
let handlerB: Handler = (_req, res) => res.end('b');

before(async () => {
  serverA = http.createServer((req, res) => handlerA(req, res));
  await new Promise<void>((r) => serverA.listen(0, '127.0.0.1', r));
  baseA = `http://127.0.0.1:${(serverA.address() as { port: number }).port}`;

  serverB = http.createServer((req, res) => handlerB(req, res));
  await new Promise<void>((r) => serverB.listen(0, '127.0.0.1', r));
  baseB = `http://localhost:${(serverB.address() as { port: number }).port}`;
});

after(() => {
  serverA.close();
  serverB.close();
});

function serveA(fn: Handler) {
  handlerA = fn;
}
function serveB(fn: Handler) {
  handlerB = fn;
}

describe('no redirect', () => {
  test('a clean response is returned untouched: headers, status, body all as sent', async () => {
    serveA((req, res) => {
      res.writeHead(201, { 'content-type': 'text/plain', 'x-trace': 'abc' });
      res.end('hello');
    });

    const res = await originScopedFetch(baseA, { headers: { authorization: 'Bearer secret' } });
    assert.equal(res.status, 201);
    assert.equal(res.headers.get('x-trace'), 'abc');
    assert.equal(res.redirected, false);
    assert.equal(res.url, `${baseA}/`);
    assert.equal(await res.text(), 'hello');
  });
});

describe('cross-origin header stripping', () => {
  test('drops authorization, cookie and an arbitrary custom header on an origin change', async () => {
    const seenB: http.IncomingHttpHeaders[] = [];
    serveB((req, res) => {
      seenB.push(req.headers);
      res.end('landed');
    });
    serveA((req, res) => {
      res.writeHead(302, { location: `${baseB}/` });
      res.end();
    });

    const res = await originScopedFetch(baseA, {
      headers: {
        authorization: 'Bearer secret',
        cookie: 'session=abc',
        'x-api-key': 'topsecret',
      },
    });
    await res.text();

    assert.equal(seenB.length, 1);
    assert.equal(seenB[0]!.authorization, undefined);
    assert.equal(seenB[0]!.cookie, undefined);
    assert.equal(seenB[0]!['x-api-key'], undefined);
  });

  test('keeps the small safe allowlist (accept, user-agent, ...) across an origin change', async () => {
    const seenB: http.IncomingHttpHeaders[] = [];
    serveB((req, res) => {
      seenB.push(req.headers);
      res.end('landed');
    });
    serveA((req, res) => {
      res.writeHead(302, { location: `${baseB}/` });
      res.end();
    });

    await (
      await originScopedFetch(baseA, {
        headers: { accept: 'application/json', 'user-agent': 'test-agent/1.0' },
      })
    ).text();

    assert.equal(seenB[0]!.accept, 'application/json');
    assert.equal(seenB[0]!['user-agent'], 'test-agent/1.0');
  });
});

describe('same-origin redirects', () => {
  test('keeps all caller headers when the redirect stays on the same origin', async () => {
    const seen: http.IncomingHttpHeaders[] = [];
    serveA((req, res) => {
      seen.push(req.headers);
      if (new URL(req.url!, baseA).pathname === '/start') {
        res.writeHead(302, { location: '/landed' });
        return res.end();
      }
      res.end('ok');
    });

    await (
      await originScopedFetch(`${baseA}/start`, {
        headers: { authorization: 'Bearer secret', 'x-custom': 'keep-me' },
      })
    ).text();

    assert.equal(seen.length, 2);
    assert.equal(seen[1]!.authorization, 'Bearer secret');
    assert.equal(seen[1]!['x-custom'], 'keep-me');
  });
});

describe('allowCrossOriginHeaders', () => {
  test('a header explicitly allowlisted survives an origin change', async () => {
    const seenB: http.IncomingHttpHeaders[] = [];
    serveB((req, res) => {
      seenB.push(req.headers);
      res.end('landed');
    });
    serveA((req, res) => {
      res.writeHead(302, { location: `${baseB}/` });
      res.end();
    });

    const fetchWithAllowlist = createOriginScopedFetch({ allowCrossOriginHeaders: ['x-api-key'] });
    await (
      await fetchWithAllowlist(baseA, {
        headers: { authorization: 'Bearer secret', 'x-api-key': 'allowed-across-origins' },
      })
    ).text();

    assert.equal(seenB[0]!.authorization, undefined);
    assert.equal(seenB[0]!['x-api-key'], 'allowed-across-origins');
  });
});

describe('redirect chains', () => {
  test('A -> B -> A: a header dropped leaving A does not reappear on returning to A', async () => {
    const seenA: http.IncomingHttpHeaders[] = [];
    const seenB: http.IncomingHttpHeaders[] = [];
    let aHits = 0;

    serveA((req, res) => {
      seenA.push(req.headers);
      aHits++;
      if (aHits === 1) {
        res.writeHead(302, { location: `${baseB}/` });
        return res.end();
      }
      res.end('back home');
    });
    serveB((req, res) => {
      seenB.push(req.headers);
      res.writeHead(302, { location: `${baseA}/` });
      res.end();
    });

    const res = await originScopedFetch(baseA, { headers: { authorization: 'Bearer secret' } });
    const text = await res.text();

    assert.equal(text, 'back home');
    assert.equal(seenA[0]!.authorization, 'Bearer secret'); // first hit: same-origin start, header present
    assert.equal(seenB[0]!.authorization, undefined); // crossed into B: dropped
    assert.equal(seenA[1]!.authorization, undefined); // crossed back into A: stays dropped
    assert.equal(res.redirected, true);
    assert.equal(res.url, `${baseA}/`);
  });
});

describe('redirect-spec method and body handling', () => {
  test('303 degrades POST to a bodyless GET', async () => {
    let landedMethod = '';
    let landedBody = '';
    serveA((req, res) => {
      if (new URL(req.url!, baseA).pathname === '/start') {
        res.writeHead(303, { location: '/landed' });
        return res.end();
      }
      landedMethod = req.method!;
      req.on('data', (c) => (landedBody += c));
      req.on('end', () => res.end('ok'));
    });

    await (
      await originScopedFetch(`${baseA}/start`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'original body',
      })
    ).text();

    assert.equal(landedMethod, 'GET');
    assert.equal(landedBody, '');
  });

  test('307 preserves method and a Buffer body across the redirect', async () => {
    let landedMethod = '';
    let landedBody = '';
    serveA((req, res) => {
      if (new URL(req.url!, baseA).pathname === '/start') {
        res.writeHead(307, { location: '/landed' });
        return res.end();
      }
      landedMethod = req.method!;
      req.on('data', (c) => (landedBody += c));
      req.on('end', () => res.end('ok'));
    });

    const res = await originScopedFetch(`${baseA}/start`, {
      method: 'POST',
      body: Buffer.from('buffer body', 'utf8'),
    });
    await res.text();

    assert.equal(landedMethod, 'POST');
    assert.equal(landedBody, 'buffer body');
  });

  test('a ReadableStream body cannot survive a 307 and throws a clear error', async () => {
    serveA((req, res) => {
      res.writeHead(307, { location: '/landed' });
      res.end();
    });

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('streamed'));
        controller.close();
      },
    });

    await assert.rejects(
      originScopedFetch(baseA, { method: 'POST', body: stream, duplex: 'half' } as RequestInit),
      UnreplayableRedirectBodyError,
    );
  });
});

describe('maxRedirects', () => {
  test('exceeding it throws, staying under it succeeds', async () => {
    serveA((req, res) => {
      const n = Number(new URL(req.url!, baseA).searchParams.get('n') ?? '0');
      if (n >= 10) return res.end('done');
      res.writeHead(302, { location: `/?n=${n + 1}` });
      res.end();
    });

    const capped = createOriginScopedFetch({ maxRedirects: 3 });
    await assert.rejects(capped(baseA), TooManyRedirectsError);

    const uncapped = createOriginScopedFetch({ maxRedirects: 20 });
    assert.equal(await (await uncapped(baseA)).text(), 'done');
  });
});

describe('relative Location', () => {
  test('a relative Location resolves against the current URL', async () => {
    serveA((req, res) => {
      const url = new URL(req.url!, baseA);
      if (url.pathname === '/a') {
        res.writeHead(302, { location: 'b' }); // relative to /a -> /b
        return res.end();
      }
      if (url.pathname === '/b') {
        res.writeHead(302, { location: './c' }); // relative to /b -> /c
        return res.end();
      }
      res.end(`landed at ${url.pathname}`);
    });

    const res = await originScopedFetch(`${baseA}/a`);
    assert.equal(await res.text(), 'landed at /c');
    assert.equal(res.url, `${baseA}/c`);
  });
});

describe('redirect: manual / error pass-through', () => {
  test("redirect: 'manual' returns the raw 3xx untouched, without following it", async () => {
    serveA((_req, res) => {
      res.writeHead(302, { location: `${baseB}/` });
      res.end();
    });

    const res = await originScopedFetch(baseA, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), `${baseB}/`);
  });

  test("redirect: 'error' throws instead of following", async () => {
    serveA((_req, res) => {
      res.writeHead(302, { location: `${baseB}/` });
      res.end();
    });

    await assert.rejects(originScopedFetch(baseA, { redirect: 'error' }));
  });
});

describe('opaque redirect detection', () => {
  test('a browser-like opaqueredirect response is rejected with a clear error', async () => {
    const browserLikeFetch = (async () =>
      ({ type: 'opaqueredirect', status: 0, headers: new Headers() }) as unknown as Response) as typeof fetch;

    const fetchWithFakeUnderlying = createOriginScopedFetch({ fetch: browserLikeFetch });
    await assert.rejects(fetchWithFakeUnderlying(baseA), OpaqueRedirectError);
  });
});
