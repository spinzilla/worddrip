// 077 测试用：把发版产物（release.mjs build 写到 D:\tmp\es-release\<版本>）用本机静态服务器提供出来，
// 清单里的地址改成本机。tamper=true 时，下载的文件第 100 个字节被改一位（签名 / sha256 对不上，用来测「校验失败」）。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

export function serveRelease({ version, port = 8099, root = 'D:/tmp/es-release' } = {}) {
  const dir = path.join(root, version);
  const base = `http://127.0.0.1:${port}`;
  const state = { tamper: false, hits: [], missing: false };
  const latest = JSON.parse(fs.readFileSync(path.join(dir, 'latest.json'), 'utf8'));
  for (const p of Object.values(latest.platforms)) p.url = `${base}/files/${path.basename(p.url)}`;
  const android = JSON.parse(fs.readFileSync(path.join(dir, 'android.json'), 'utf8'));
  android.url = `${base}/files/${path.basename(android.url)}`;
  const server = http.createServer((req, res) => {
    state.hits.push(req.url);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (state.missing) { res.writeHead(404); return res.end('no'); }
    const json = o => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url.startsWith('/latest.json')) return json(latest);
    if (req.url.startsWith('/android.json')) return json(android);
    if (req.url.startsWith('/files/')) {
      const file = path.join(dir, path.basename(decodeURIComponent(req.url.slice(7))));
      if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
      const buf = fs.readFileSync(file);
      if (state.tamper) buf[100] ^= 1;
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length });
      // 分几块发，进度才会一段一段涨
      const step = Math.ceil(buf.length / 20);
      let at = 0;
      const tick = () => { if (at >= buf.length) return res.end(); res.write(buf.subarray(at, at += step)); setTimeout(tick, 60); };
      return tick();
    }
    res.writeHead(404); res.end();
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve({ base, state, close: () => server.close() })));
}
