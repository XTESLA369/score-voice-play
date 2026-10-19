#!/usr/bin/env node
/*
 * server.mjs — 零依赖静态服务器（本地预览用）
 *
 *   node server.mjs               # http://<lan-ip>:5173  （桌面浏览器可用；iPad 上麦克风会被禁）
 *   node server.mjs --https       # https://<lan-ip>:5174 （iPad 上需要，首次要信任自签证书）
 *   node server.mjs --port 8080
 *
 * 说明：iPad 上的 Safari 只在「安全上下文」里允许录音与 Service Worker（离线 / 添加到主屏），
 *      所以局域网调试要用 --https，或者把整个文件夹部署到任意静态托管（GitHub Pages /
 *      Cloudflare Pages / Vercel …）拿到真正的证书。
 */

import http from 'node:http';
import https from 'node:https';
import { createReadStream, existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const args = process.argv.slice(2);
const useHttps = args.includes('--https');
const portArg = args.indexOf('--port');
const PORT = portArg > -1 ? Number(args[portArg + 1]) : (useHttps ? 5174 : 5173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.webm': 'video/webm',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function lanIPs() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

function ensureCert() {
  const dir = join(ROOT, '.certs');
  const keyPath = join(dir, 'dev-key.pem');
  const certPath = join(dir, 'dev-cert.pem');
  if (existsSync(keyPath) && existsSync(certPath)) {
    return { key: readFile(keyPath), cert: readFile(certPath) };
  }
  mkdirSync(dir, { recursive: true });
  const sans = ['DNS:localhost', 'IP:127.0.0.1', ...lanIPs().map((ip) => `IP:${ip}`)].join(',');
  const altPath = join(dir, 'san.cnf');
  writeFileSync(altPath, `[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=ScoreVoicePlay Dev\n[v3]\nsubjectAltName=${sans}\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`);
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath, '-days', '825',
    '-config', altPath, '-extensions', 'v3',
  ], { stdio: 'ignore' });
  console.log('已生成自签证书： .certs/dev-cert.pem');
  return { key: readFile(keyPath), cert: readFile(certPath) };
}

function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const rel = normalize(decoded).replace(/^([/\\])+/, '');
  const full = resolve(ROOT, rel || 'index.html');
  if (!full.startsWith(ROOT + sep) && full !== ROOT) return null;
  return full;
}

async function handler(req, res) {
  const urlPath = req.url === '/' ? '/index.html' : req.url;
  let filePath = safePath(urlPath);
  if (!filePath) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  if (existsSync(filePath) && statSync(filePath).isDirectory()) {
    filePath = join(filePath, 'index.html');
  }
  if (!existsSync(filePath)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end(`404 ${urlPath}`);
    return;
  }

  const stat = statSync(filePath);
  const type = MIME[extname(filePath).toLowerCase()] || 'application/octet-stream';
  const headers = {
    'content-type': type,
    'cache-control': 'no-cache',
    'accept-ranges': 'bytes',
  };

  // Range（视频拖动进度需要）
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Number(m[2]) : stat.size - 1;
      if (start >= stat.size) {
        res.writeHead(416, { 'content-range': `bytes */${stat.size}` }).end();
        return;
      }
      res.writeHead(206, {
        ...headers,
        'content-range': `bytes ${start}-${end}/${stat.size}`,
        'content-length': end - start + 1,
      });
      createReadStream(filePath, { start, end }).pipe(res);
      return;
    }
  }

  res.writeHead(200, { ...headers, 'content-length': stat.size });
  if (req.method === 'HEAD') { res.end(); return; }
  createReadStream(filePath).pipe(res);
}

async function main() {
  const ips = lanIPs();
  let server;
  let scheme = 'http';
  if (useHttps) {
    const { key, cert } = await ensureCert();
    server = https.createServer({ key: await key, cert: await cert }, handler);
    scheme = 'https';
  } else {
    server = http.createServer(handler);
  }
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  谱声练习 · 本地预览\n`);
    console.log(`  本机:   ${scheme}://localhost:${PORT}`);
    for (const ip of ips) console.log(`  局域网: ${scheme}://${ip}:${PORT}   ← iPad 用这个地址`);
    if (!useHttps) {
      console.log('\n  提示: 局域网地址是 http，Safari 会禁止麦克风与 Service Worker。');
      console.log('        在 iPad 上调试请改用: node server.mjs --https');
    } else {
      console.log('\n  iPad 首次访问 HTTPS 会提示证书不受信任：');
      console.log('    Safari 里点「显示详细信息 → 访问此网站」，');
      console.log('    再到 设置 → 通用 → 关于本机 → 证书信任设置 里打开该证书的完全信任。');
    }
    console.log('');
  });
}

main();
