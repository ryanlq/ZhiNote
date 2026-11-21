// dropbox-transport.js 传输翻译器单元测试：mock fetch + 完整请求/响应断言
// 运行：node tests/dropbox-transport.test.mjs
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert';

const T = { pass: 0, fail: 0 };
function ok(cond, name, extra) {
  if (cond) { T.pass++; console.log('  ✓', name); }
  else { T.fail++; console.log('  ✗', name, extra != null ? ' → ' + JSON.stringify(extra).slice(0, 200) : ''); }
}

// ── mock Dropbox 存储 ──
const store = new Map();   // path_lower → { bytes, rev }
let revCounter = 100;
const calls = [];          // 抓取的 API 调用 { url, method, headers, body }
let tokenCalls = 0;
let tokenFail = false;

function metaOf(p) {
  const e = store.get(p.toLowerCase());
  if (!e) return null;
  return { '.tag': 'file', name: p.split('/').pop(), path_lower: p.toLowerCase(), rev: String(e.rev), size: e.bytes.length, server_modified: 'Thu, 20 Nov 2026 12:00:00 GMT' };
}

async function mockFetch(url, options = {}) {
  const method = options.method || 'GET';
  const rec = { url: String(url), method, headers: options.headers || {} };
  calls.push(rec);

  if (url.includes('oauth2/token')) {
    tokenCalls++;
    if (tokenFail) return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
    return new Response(JSON.stringify({
      access_token: 'AT' + tokenCalls, refresh_token: 'RT-X', expires_in: 14400, account_id: 'dbid:ACC1',
    }), { status: 200 });
  }

  const auth = (options.headers && options.headers.Authorization) || '';
  if (!auth.includes('Bearer AT')) return new Response(JSON.stringify({ error_summary: 'invalid_access_token' }), { status: 401 });

  if (url.includes('/files/upload')) {
    const arg = JSON.parse(options.headers['Dropbox-API-Arg']);
    const p = arg.path.toLowerCase();
    const body = options.body;
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(await new Response(body).arrayBuffer());
    const existing = store.get(p);
    if (arg.mode && arg.mode['.tag'] === 'update') {
      if (!existing || String(existing.rev) !== String(arg.mode.update)) {
        return new Response(JSON.stringify({ error_summary: 'path/conflict', error: { '.tag': 'path', path: { '.tag': 'conflict' } } }), { status: 409 });
      }
    }
    revCounter++;
    knownDirs.add(p.slice(0, p.lastIndexOf('/')) || '/');
    store.set(p, { bytes, rev: revCounter });
    return new Response(JSON.stringify({ '.tag': 'file', name: arg.path.split('/').pop(), path_lower: p, rev: String(revCounter), size: bytes.length, server_modified: 'Thu, 20 Nov 2026 12:00:00 GMT' }), { status: 200 });
  }

  if (url.includes('/files/download')) {
    const arg = JSON.parse(options.headers['Dropbox-API-Arg']);
    const m = metaOf(arg.path);
    if (!m) return new Response(JSON.stringify({ error_summary: 'path/not_found' }), { status: 409 });
    return new Response(store.get(m.path_lower).bytes, { status: 200 });
  }

  if (url.includes('/files/get_metadata')) {
    const j = JSON.parse(options.body || '{}');
    const m = metaOf(j.path);
    if (!m) return new Response(JSON.stringify({ error_summary: 'path/not_found' }), { status: 409 });
    return new Response(JSON.stringify(m), { status: 200 });
  }

  if (url.includes('/files/delete_v2')) {
    const j = JSON.parse(options.body || '{}');
    if (!store.has(j.path.toLowerCase())) return new Response(JSON.stringify({ error_summary: 'path/not_found' }), { status: 409 });
    store.delete(j.path.toLowerCase());
    return new Response(JSON.stringify({ metadata: {} }), { status: 200 });
  }

  if (url.includes('/files/list_folder')) {
    if (url.includes('longpoll_delta')) {
      const j = JSON.parse(options.body || '{}');
      if (!mockChanges.pending) return new Response(JSON.stringify({ changes: false }), { status: 200 });
      mockChanges.pending = false; mockChanges.serveOnce = true;
      return new Response(JSON.stringify({ changes: true, cursor: j.cursor + '-lp' }), { status: 200 });
    }
    if (url.includes('get_latest_cursor')) return new Response(JSON.stringify({ cursor: 'c-' + Date.now() }), { status: 200 });
    if (url.includes('continue')) {
      if (mockChanges.serveOnce) {
        mockChanges.serveOnce = false;
        const m = metaOf('/zhinote/notes/b.ybin');
        return new Response(JSON.stringify({ entries: m ? [m] : [], cursor: 'c-end', has_more: false }), { status: 200 });
      }
      return new Response(JSON.stringify({ entries: [], cursor: 'c-end', has_more: false }), { status: 200 });
    }
    const j = JSON.parse(options.body || '{}');
    const dir = ((j.path || '/').toLowerCase().replace(/\/+$/, '')) || '/';
    if (!knownDirs.has(dir)) return new Response(JSON.stringify({ error_summary: 'path/not_found' }), { status: 409 });
    const entries = [];
    for (const [p, e] of store) {
      const parent = p.slice(0, p.lastIndexOf('/')) || '/';
      if (parent === dir) entries.push(metaOf(p));
    }
    return new Response(JSON.stringify({ entries, cursor: 'c1', has_more: false }), { status: 200 });
  }

  return new Response('unexpected ' + url, { status: 500 });
}

const mockChanges = { pending: false };
const knownDirs = new Set(['/', '/zhinote', '/zhinote/notes', '/zhinote/images', '/zhinote/trash']);

// 极简 DOMParser（Node 无 DOM）：正则建元素树，满足 _parsePropfind 的 getElementsByTagName('*') 用法
class MiniElem {
  constructor(tag) { this.tag = tag.toLowerCase(); this.localName = tag.includes(':') ? tag.split(':').pop().toLowerCase() : this.tag; this.children = []; this.textContent = ''; }
  getElementsByTagName(name) {
    const out = [];
    const want = name === '*' ? null : name.toLowerCase();
    const walk = (el) => { for (const c of el.children) { if (!want || c.localName === want) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
}
class MiniDoc extends MiniElem {
  constructor(xml) {
    super('#document');
    const stack = [this];
    const re = /<\/?([a-zA-Z][\w:.-]*)(("[^"]*"|'[^']*')|[^>])*?(\/?)>|([^<]+)/g;
    let mm;
    while ((mm = re.exec(xml))) {
      if (mm[5] !== undefined) { const top = stack[stack.length - 1]; top.textContent += mm[5].trim(); continue; }
      if (mm[4] === '/') continue;                          // 自闭合
      if (mm[0][1] === '/') { if (stack.length > 1) stack.pop(); continue; }
      const el = new MiniElem(mm[1]);
      stack[stack.length - 1].children.push(el);
      if (mm[4] !== '/') stack.push(el);
    }
  }
}
globalThis.DOMParser = globalThis.DOMParser || class { parseFromString(xml) { return new MiniDoc(xml); } };

// ── 环境搭建 ──
const ssMap = new Map();
const lsMap = new Map();
const sandbox = {
  window: {
    storage: {
      getSetting(k) {
        if (k === 'dropbox_appKey') return 'TESTAPPKEY';
        if (k === 'webdavProxy') return '';   // 直连（便于断言 URL）
        return undefined;
      },
      getAll() { return { notes: {} }; },
    },
    dropboxTransport: undefined,
  },
  localStorage: {
    getItem: (k) => lsMap.get(k) ?? null,
    setItem: (k, v) => lsMap.set(k, v),
    removeItem: (k) => lsMap.delete(k),
  },
  sessionStorage: { getItem: (k) => ssMap.get(k) ?? null, setItem: (k, v) => ssMap.set(k, v), removeItem: (k) => ssMap.delete(k) },
  fetch: mockFetch,
  crypto: globalThis.crypto,
  btoa: globalThis.btoa, atob: globalThis.atob,
  TextEncoder: globalThis.TextEncoder, TextDecoder: globalThis.TextDecoder,
  Response: globalThis.Response, URL: globalThis.URL, URLSearchParams: globalThis.URLSearchParams,
  navigator: { onLine: true },
  CustomEvent: globalThis.CustomEvent, Event: globalThis.Event,
  dispatchEvent: () => true, addEventListener: () => {},
  setTimeout, clearTimeout, console, Date, Math, JSON, Promise, Error,
};
sandbox.window.addEventListener = () => {};
sandbox.window.dispatchEvent = sandbox.dispatchEvent;
sandbox.self = sandbox.window;
vm.createContext(sandbox);
const code = fs.readFileSync(new URL('../src/dropbox-transport.js', import.meta.url), 'utf8');
vm.runInContext(code, sandbox, { filename: 'dropbox-transport.js' });
const dbx = sandbox.window.dropboxTransport;
ok(!!dbx, 'dropboxTransport 已暴露');

// 从 webdav-sync.js 抽取 _parsePropfind（验证 XML 兼容性）
const wsrc = fs.readFileSync(new URL('../src/webdav-sync.js', import.meta.url), 'utf8');
const m = /  function _parsePropfind\(xml\) \{[\s\S]*?\n  \}/.exec(wsrc);
ok(!!m, '抽到 webdav-sync 的 PROPFIND 解析器');
const parsePropfind = new Function('DOMParser', 'return function (xml) { ' + m[0].replace('  function _parsePropfind(xml) {', '').replace(/\n  \}$/, '') + ' }')(globalThis.DOMParser);

const H = (p) => 'https://dbx.virt/ZhiNote/' + p.replace(/^\/+/, '');

(async () => {
  console.log('\n测试组 0：PKCE 授权换 token');
  // authorize() 需要 window.open，这里直接注入 verifier 模拟授权回调成功后的兑换
  ssMap.set('zhinote-dbx-verifier', 'test-verifier-123');
  const auth = await dbx.exchangeCode('CODE123');
  ok(auth.access_token === 'AT1' && auth.refresh_token === 'RT-X', 'code → token 兑换成功', auth);
  ok(tokenCalls === 1, 'token 端点调用一次', tokenCalls);

  console.log('\n测试组 1：PUT / CAS 语义');
  // 无 If-Match → overwrite
  let r = await dbx.webdavBridge(H('manifest.json'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"version":1}' });
  ok(r.status === 200, 'PUT(无 If-Match) → 200');
  const j1 = await r.json();
  ok(!!j1.rev, 'PUT 响应含 rev');
  ok(r.headers.get('ETag') === '"' + j1.rev + '"', 'PUT 响应带 ETag（rev）');
  ok(store.has('/zhinote/manifest.json'), '文件入库');
  ok([...calls].pop().url === 'https://content.dropboxapi.com/2/files/upload', 'PUT 走 content/files/upload');
  const arg1 = JSON.parse([...calls].pop().headers['Dropbox-API-Arg']);
  ok(arg1.mode['.tag'] === 'overwrite', '无 If-Match → overwrite 模式');

  // 有 If-Match 且 rev 匹配 → 成功
  r = await dbx.webdavBridge(H('manifest.json'), { method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': '"' + j1.rev + '"' }, body: '{"version":2}' });
  ok(r.status === 200, 'If-Match 命中 → 200');
  const j2 = await r.json();

  // 有 If-Match 但 rev 过期 → 412（webdav-sync 据此重合并）
  r = await dbx.webdavBridge(H('manifest.json'), { method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': '"' + j1.rev + '"' }, body: '{"version":3}' });
  ok(r.status === 412, 'If-Match 过期 → 412（并发冲突语义无缝）');

  console.log('\n测试组 2：GET / ETag');
  r = await dbx.webdavBridge(H('manifest.json'), { method: 'GET' });
  ok(r.status === 200, 'GET → 200');
  const body = await r.text();
  ok(body === '{"version":2}', 'GET 内容正确', body);
  ok(r.headers.get('ETag') === '"' + j2.rev + '"', 'GET 响应带 ETag = 当前 rev（CAS 读基准）');
  r = await dbx.webdavBridge(H('notes/不存在.ybin'), { method: 'GET' });
  ok(r.status === 404, 'GET 不存在 → 404');

  console.log('\n测试组 3：PROPFIND XML 兼容性');
  await dbx.webdavBridge(H('notes/a.ybin'), { method: 'PUT', body: 'A' });
  await dbx.webdavBridge(H('notes/b.ybin'), { method: 'PUT', body: 'BB' });
  r = await dbx.webdavBridge(H('notes'), { method: 'PROPFIND', headers: { Depth: '1' } });
  ok(r.status === 207, 'PROPFIND depth1 → 207');
  const xml = await r.text();
  const entries = parsePropfind(xml).filter(e => !/\/$/.test(e.href));   // 消费者跳过目录（尾部 /）
  ok(Array.isArray(entries) && entries.length === 2, 'webdav-sync 自带解析器解析成功（目录被跳过）', entries);
  const names = entries.map(e => decodeURIComponent(e.href).split('/').pop()).sort();
  ok(names.join(',') === 'a.ybin,b.ybin', 'href 可按文件名提取（与现有消费者兼容）', names);
  const sizes = entries.map(e => e.size).sort((x, y) => x - y);
  ok(sizes.join(',') === '1,2', 'size 字段正确', sizes);
  // depth 0（对单个文件）
  r = await dbx.webdavBridge(H('notes/a.ybin'), { method: 'PROPFIND', headers: { Depth: '0' } });
  ok(r.status === 207, 'PROPFIND depth0（文件）→ 207');
  // 目录不存在
  r = await dbx.webdavBridge(H('no-such-dir'), { method: 'PROPFIND', headers: { Depth: '1' } });
  ok(r.status === 404, '目录不存在 → 404');

  console.log('\n测试组 4：DELETE / MKCOL');
  r = await dbx.webdavBridge(H('notes/a.ybin'), { method: 'DELETE' });
  ok(r.status === 204, 'DELETE → 204');
  ok(!store.has('/zhinote/notes/a.ybin'), '远端真的删了');
  r = await dbx.webdavBridge(H('notes/a.ybin'), { method: 'DELETE' });
  ok(r.status === 204, '删除不存在 → 204（幂等）');
  r = await dbx.webdavBridge(H('newdir'), { method: 'MKCOL' });
  ok(r.status === 201, 'MKCOL → 201（Dropbox 自动建目录）');

  console.log('\n测试组 5：token 流程');
  ok(tokenCalls >= 1, 'token 已就绪（授权兑换）', tokenCalls);
  const lsAuth = JSON.parse(lsMap.get('zhinote-dropbox-auth'));
  ok(lsAuth.refresh_token === 'RT-X' && lsAuth.access_token.startsWith('AT'), 'refresh_token/access_token 持久化');

  console.log('\n测试组 6：二进制（图片）');
  const bin = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
  r = await dbx.webdavBridge(H('images/abc123'), { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: bin });
  ok(r.status === 200, '二进制 PUT → 200');
  r = await dbx.webdavBridge(H('images/abc123'), { method: 'GET' });
  const got = new Uint8Array(await r.arrayBuffer());
  ok(got.every((b, i) => b === bin[i]), '二进制 GET 逐字节一致');

  console.log('\n测试组 7：longpoll 触发 onChange');
  let notified = 0;
  dbx.configure({ onChange: () => { notified++; } });
  mockChanges.pending = true;
  dbx.startDeltaLoop();
  await new Promise(res => setTimeout(res, 1200));
  dbx.stopDeltaLoop();
  const lpCalls = calls.filter(c => c.url.includes('longpoll_delta')).length;
  const contCalls = calls.filter(c => c.url.includes('list_folder/continue')).length;
  console.log('  探针：longpoll 调用', lpCalls, '次；continue', contCalls, '次；serveOnce 剩 =', mockChanges.serveOnce);
  ok(notified >= 1, '远端变更触发 onChange', notified);

  console.log('\n========== 结果：' + T.pass + ' 通过 / ' + T.fail + ' 失败 ==========');
  process.exit(T.fail ? 1 : 0);
})().catch((e) => { console.error('测试崩溃：', e); process.exit(2); });
