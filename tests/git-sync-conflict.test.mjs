// git-sync.js 冲突处理回归测试（模拟真双端：两个真实 git 仓库目录，对象拷贝 = fetch/push）
// 运行：node tests/git-sync-conflict.test.mjs   全绿 = 冲突决议/自动合并/删除保护/去重/FF下载 全部正常
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

globalThis.self = globalThis;
const gitReal = (await import('../src/isogit.umd.min.js')).default;

const T = { pass: 0, fail: 0, logs: [] };
function ok(cond, name, extra) {
  if (cond) { T.pass++; console.log('  ✓', name); }
  else { T.fail++; console.log('  ✗', name, extra != null ? ' → ' + JSON.stringify(extra).slice(0, 300) : ''); }
}

// ---------- 环境 stub ----------
function makeEnv(root) {
  const storageData = {
    notes: {}, trash: {}, workspaces: [{ id: 'w1', name: 'W1' }], templates: [],
    settings: { gitUrl: 'https://git.example.com/zhi.git', gitUser: 'u', gitPass: 'p', gitBranch: 'main', syncMethod: 'git' },
    noteTombstones: {}, wsTombstones: {}, tplTombstones: {},
  };
  const toasts = [];
  const events = [];
  const win = {
    storage: {
      getSetting(k) { return storageData.settings[k]; },
      getAll() { return storageData; },
      isNoteDeleted(id) { return !!(storageData.trash[id] || storageData.noteTombstones[id]); },
      purgeFromTrash(id) { delete storageData.trash[id]; },
      restoreFromTrash(id) { const n = storageData.trash[id]; if (n) { delete storageData.trash[id]; storageData.notes[id] = n; } },
      _webdavRemoveNote(id) { const n = storageData.notes[id]; if (n) { delete storageData.notes[id]; storageData.trash[id] = Object.assign({}, n, { deletedAt: new Date().toISOString() }); } },
      _webdavApplyNote(id, noteData, opts) { storageData.notes[id] = noteData; },
      _webdavStoreImage() {},
      getImageMap() { return {}; },
      getLocalImage() { return null; },
      _gitApplyGlobal(g) {
        if (!g) return;
        if (g.workspaces) storageData.workspaces = g.workspaces;
        if (g.wsDeleted) storageData.wsTombstones = Object.assign({}, storageData.wsTombstones, g.wsDeleted);
        if (g.tplDeleted) storageData.tplTombstones = Object.assign({}, storageData.tplTombstones, g.tplDeleted);
        if (g.settings) Object.assign(storageData.settings, g.settings);
      },
      _emitCloudSync(o) { events.push(o); },
      markNotesDirtyByIds() {},
      markDirty() {},
      updateDoc(id, doc) { if (storageData.notes[id]) { storageData.notes[id].doc = doc; storageData.notes[id].content = doc.__md; } },
    },
    editor: {
      serializeDocToMd(doc) { return doc && doc.__md != null ? doc.__md : String((doc && doc.body) || ''); },
      parseMdToDoc(body) { return { __md: String(body == null ? '' : body) }; },
      walkDocImages() {},
    },
    LightningFS: class {
      constructor() {
        const r = root;
        const P = (x) => path.join(r, x);
        this.promises = {
          readFile: async (x, enc) => { try { return await fs.readFile(P(x), enc); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } },
          writeFile: (x, d) => fs.writeFile(P(x), d),
          mkdir: (x) => fs.mkdir(P(x)),
          rmdir: (x) => fs.rmdir(P(x)),
          unlink: (x) => fs.unlink(P(x)),
          stat: (x) => fs.stat(P(x)),
          lstat: (x) => fs.lstat(P(x)),
          readdir: (x) => fs.readdir(P(x)),
          readlink: async () => { const e = new Error('ENOSYS'); e.code = 'ENOSYS'; throw e; },
          symlink: async () => { const e = new Error('ENOSYS'); e.code = 'ENOSYS'; throw e; },
        };
      }
    },
    gitHttp: {},
    toast(msg) { toasts.push(msg); },
  };

  const lsMap = {};
  const localStorage = {
    getItem: (k) => (k in lsMap ? lsMap[k] : null),
    setItem: (k, v) => { lsMap[k] = String(v); },
    removeItem: (k) => { delete lsMap[k]; },
  };

  // 设备 A 仓库（= 远端），push 时同步对象过去
  const aDir = path.join(root, 'deviceA-repo');
  let remoteHead = null;
  const bRoot = root;
  const copyObjects = async (from, to) => {
    const src = path.join(from, '.git', 'objects');
    const dst = path.join(to, '.git', 'objects');
    async function walk(d) {
      let ents = []; try { ents = await fs.readdir(d, { withFileTypes: true }); } catch (_) { return; }
      for (const e of ents) {
        const s = path.join(d, e.name), t = path.join(dst, path.relative(src, s));
        if (e.isDirectory()) { await walk(s); }
        else { await fs.mkdir(path.dirname(t), { recursive: true }); await fs.copyFile(s, t).catch(() => {}); }
      }
    }
    await walk(src);
  };
  const gitStub = Object.assign({}, gitReal, {
    fetch: async () => ({}),
    push: async ({ fs: f, dir }) => {
      const head = await gitReal.resolveRef({ fs: f, dir, ref: 'HEAD' });
      if (head === remoteHead) return { ok: true };
      if (remoteHead == null || await gitReal.isDescendent({ fs: f, dir, oid: head, ancestor: remoteHead })) {
        await copyObjects(path.join(bRoot, 'zhinote'), aDir);
        await setRef(aDir, 'refs/heads/main', head);
        remoteHead = head;
        return { ok: true };
      }
      const e = new gitReal.Errors.PushRejectedError(); throw e;
    },
  });

  return { win, storageData, toasts, events, localStorage, aDir,
    get remoteHead() { return remoteHead; }, set remoteHead(v) { remoteHead = v; },
    gitStub, copyObjects };
}

async function setRef(repoDir, ref, oid) {
  const p = path.join(repoDir, '.git', ref);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, oid + '\n');
}
async function getRef(repoDir, ref) {
  try { return (await fs.readFile(path.join(repoDir, '.git', ref), 'utf8')).trim(); } catch (_) { return null; }
}
/** 设备 A 提交（= 远端有新内容） */
async function deviceACommit(aDir, files, msg) {
  await gitReal.init({ fs: fs, dir: aDir, defaultBranch: 'main' }).catch(() => {});
  for (const [p, c] of Object.entries(files)) {
    await fs.mkdir(path.join(aDir, path.dirname(p)), { recursive: true });
    await fs.writeFile(path.join(aDir, p), c);
    await gitReal.add({ fs: fs, dir: aDir, filepath: p });
  }
  return await gitReal.commit({ fs: fs, dir: aDir, message: msg, author: { name: 'A', email: 'a@a' } });
}
/** 把远端内容 fetch 到 B（拷对象 + 推进 refs/remotes/origin/main） */
async function fetchInto(env, bRoot, oid) {
  await env.copyObjects(env.aDir, path.join(bRoot, 'zhinote'));
  await setRef(path.join(bRoot, 'zhinote'), 'refs/remotes/origin/main', oid);
}
function treeOf(git, f, dir, oid) {
  const walk = async (treePath, treeOid, acc) => {
    const t = await git.readTree({ fs: f, dir, oid: treeOid });
    for (const e of (t.entries || t.tree)) {
      const p = treePath ? treePath + '/' + e.path : e.path;
      if (e.mode === '040000') await walk(p, e.oid, acc);
      else acc[p] = e.oid;
    }
    return acc;
  };
  return git.readCommit({ fs: f, dir, oid }).then((c) => walk('', c.commit.tree, {}));
}
const note = (body, extra) => Object.assign({ doc: { __md: body }, content: body, title: 'T', updatedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' }, extra || {});
const fmFile = (id, body, extra) => {
  const e = extra || {};
  let out = '---\n';
  out += 'id: ' + JSON.stringify(id) + '\n';
  if (e.title != null) out += 'title: ' + JSON.stringify(e.title) + '\n';
  out += 'updated: ' + JSON.stringify(e.updated || '2026-01-01T00:00:00.000Z') + '\n';
  out += '---\n' + body;
  return out;
};

// ---------- 场景 ----------
async function freshCase(name, baseBody) {
  const root = path.join(os.tmpdir(), 'zn-fix-' + name + '-' + Date.now());
  await fs.mkdir(path.join(root, 'zhinote', 'notes'), { recursive: true });
  await fs.mkdir(path.join(root, 'deviceA-repo', 'notes'), { recursive: true });
  const env = makeEnv(root);
  // 初始化远端：base 提交
  const base = await deviceACommit(env.aDir, { 'notes/x.md': fmFile('x', baseBody || 'v1\n', { title: 'X' }) }, 'base');
  env.remoteHead = base;
  // B：模拟已 clone 的仓库（对象 + refs + 工作区就位）
  const zDir = path.join(root, 'zhinote');
  await env.copyObjects(env.aDir, zDir);
  await fs.writeFile(path.join(zDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await fs.writeFile(path.join(zDir, '.git', 'packed-refs'), 'pack:' + base + '\n');
  await setRef(zDir, 'refs/heads/main', base);
  await setRef(zDir, 'refs/remotes/origin/main', base);
  await fs.writeFile(path.join(zDir, 'notes', 'x.md'), fmFile('x', baseBody || 'v1\n', { title: 'X' }));
  // 加载 git-sync.js
  const code = await fs.readFile(new URL('../src/git-sync.js', import.meta.url), 'utf8');
  const sandbox = { window: env.win, git: env.gitStub, localStorage: env.localStorage, console, setTimeout, clearTimeout, Date, Math, JSON, TextDecoder, TextEncoder, Uint8Array, Int32Array, Object, Array, String, Number, Boolean, Error, Promise, Symbol, Map, Set, RegExp, isNaN, parseInt, parseFloat };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'git-sync.js' });
  return { root, env, zDir, base, gs: env.win.gitSync, data: env.storageData };
}

const A = async () => {
  console.log('\n场景1：双端改同一篇 + 本地新增笔记（旧版在此永久卡死）');
  const c = await freshCase('conflict');
  c.data.notes['x'] = note('v2 LOCAL\n', { title: 'X' });
  c.data.notes['y'] = note('local only\n', { title: 'Y' });     // 本地新增 → isogit merge 抛 MergeNotSupportedError
  const aHead = await deviceACommit(c.env.aDir, { 'notes/x.md': fmFile('x', 'v2 REMOTE\n', { title: 'X' }) }, 'A edits x');
  await fetchInto(c.env, c.root, aHead);

  const r1 = await c.gs.manualSync();
  ok(r1 && r1.ok, '同步轮1成功', r1);
  const head1 = await gitReal.resolveRef({ fs: fs, dir: c.zDir, ref: 'HEAD' });
  const cmt = await gitReal.readCommit({ fs: fs, dir: c.zDir, oid: head1 });
  ok((cmt.commit.parent || []).length === 2, 'HEAD 是双亲 merge commit', cmt.commit.parent);
  ok(cmt.commit.parent.includes(aHead), '第二亲 = 远端提交');
  ok(c.data.notes['x'] && c.data.notes['x'].content === 'v2 LOCAL\n', '撞车处以本地为准', c.data.notes['x'] && c.data.notes['x'].content);
  const cf1 = await c.gs.listConflicts();
  ok(cf1.length === 1 && cf1[0].orig === 'notes/x.md', '远端版留底 1 条', cf1.map(x => x.orig));
  ok(c.env.toasts.some(t => t.indexOf('留底') >= 0 || t.indexOf('冲突') >= 0), '有冲突提示 toast');

  const r2 = await c.gs.manualSync();
  ok(r2 && r2.ok, '同步轮2成功（无新变化）', r2);
  const cf2 = await c.gs.listConflicts();
  ok(cf2.length === 1, '留底去重：仍是 1 条不堆积', cf2.length);
  const fails = c.env.events.filter(e => e.type === 'git-sync-fail');
  ok(fails.length === 0, '全程无同步失败事件', fails.map(e => e.error && e.error.message));
  // 远端收到我们的决议（push 对象已同步到 A，A 的 main = B 的 merge commit）
  ok(c.env.remoteHead === head1, 'push 成功：远端指针 = merge commit');
};

const B = async () => {
  console.log('\n场景2：两端改同一篇不同段落 → diff3 自动融合');
  const c = await freshCase('diff3', 'a\nb\nc\n');
  c.data.notes['x'] = note('aB\nb\nc\n', { title: 'X' });
  const aHead = await deviceACommit(c.env.aDir, { 'notes/x.md': fmFile('x', 'a\nb\ncA\n', { title: 'X' }) }, 'A edits line3');
  await fetchInto(c.env, c.root, aHead);
  const r = await c.gs.manualSync();
  ok(r && r.ok, '同步成功', r);
  ok(c.data.notes['x'].content === 'aB\nb\ncA\n', '自动融合两端改动', c.data.notes['x'].content);
  const cf = await c.gs.listConflicts();
  ok(cf.length === 0, '无需留底', cf.length);
  const head = await gitReal.resolveRef({ fs: fs, dir: c.zDir, ref: 'HEAD' });
  const cmt = await gitReal.readCommit({ fs: fs, dir: c.zDir, oid: head });
  ok((cmt.commit.parent || []).length === 2, '仍是双亲 merge commit');
  // frontmatter 字段级：本地改 title，远端改 updated 更晚 → title 本地、updated 取远端
  const c2 = await freshCase('diff3-meta');
  c2.data.notes['x'] = note('v1\n', { title: '本地标题', updatedAt: '2026-01-01T00:00:00.000Z' });
  const ah2 = await deviceACommit(c2.env.aDir, { 'notes/x.md': fmFile('x', 'v1\n', { title: 'X', updated: '2026-02-01T00:00:00.000Z' }) }, 'A touches x');
  await fetchInto(c2.env, c2.root, ah2);
  await c2.gs.manualSync();
  const applied = c2.data.notes['x'];
  ok(applied.title === '本地标题', 'frontmatter：本地 title 保留（双方变→本地为准）', applied.title);
};

const C = async () => {
  console.log('\n场景3：本地删进回收站 + 远端改同一篇 → 不复活');
  const c = await freshCase('delete');
  delete c.data.notes['x'];
  c.data.trash['x'] = note('v1\n', { title: 'X', deletedAt: '2026-01-02T00:00:00.000Z' });
  const aHead = await deviceACommit(c.env.aDir, { 'notes/x.md': fmFile('x', 'v2 REMOTE\n', { title: 'X' }) }, 'A edits x');
  await fetchInto(c.env, c.root, aHead);
  const r = await c.gs.manualSync();
  ok(r && r.ok, '同步成功', r);
  ok(!c.data.notes['x'], '笔记不复活', c.data.notes['x'] && c.data.notes['x'].content);
  ok(c.data.trash['x'], '仍在回收站');
  const cf = await c.gs.listConflicts();
  ok(cf.some(x => x.orig === 'notes/x.md'), '远端修改版留底可找回', cf.map(x => x.orig));
  const head = await gitReal.resolveRef({ fs: fs, dir: c.zDir, ref: 'HEAD' });
  const files = await treeOf(gitReal, fs, c.zDir, head);
  ok(!files['notes/x.md'], '合并树里没有 notes/x.md（删除会传播到远端）');
  ok(!!files['trash/x.md'], '合并树里保留 trash/x.md');
};

const D = async () => {
  console.log('\n场景4：两端各自新增笔记本/墓碑 → 结构化并集');
  const c = await freshCase('union');
  c.data.workspaces = [{ id: 'w1', name: 'W1' }, { id: 'w2', name: '本地新笔记本' }];
  const aHead = await deviceACommit(c.env.aDir, {
    'notes/x.md': fmFile('x', 'v1\n', { title: 'X' }),   // A 没改 x，但 need changed... x 相同 → o===t skip
    'workspaces.json': JSON.stringify({ v: 1, workspaces: [{ id: 'w1', name: 'W1' }, { id: 'w3', name: '远端新笔记本' }], wsDeleted: {} }),
    'tombstones.json': JSON.stringify({ v: 1, note: { zz: '2026-01-05T00:00:00.000Z' }, ws: {}, tpl: {} }),
  }, 'A adds ws + tombstone');
  await fetchInto(c.env, c.root, aHead);
  // 触发本地 workspaces.json 导出变化
  const r = await c.gs.manualSync();
  ok(r && r.ok, '同步成功', r);
  const names = c.data.workspaces.map(w => w.id).sort();
  ok(names.join(',') === 'w1,w2,w3', '笔记本并集合并', names);
  ok(c.data.wsTombstones && c.data.wsTombstones, 'wsTombstones 应用', c.data.wsTombstones);
  const cf = await c.gs.listConflicts();
  ok(cf.length === 0, '全局 JSON 不再产生留底', cf.map(x => x.orig));
};

const E = async () => {
  console.log('\n场景5：纯下载（FF 合并）→ 工作区强制检出，远端改动真正落地');
  const c = await freshCase('ff-download');
  // 轮1：B 把 base 内容提交并推上去（两端 HEAD 对齐）
  const r1 = await c.gs.manualSync();
  ok(r1 && r1.ok && r1.pushed, '轮1：首次对齐推送', r1);
  // A 在对齐后的历史上新增笔记 q + 修改 x
  const aNew = await deviceACommit(c.env.aDir, {
    'notes/q.md': fmFile('q', '远端新笔记\n', { title: 'Q' }),
    'notes/x.md': fmFile('x', 'v1 远端改\n', { title: 'X' }),
  }, 'A adds q, edits x');
  // A 的提交要基于 B 推上去的 HEAD —— deviceACommit 是在 A 的 HEAD 上叠加，而轮1 push 已把 B 的提交同步到 A ✓
  await fetchInto(c.env, c.root, aNew);
  const r2 = await c.gs.manualSync();
  ok(r2 && r2.ok, '轮2：下载同步成功', r2);
  ok(!!c.data.notes['q'], '远端新笔记落地（旧版 FF 不落工作区 → 此处必挂）', Object.keys(c.data.notes));
  ok(c.data.notes['x'] && c.data.notes['x'].content === 'v1 远端改\n', '远端修改落地', c.data.notes['x'] && c.data.notes['x'].content);
};

const F = async () => {
  console.log('\n场景6：留底「仅恢复正文」保留本地结构 + push 竞态自愈不炸');
  const c = await freshCase('apply');
  c.data.notes['x'] = note('v2 LOCAL\n', { title: 'X', parentId: 'p-local', color: 'red' });
  const aHead = await deviceACommit(c.env.aDir, { 'notes/x.md': fmFile('x', 'v2 远端内容\n', { title: '远端标题' }) }, 'A edits x');
  await fetchInto(c.env, c.root, aHead);
  await c.gs.manualSync();
  const cf = await c.gs.listConflicts();
  ok(cf.length === 1, '留底在', cf.length);
  const before = c.data.notes['x'];
  await c.gs.applyConflict(cf[0].path, { mode: 'body' });
  const after = c.data.notes['x'];
  ok(after.content === 'v2 远端内容\n' && after.title === '远端标题', '正文/标题取远端', { t: after.title, c: after.content });
  ok(after.parentId === 'p-local' && after.color === 'red', '结构字段保留本地', { p: after.parentId, c: after.color });
  ok(before.parentId === 'p-local', '（前置）本地原本有 parentId');
  const cf2 = await c.gs.listConflicts();
  ok(cf2.length === 0, '处理后留底清掉', cf2.length);
};

(async () => {
  await A(); await B(); await C(); await D(); await E(); await F();
  console.log('\n========== 结果：' + T.pass + ' 通过 / ' + T.fail + ' 失败 ==========');
  process.exit(T.fail ? 1 : 0);
})().catch((e) => { console.error('测试崩溃：', e); process.exit(2); });
