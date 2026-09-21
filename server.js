// HTTP 入口模块：路由、请求解析、页面渲染。判定交给 rules，存储交给 store。
import http from "node:http";
import {
  loadDb, saveDb, findItem, findTest, addItem, newItemId, newTestId
} from "./src/store.js";
import {
  REFERENCE_TEMP, REFERENCE_HUMIDITY, TEMP_MIN, TEMP_MAX, HUMIDITY_MIN, HUMIDITY_MAX,
  ITEM_STATUSES, submitTest, sealTest, computeStats, decorateItem, HttpError
} from "./src/rules.js";

const port = Number(process.env.PORT || 3037);

const fields = [
  ["code", "墨锭编号", "text"],
  ["smokeSource", "烟料来源", "text"],
  ["glueRatio", "胶料比例", "text"],
  ["ageYears", "存放年限", "number"],
  ["storage", "存放位置", "text"]
];

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>纸样水样准入与温湿度校正台</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; --seal:#8a6d2f; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:24px; } h2 { margin:0 0 12px; font-size:17px; } main { display:grid; grid-template-columns:400px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:56px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; } button.secondary { background:#69736a; } button:disabled { opacity:.5; cursor:default; }
    .hint { color:var(--muted); font-size:12px; line-height:1.6; margin:8px 0 0; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(110px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } .toolbar select,.toolbar input { width:auto; min-width:150px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(310px,1fr)); gap:12px; } .card { display:grid; gap:8px; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .pill.pending { color:var(--warn); border-color:var(--warn); } .pill.pass { color:var(--accent); border-color:var(--accent); }
    .pill.fail { color:var(--warn); border-color:var(--warn); } .pill.sealed { color:var(--seal); border-color:var(--seal); } .pill.archived { color:#888; border-color:#bbb; }
    .banner { border-radius:6px; padding:8px 10px; font-size:13px; } .banner.warn { background:#f7e9e5; color:var(--warn); } .banner.ok { background:#eef3ea; color:var(--accent); }
    .test { border:1px solid var(--line); border-radius:6px; padding:9px 10px; display:grid; gap:3px; font-size:13px; }
    .test.archived { background:#f6f6f4; color:#7a7a74; } .test.sealed { background:#faf6ec; }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:110px; overflow:auto; }
    .toast { position:fixed; right:20px; bottom:20px; max-width:420px; border-radius:8px; padding:12px 16px; color:#fff; font-size:14px; display:none; }
    .toast.ok { background:var(--accent); } .toast.err { background:var(--warn); }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header>
    <div><h1>纸样水样准入与温湿度校正台</h1>
      <div class="meta">墨锭试磨 · 每次试磨绑定同批宣纸与水样 · 评分按 ${REFERENCE_TEMP}℃/${REFERENCE_HUMIDITY}% 校正</div></div>
    <button id="reload">刷新</button>
  </header>
  <main>
    <section>
      <form id="createForm"><h2>新增墨锭</h2><div id="fields"></div><button>保存墨锭</button></form>
      <form id="testForm" style="margin-top:14px">
        <h2>提交试磨（准入 + 校正）</h2>
        <label>选择墨锭</label><select name="itemId" id="itemSelect"></select>
        <label>宣纸批次（同一纸样只能有一条未封存试磨）</label><input name="paperBatch" required placeholder="如 P-2026-0418-01">
        <label>纸张克重 g/m²（缺失则 409 不落库）</label><input name="paperGrammage" type="number" step="0.1" placeholder="如 32">
        <label>水样批次</label><input name="waterBatch" required placeholder="如 W-桃花泉-06">
        <label>水样硬度 mg/L（缺失则 409 不落库）</label><input name="waterHardness" type="number" step="0.1" placeholder="如 42">
        <label>试磨温度 ℃（允许 ${TEMP_MIN}–${TEMP_MAX}，越界转待复测）</label><input name="temp" type="number" step="0.1" placeholder="基准 ${REFERENCE_TEMP}">
        <label>相对湿度 %（允许 ${HUMIDITY_MIN}–${HUMIDITY_MAX}，越界转待复测）</label><input name="humidity" type="number" step="0.1" placeholder="基准 ${REFERENCE_HUMIDITY}">
        <label>原始评分 0-100</label><input name="rawScore" type="number" min="0" max="100" required>
        <label>备注</label><textarea name="note"></textarea>
        <p class="hint">复测须更换纸样；调整水样或纸张，原未封存结论转为「失效留档」留档且不计统计。</p>
        <button>提交试磨</button>
      </form>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="toolbar">
        <select id="statusFilter"><option value="">全部状态</option>${ITEM_STATUSES.map(s => `<option>${s}</option>`).join("")}</select>
        <input id="search" placeholder="搜索编号 / 纸样 / 水样批次">
      </div>
      <div class="panel">
        <h2>墨锭试磨档案</h2>
        <div class="grid" id="cards"></div>
      </div>
    </section>
  </main>
  <div class="toast" id="toast"></div>
  <script>
    const statuses = ${JSON.stringify(ITEM_STATUSES)};
    const fields = ${JSON.stringify(fields)};
    const createForm = document.querySelector('#createForm');
    const testForm = document.querySelector('#testForm');
    const cards = document.querySelector('#cards');
    const statsEl = document.querySelector('#stats');
    const itemSelect = document.querySelector('#itemSelect');
    const toastEl = document.querySelector('#toast');
    let items = [];
    let toastTimer = null;

    function esc(v) {
      return String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }
    function toast(msg, ok) {
      toastEl.textContent = msg;
      toastEl.className = 'toast ' + (ok ? 'ok' : 'err');
      toastEl.style.display = 'block';
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { toastEl.style.display = 'none'; }, 3200);
    }
    async function api(path, options) {
      const res = await fetch(path, options && options.body
        ? { ...options, headers: { 'Content-Type': 'application/json' } } : options);
      const data = await res.json();
      if (!res.ok) {
        const e = new Error(data.error ? data.error + '：' + (data.message || '') : '请求失败');
        e.status = res.status; e.code = data.error;
        throw e;
      }
      return data;
    }
    function renderForms() {
      document.querySelector('#fields').innerHTML = fields
        .map(([key, label, type]) => '<label>' + label + '</label><input name="' + key + '" type="' + type + '"' + (key === 'code' ? ' required' : '') + '>')
        .join('');
    }
    function pill(state) {
      const cls = { '待复测': 'pending', '已判定': 'pass', '已封存': 'sealed', '失效留档': 'archived' }[state] || '';
      return '<span class="pill ' + cls + '">' + state + '</span>';
    }
    function testHtml(t) {
      const archived = t.state === '失效留档';
      const sealed = t.state === '已封存';
      const scoreLine = t.state === '待复测'
        ? '<span class="warn">温湿度越界 · 待换纸样复测（原始分 ' + esc(t.rawScore) + '，不出校正分）</span>'
        : '原始 ' + esc(t.rawScore) + ' → 校正 <b>' + esc(t.correctedScore) + '</b>（' + esc(t.temp) + '℃ / ' + esc(t.humidity) + '%）· ' + esc(t.result || '');
      const sealBtn = (t.state === '待复测' || t.state === '已判定')
        ? ' <button class="secondary" data-seal="' + esc(t.id) + '">封存</button>' : '';
      return '<div class="test ' + (archived ? 'archived' : sealed ? 'sealed' : '') + '">'
        + '<div>' + pill(t.state) + ' ' + esc(t.id) + '</div>'
        + '<div>纸样 ' + esc(t.paperBatch) + ' · ' + esc(t.paperGrammage) + 'g/m²</div>'
        + '<div>水样 ' + esc(t.waterBatch) + ' · ' + esc(t.waterHardness) + 'mg/L</div>'
        + '<div>' + scoreLine + '</div>'
        + (t.pendingReason ? '<div class="meta">' + esc(t.pendingReason) + '</div>' : '')
        + (t.invalidReason ? '<div class="meta">失效原因：' + esc(t.invalidReason) + '</div>' : '')
        + (t.sealNote ? '<div class="meta">' + esc(t.sealNote) + (t.sealedAt ? ' · ' + esc(new Date(t.sealedAt).toLocaleString()) : '') + '</div>' : '')
        + (t.note ? '<div class="meta">备注：' + esc(t.note) + '</div>' : '')
        + '<div class="meta">' + esc(new Date(t.createdAt).toLocaleString()) + sealBtn + '</div>'
        + '</div>';
    }
    function cardHtml(item) {
      const main = fields.slice(0, 4).map(([key, label]) =>
        '<div><b>' + label + '</b> ' + esc(item[key]) + '</div>').join('');
      const tests = item.tests || [];
      const active = tests.filter(t => t.state !== '失效留档');
      const archived = tests.filter(t => t.state === '失效留档');
      let banner = '';
      const latest = active[0];
      if (latest && latest.state === '待复测') {
        banner = '<div class="banner warn">待复测：须更换新纸样后重新提交试磨，原卷将自动封存。</div>';
      } else if (latest && latest.state === '已判定' && latest.result === '合格') {
        banner = '<div class="banner ok">当前结论：合格（校正分 ' + esc(latest.correctedScore) + '）</div>';
      } else if (latest && latest.state === '已判定') {
        banner = '<div class="banner warn">当前结论：重点观察（校正分 ' + esc(latest.correctedScore) + '）</div>';
      }
      const logs = (item.logs || []).slice(-5).map(l =>
        '<div>' + esc(l.step) + '：' + esc(l.note) + '</div>').join('');
      return '<article class="card">'
        + '<h3 style="margin:0">' + esc(item.code) + ' ' + pill(item.derivedStatus) + '</h3>'
        + main + banner
        + '<div class="meta">试磨 ' + tests.length + ' 条（失效留档 ' + archived.length + ' 条，不计统计）</div>'
        + (active.length ? active.map(testHtml).join('') : '<div class="meta">暂无有效试磨</div>')
        + (archived.length ? '<details><summary class="meta">失效留档（' + archived.length + '）</summary>' + archived.map(testHtml).join('') + '</details>' : '')
        + '<div class="logs meta">' + (logs || '暂无记录') + '</div>'
        + '</article>';
    }
    function render(stats) {
      itemSelect.innerHTML = items.map(item =>
        '<option value="' + esc(item.id) + '">' + esc(item.code) + ' · ' + esc(item.smokeSource || '') + '</option>').join('');
      statsEl.innerHTML = Object.entries(stats).map(([k, v]) =>
        '<div class="stat"><span>' + k + '</span><strong>' + v + '</strong></div>').join('');
      const status = document.querySelector('#statusFilter').value;
      const q = document.querySelector('#search').value.trim();
      const visible = items.filter(item =>
        (!status || item.derivedStatus === status)
        && (!q || JSON.stringify(item).includes(q)));
      cards.innerHTML = visible.map(cardHtml).join('');
      document.querySelectorAll('[data-seal]').forEach(btn => btn.onclick = async () => {
        btn.disabled = true;
        try {
          await api('/api/tests/' + btn.dataset.seal + '/seal', { method: 'POST' });
          toast('试磨已封存');
        } catch (e) { toast(e.message, false); }
        await load();
      });
    }
    async function load() {
      const [list, stats] = await Promise.all([api('/api/items'), api('/api/stats')]);
      items = list;
      render(stats);
    }
    createForm.onsubmit = async event => {
      event.preventDefault();
      try {
        await api('/api/items', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(createForm).entries())) });
        createForm.reset();
        toast('墨锭已建档');
      } catch (e) { toast(e.message, false); }
      await load();
    };
    testForm.onsubmit = async event => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(testForm).entries());
      try {
        const result = await api('/api/items/' + encodeURIComponent(data.itemId) + '/tests',
          { method: 'POST', body: JSON.stringify(data) });
        toast(result.reused ? '该纸样已有未封存试磨，沿用首次记录，未重复落库' : '试磨已提交', true);
      } catch (e) {
        toast(e.status === 409 ? '准入冲突（409，未落库）：' + e.message : e.message, false);
      }
      testForm.reset();
      await load();
    };
    document.querySelector('#statusFilter').onchange = load;
    document.querySelector('#search').oninput = async () => {
      const stats = await api('/api/stats');
      render(stats);
    };
    document.querySelector('#reload').onclick = load;
    renderForms();
    load();
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = await loadDb();

    if (req.method === "GET" && url.pathname === "/") return html(res, page());

    if (req.method === "GET" && url.pathname === "/api/items") {
      return send(res, 200, db.items.map(item => decorateItem(db, item)));
    }

    if (req.method === "GET" && url.pathname === "/api/stats") {
      return send(res, 200, computeStats(db));
    }

    if (req.method === "POST" && url.pathname === "/api/items") {
      const input = await readBody(req);
      if (!input.code || !String(input.code).trim()) {
        return send(res, 400, { error: "code_required", message: "墨锭编号必须填写" });
      }
      const item = {
        id: newItemId(),
        ...input,
        logs: [{ at: new Date().toISOString(), step: "建档", note: "创建墨锭" }]
      };
      addItem(db, item);
      await saveDb(db);
      return send(res, 201, decorateItem(db, item));
    }

    const submit = url.pathname.match(/^\/api\/items\/([^/]+)\/tests$/);
    if (submit && req.method === "POST") {
      const item = findItem(db, decodeURIComponent(submit[1]));
      if (!item) return send(res, 404, { error: "item_not_found", message: "墨锭不存在" });
      const input = await readBody(req);
      // submitTest 在准入失败/冲突时抛错且不写入 db，因此这里不调用 saveDb，保证不落库。
      const { test, reused } = submitTest(db, item, input, newTestId);
      await saveDb(db);
      return send(res, reused ? 200 : 201, { test, reused, itemStatus: decorateItem(db, item).derivedStatus });
    }

    const seal = url.pathname.match(/^\/api\/tests\/([^/]+)\/seal$/);
    if (seal && req.method === "POST") {
      const test = findTest(db, decodeURIComponent(seal[1]));
      if (!test) return send(res, 404, { error: "test_not_found", message: "试磨记录不存在" });
      sealTest(db, test);
      await saveDb(db);
      return send(res, 200, { test });
    }

    return send(res, 404, { error: "not_found" });
  } catch (error) {
    if (error instanceof HttpError) {
      return send(res, error.status, { error: error.code, message: error.message });
    }
    return send(res, 500, { error: "server_error", message: error.message });
  }
});

function html(res, text) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(text);
}

server.listen(port, () => console.log("纸样水样准入与温湿度校正台 listening on http://localhost:" + port));
