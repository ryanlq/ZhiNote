/* isogit-http.js — isomorphic-git 的 fetch HTTP 客户端（浏览器端，零依赖）。
 * isomorphic-git 的 http 接口约定：
 *   request({ url, method, headers, body, onProgress }) →
 *     Promise<{ statusCode, statusMessage, headers:{[k]:string}, body: AsyncIterable<Uint8Array> }>
 * 实现要点：
 *  - 请求体可能是 string / Uint8Array / AsyncIterable（后者聚合成单块；git 智能协议包体不大，够用）
 *  - 响应体必须是 AsyncIterable<Uint8Array>：这里一次性读全（clone 深度限制 + 个人库体积小，无需流式渐进）
 *  - 与自建 Git 服务器（Caddy 已配 CORS）直连，无需任何代理
 */
(function () {
  'use strict';

  async function _concat(body, onProgress) {
    const chunks = [];
    let recv = 0;
    for await (const c of body) {
      chunks.push(c);
      recv += c.length;
      if (onProgress) { try { onProgress({ loaded: recv }); } catch (_) {} }
    }
    const out = new Uint8Array(recv);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  }

  window.gitHttp = {
    async request(opts) {
      const o = opts || {};
      let payload;
      if (o.body == null) payload = undefined;
      else if (typeof o.body === 'string') payload = o.body;
      else if (o.body instanceof Uint8Array) payload = o.body;
      else payload = await _concat(o.body, o.onProgress); // AsyncIterable
      const resp = await fetch(o.url, { method: o.method || 'GET', headers: o.headers || {}, body: payload });
      const outHeaders = {};
      resp.headers.forEach(function (v, k) { outHeaders[k.toLowerCase()] = v; });
      const bytes = new Uint8Array(await resp.arrayBuffer());
      async function* gen() { yield bytes; }
      return { statusCode: resp.status, statusMessage: resp.statusText, headers: outHeaders, body: gen() };
    },
  };
})();
