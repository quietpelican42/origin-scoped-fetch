/**
 * Plain-JS checks against the built package, so they run on every Node version
 * in `engines` — the TypeScript suite needs type stripping and only runs on 24+.
 *
 *   npm run build && node --test test/smoke.mjs
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import test, { after, before } from 'node:test';

const { originScopedFetch, createOriginScopedFetch, TooManyRedirectsError } = await import(
  '../dist/index.js'
);

let serverA;
let serverB;
let baseA;
let baseB;
let handlerA = (_req, res) => res.end('a');
let handlerB = (_req, res) => res.end('b');

before(async () => {
  serverA = http.createServer((req, res) => handlerA(req, res));
  await new Promise((r) => serverA.listen(0, '127.0.0.1', r));
  baseA = `http://127.0.0.1:${serverA.address().port}`;

  serverB = http.createServer((req, res) => handlerB(req, res));
  await new Promise((r) => serverB.listen(0, '127.0.0.1', r));
  baseB = `http://localhost:${serverB.address().port}`;
});
after(() => {
  serverA.close();
  serverB.close();
});

test('a clean, non-redirected response is returned untouched', async () => {
  handlerA = (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  };
  const res = await originScopedFetch(baseA);
  assert.equal(res.redirected, false);
  assert.deepEqual(await res.json(), { ok: true });
});

test('strips authorization across an origin-crossing redirect', async () => {
  let seenAuth = 'unset';
  handlerB = (req, res) => {
    seenAuth = req.headers.authorization;
    res.end('landed');
  };
  handlerA = (_req, res) => {
    res.writeHead(302, { location: `${baseB}/` });
    res.end();
  };

  const res = await originScopedFetch(baseA, { headers: { authorization: 'Bearer secret' } });
  await res.text();
  assert.equal(seenAuth, undefined);
});

test('keeps headers across a same-origin redirect', async () => {
  handlerA = (req, res) => {
    if (new URL(req.url, baseA).pathname === '/start') {
      res.writeHead(302, { location: '/landed' });
      return res.end();
    }
    res.end(req.headers.authorization ?? 'missing');
  };
  const res = await originScopedFetch(`${baseA}/start`, {
    headers: { authorization: 'Bearer secret' },
  });
  assert.equal(await res.text(), 'Bearer secret');
});

test('maxRedirects is enforced', async () => {
  handlerA = (req, res) => {
    res.writeHead(302, { location: '/' });
    res.end();
  };
  const capped = createOriginScopedFetch({ maxRedirects: 2 });
  await assert.rejects(capped(baseA), TooManyRedirectsError);
});

test("redirect: 'manual' returns the raw redirect without following it", async () => {
  handlerA = (_req, res) => {
    res.writeHead(302, { location: `${baseB}/` });
    res.end();
  };
  const res = await originScopedFetch(baseA, { redirect: 'manual' });
  assert.equal(res.status, 302);
});
