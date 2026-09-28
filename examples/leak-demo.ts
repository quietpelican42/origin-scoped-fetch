/**
 * Server A redirects to server B on a different origin (127.0.0.1 -> localhost,
 * different port). A request carries authorization, cookie and a custom
 * x-api-key header. This prints what server B actually receives, once with
 * native `fetch` and once with `originScopedFetch`.
 *
 *   node examples/leak-demo.ts
 */
import http from 'node:http';
import { originScopedFetch } from '../src/index.ts';

const serverB = http.createServer((req, res) => {
  res.end(
    JSON.stringify({
      authorization: req.headers.authorization ?? null,
      cookie: req.headers.cookie ?? null,
      'x-api-key': req.headers['x-api-key'] ?? null,
    }),
  );
});
await new Promise<void>((r) => serverB.listen(0, '127.0.0.1', r));
const baseB = `http://localhost:${(serverB.address() as { port: number }).port}`;

const serverA = http.createServer((_req, res) => {
  res.writeHead(302, { location: `${baseB}/` });
  res.end();
});
await new Promise<void>((r) => serverA.listen(0, '127.0.0.1', r));
const baseA = `http://127.0.0.1:${(serverA.address() as { port: number }).port}`;

const requestHeaders = {
  authorization: 'Bearer secret-token',
  cookie: 'session=abc123',
  'x-api-key': 'my-custom-api-key',
};

console.log(`\n  A: ${baseA}  --302-->  B: ${baseB}  (different origin: different host)\n`);
console.log('  headers sent: authorization, cookie, x-api-key\n');

const nativeResult = await (await fetch(baseA, { headers: requestHeaders })).json();
console.log('  native fetch  -> server B received:', nativeResult);

const scopedResult = await (await originScopedFetch(baseA, { headers: requestHeaders })).json();
console.log('  originScopedFetch -> server B received:', scopedResult);
console.log();

serverA.close();
serverB.close();
