// realtime-relay/worker.js 快照持久化协议单元测试（stub DO storage）
// 运行：node tests/relay-worker.test.mjs
import assert from 'node:assert';
const { Room } = await import('../realtime-relay/worker.js');

const T = { pass: 0, fail: 0 };
const ok = (c, n, x) => { if (c) { T.pass++; console.log('  ✓', n); } else { T.fail++; console.log('  ✗', n, x != null ? JSON.stringify(x).slice(0, 200) : ''); } };

function makeCtx() {
  const kv = new Map();
  return {
    kv,
    storage: {
      get: async (k) => (kv.has(k) ? kv.get(k) : undefined),
      put: async (k, v) => { kv.set(k, v); },
      delete: async (...ks) => { for (const k of ks) kv.delete(k); return null; },
      // 模拟真实 CF DO：list 返回 Promise<Map>（可 for..of 解构）
      list: async ({ prefix = '' } = {}) => { const m = new Map(); for (const [k, v] of kv) if (k.startsWith(prefix)) m.set(k, v); return m; },
    },
  };
}
const makeWS = () => { const ws = { sent: [], send(m) { this.sent.push(m); }, close() {} }; return ws; };
const parseSent = (ws, i = 0) => JSON.parse(ws.sent[i]);
const allSent = (ws, tag) => ws.sent.filter(s => { try { return JSON.parse(s).__zr === tag; } catch (_) { return false; } }).map(s => JSON.parse(s));

const ctx = makeCtx();
const room = new Room(ctx, {});

(async () => {
  console.log('中继 Worker 快照持久化协议');

  // 1) 写入 + 提交
  let ws = makeWS();
  await room._control(ws, { __zr: 'snap-w', seq: 's1', ts: 1000, total: 2, size: 10 });
  await room._control(ws, { __zr: 'snap-c', seq: 's1', i: 0, b64: 'AAA' });
  await room._control(ws, { __zr: 'snap-c', seq: 's1', i: 1, b64: 'BBB' });
  await room._control(ws, { __zr: 'snap-end', seq: 's1' });
  const m1 = JSON.parse(ctx.kv.get('snapm:s1'));
  ok(m1.done === 1 && m1.total === 2, '快照提交：清单标记完成', m1);
  ok(ctx.kv.get('snapp:s1:0') === 'AAA' && ctx.kv.get('snapp:s1:1') === 'BBB', '分块入库');

  // 2) 列表
  await room._control(ws, { __zr: 'snap-list-req' });
  const listMsg = allSent(ws, 'snap-list')[0];
  ok(listMsg && listMsg.list.length === 1 && listMsg.list[0].seq === 's1' && listMsg.list[0].done === 1, 'snap-list 返回清单', listMsg);

  // 3) 读取：逐块回传 + done
  await room._control(ws, { __zr: 'snap-get', seq: 's1' });
  const chunks = allSent(ws, 'snap-c');
  const dones = allSent(ws, 'snap-done');
  ok(chunks.length === 2 && chunks[0].b64 === 'AAA' && chunks[1].b64 === 'BBB', 'snap-get 逐块回传且有序');
  ok(dones.length === 1 && dones[0].seq === 's1' && dones[0].size === 10, 'snap-done 收尾');

  // 4) 控制消息不转发：webSocketMessage 收 snap 控制消息 → 不存 'latest'、不广播
  const ws2 = makeWS();
  room.ctx.getWebSockets = () => [ws, ws2];
  await room.webSocketMessage(ws, JSON.stringify({ __zr: 'snap-w', seq: 'sx', ts: 1, total: 1, size: 1 }));
  ok(!ctx.kv.has('latest'), 'snap 控制消息不污染 latest 快照');
  ok(ws2.sent.length === 0, 'snap 控制消息不转发给对端');

  // 5) 房间空了：临时 latest 删除，持久快照保留
  await room.webSocketMessage(ws, 'opaque-cipher-data');   // 存 'latest' + 转发
  ok(ctx.kv.has('latest'), '前置：latest 已存');
  room.ctx.getWebSockets = () => [ws];                     // 模拟 ws 关闭后房间里只剩它自己
  await room.webSocketClose(ws);
  ok(!ctx.kv.has('latest'), '房间空 → latest 删除（旧语义保持）');
  ok(ctx.kv.has('snapm:s1'), '房间空 → 持久快照保留（新语义）');

  // 6) 保留策略：写 s2..s7（共 7 份完成快照）→ 只保留最新 5 份
  for (let i = 2; i <= 7; i++) {
    const w2 = makeWS();
    await room._control(w2, { __zr: 'snap-w', seq: 's' + i, ts: 1000 + i, total: 1, size: 1 });
    await room._control(w2, { __zr: 'snap-c', seq: 's' + i, i: 0, b64: 'D' + i });
    await room._control(w2, { __zr: 'snap-end', seq: 's' + i });
  }
  const list = await room._listSnaps();
  const done = list.filter(s => s.done);
  ok(done.length === 5, '保留策略：只留最近 5 份', done.map(s => s.seq));
  const seqs = done.map(s => s.seq).sort();
  ok(seqs.join(',') === 's3,s4,s5,s6,s7', '保留的是最新的 5 份（s1/s2 被清理）', seqs);
  ok(!ctx.kv.has('snapp:s1:0') && !ctx.kv.has('snapp:s2:0'), '被清理快照的分块也删除');

  // 7) 读不存在的快照 → snap-err
  const ws3 = makeWS();
  await room._control(ws3, { __zr: 'snap-get', seq: 'nope' });
  const errs = allSent(ws3, 'snap-err');
  ok(errs.length === 1, '读不存在 → snap-err', errs);

  // 8) 读取未完成的快照 → snap-err
  const ws4 = makeWS();
  await room._control(ws4, { __zr: 'snap-w', seq: 'half', ts: 5000, total: 2, size: 2 });
  await room._control(ws4, { __zr: 'snap-get', seq: 'half' });
  ok(allSent(ws4, 'snap-err').length === 1, '未完成快照不可读');

  // 9) 删除指定快照
  const ws5 = makeWS();
  await room._control(ws5, { __zr: 'snap-del', seq: 's3' });
  const list2 = await room._listSnaps();
  ok(!list2.some(s => s.seq === 's3'), 'snap-del 删除指定快照');

  console.log('\n========== 结果：' + T.pass + ' 通过 / ' + T.fail + ' 失败 ==========');
  process.exit(T.fail ? 1 : 0);
})().catch((e) => { console.error('测试崩溃：', e); process.exit(2); });
