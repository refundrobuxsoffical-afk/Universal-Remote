#!/usr/bin/env node
/* firetv-bridge.js — raw-TCP Fire TV protocol  <->  WebSocket
   Run on any always-on computer on the SAME Wi-Fi as the TV:
       node firetv-bridge.js 192.168.1.50
       node firetv-bridge.js 192.168.1.50 --port 8080
   Needs Node 18+. Zero dependencies. */
'use strict';
const net = require('net'), http = require('http'), crypto = require('crypto');

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d; };
const TV_IP  = argv.find(a => /^\d{1,3}(\.\d{1,3}){3}$/.test(a)) || process.env.FIRETV_IP || null;
const LISTEN = Number(flag('port', process.env.PORT || 8080));
const TV_PORT = 55443, DIAL_PORTS = [8008, 8009];

const frame = (op, p) => {
  const n = p.length; let h;
  if (n < 126) h = Buffer.from([0x80 | op, n]);
  else if (n < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(n, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([h, p]);
};

function dial(tvIp, name) {
  return new Promise((res, rej) => {
    const go = i => {
      if (i >= DIAL_PORTS.length) return rej(new Error('DIAL unreachable on TV'));
      const r = http.request({ host: tvIp, port: DIAL_PORTS[i], path: '/apps/' + encodeURIComponent(name),
        method: 'POST', timeout: 2500 }, s => { s.resume(); s.statusCode < 400 ? res() : go(i + 1); });
      r.on('error', () => go(i + 1)); r.on('timeout', () => { r.destroy(); go(i + 1); }); r.end();
    };
    go(0);
  });
}

const server = http.createServer((q, s) => {
  s.writeHead(200, { 'Content-Type': 'text/plain' });
  s.end(`firetv-bridge up. default TV: ${TV_IP || '(none — use /TV-IP)'}\n` +
        `browser URL: ws://<this-machine-ip>:${LISTEN}/${TV_IP || '<tv-ip>'}\n`);
});

server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) return sock.destroy();
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' +
    crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64') + '\r\n\r\n');

  const path = decodeURIComponent((req.url || '/').split('?')[0].replace(/^\/+/, ''));
  const tvIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(path) ? path : TV_IP;
  const say = t => { try { sock.write(frame(0x1, Buffer.from(t))); } catch (e) {} };
  if (!tvIp) { say('ERR no TV ip in URL'); return sock.end(); }

  let tv = null, closed = false, ping = null, buf = Buffer.alloc(0);
  const tvSend = o => { if (tv && !tv.destroyed) { const j = JSON.stringify(o); tv.write(Buffer.byteLength(j) + '\n' + j); } };

  tv = net.connect(TV_PORT, tvIp);
  tv.setNoDelay(true);
  tv.on('connect', () => {
    say('OK connected to ' + tvIp + ':' + TV_PORT);
    tvSend({ type: 'handshake', name: 'Venice Remote', deviceType: 'remote', version: '1.0', port: LISTEN });
    ping = setInterval(() => tvSend({ type: 'ping' }), 4000);
  });
  tv.on('data', d => say(d.toString('utf8')));
  tv.on('error', e => say('ERR tv: ' + e.message));
  tv.on('close', () => { clearInterval(ping); if (!closed) say('ERR tv closed'); });

  sock.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const op = buf[0] & 0x0f, masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (masked) { if (buf.length < off + 4) return; }
      if (buf.length < off + (masked ? 4 : 0) + len) return;
      let pay;
      if (masked) { const m = buf.slice(off, off + 4); off += 4; pay = buf.slice(off, off + len);
        for (let i = 0; i < pay.length; i++) pay[i] ^= m[i % 4]; }
      else pay = buf.slice(off, off + len);
      buf = buf.slice(off + len);
      if (op === 0x8) { sock.end(); return; }
      if (op === 0x9) { sock.write(frame(0xA, pay)); continue; }
      if (op !== 0x1 && op !== 0x2) continue;
      let msg; try { msg = JSON.parse(pay.toString()); } catch (e) { continue; }
      if (msg.type === 'app') dial(tvIp, msg.name).then(() => say('OK launched ' + msg.name)).catch(e => say('ERR ' + e.message));
      else tvSend(msg);
    }
  });
  sock.on('close', () => { closed = true; clearInterval(ping); tv && tv.destroy(); });
  sock.on('error', () => {});
});

server.listen(LISTEN, () => console.log(`firetv-bridge on ws://0.0.0.0:${LISTEN}/<tv-ip>  (default TV ${TV_IP || 'unset'})`));
