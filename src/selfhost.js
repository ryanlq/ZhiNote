/**
 * 枝记 自托管配置（selfhost 定制点）
 * ─────────────────────────────────────────────────────────────────
 * 官方版在用户未显式配置时，跨域代理 / 实时中继默认连作者运营的公共服务：
 *   https://proxy.zhinote.net  /  wss://relay.zhinote.net
 * 自托管用户在此填入自己的组件地址并重新构建（node publish.mjs），
 * 之后所有浏览器首次打开即默认使用你自己的端点，不再触达官方服务。
 *
 * 字段说明：
 *   webProxy:  自建跨域代理 Worker 地址，如 'https://zhinote-proxy.你的子域.workers.dev'
 *              '' = 维持官方默认
 *   relay:     自建实时中继地址，如 'wss://zhinote-relay.你的子域.workers.dev'
 *              '' = 维持官方默认；'off' = 默认关闭实时同步
 *   emojiHost: 自建 Noto emoji 图片代理（可选；官方 emoji.zhinote.net 失败会回退谷歌源）
 *
 * 用户仍可在 设置 → 同步 里按需覆盖（direct / 自定义地址 / 关闭），本文件只决定「默认值」。
 */
window.SELFHOST = {
  webProxy: 'https://zhinote-proxy.ryan-lq.workers.dev',
  relay: 'wss://zhinote-relay.ryan-lq.workers.dev',
  emojiHost: ''
};
if (window.SELFHOST.emojiHost) {
  // 接管 Noto emoji 图片源（晚于 index.html 内联的默认赋值执行，故能覆盖）
  window.__NOTO_EMO_HOST__ = window.SELFHOST.emojiHost;
}
