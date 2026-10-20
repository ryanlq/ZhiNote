/**
 * 枝记 WebDAV/AI 跨域代理 — Cloudflare Worker（免费版即可，10 万请求/天）
 * 部署：在本目录执行 `wrangler deploy`，然后把得到的地址填进
 *      枝记「设置 → 同步 → 跨域代理」或 src/selfhost.js 的 webProxy 字段。
 * 工作方式：枝记请求 https://<本代理>/<完整目标URL>，Worker 原样转发并补 CORS 头。
 * 安全：仅转发 https 目标；不存储不记录；笔记本体是 AES 密文（设自定义口令后）。
 * 注意：Authorization 头（网盘账号密码）会经过本 Worker——请部署在自己的账号里。
 */
const ALLOW_METHODS = 'GET,HEAD,PUT,POST,DELETE,MKCOL,PROPFIND,MOVE,COPY,OPTIONS';
const PASS_HEADERS = ['authorization', 'content-type', 'depth', 'destination', 'overwrite', 'if-match', 'if-none-match'];

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }
    const url = new URL(request.url);
    const target = decodeURIComponent(url.pathname.slice(1)) + url.search;
    if (!/^https:\/\//i.test(target)) {
      return new Response('用法：https://<本代理>/<完整的 https 网盘地址>', {
        status: 400,
        headers: { ...corsHeaders(request), 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
    const headers = new Headers();
    for (const k of PASS_HEADERS) {
      const v = request.headers.get(k);
      if (v) headers.set(k, v);
    }
    // 部分网盘（如坚果云）会拒绝无 User-Agent / Accept 的数据中心请求（返回 520），补上浏览器头
    headers.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
    if (!headers.has('Accept')) headers.set('Accept', '*/*');
    let resp;
    try {
      resp = await fetch(target, {
        method: request.method,
        headers,
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      });
    } catch (e) {
      return new Response('代理转发失败：' + (e && e.message), { status: 502, headers: corsHeaders(request) });
    }
    const out = new Headers(resp.headers);
    const cors = corsHeaders(request);
    for (const k in cors) out.set(k, cors[k]);
    return new Response(resp.body, { status: resp.status, headers: out });
  },
};

function corsHeaders(request) {
  return {
    'Access-Control-Allow-Origin': request.headers.get('Origin') || '*',
    'Access-Control-Allow-Methods': ALLOW_METHODS,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Depth, Destination, Overwrite, If-Match, If-None-Match, Cache-Control, Pragma',
    'Access-Control-Expose-Headers': 'ETag, Content-Length, Content-Type, DAV, Last-Modified',
    'Access-Control-Max-Age': '86400',
  };
}
