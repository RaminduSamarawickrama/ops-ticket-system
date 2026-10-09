// Local API server for development. Vite (port 5173) proxies /api to this process.
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { getHandler } from '../server/production.js';

const port = Number(process.env.API_PORT ?? 3001);

createServer(async (req, res) => {
  const url = `http://${req.headers.host ?? `localhost:${port}`}${req.url ?? '/'}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    else if (v !== undefined) headers.set(k, v);
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const request = new Request(url, {
    method: req.method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
    duplex: 'half',
  } as RequestInit);

  const response = await getHandler()(request);
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    if (key === 'set-cookie') res.appendHeader('set-cookie', value);
    else res.setHeader(key, value);
  });
  if (response.body) Readable.fromWeb(response.body as never).pipe(res);
  else res.end();
}).listen(port, '127.0.0.1', () => {
  console.log(`API listening on http://127.0.0.1:${port}`);
});
