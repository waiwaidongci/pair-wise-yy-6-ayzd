// 入口模块：HTTP 路由与页面编排。判定走 rules.js，存储走 store.js。
import http from "node:http";
import { Store } from "./store.js";
import {
  RuleError, TEST_STATUSES,
  admitPaper, admitWater, admitStick, admitTest,
  sealTest, retest, adjustTest, overview
} from "./rules.js";

const port = Number(process.env.PORT || 3037);
const store = new Store();

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RuleError(400, "invalid_json", "请求体不是合法 JSON");
  }
}
function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function html(res, text) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(text);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = await store.load();
    const p = url.pathname;

    if (req.method === "GET" && p === "/") return html(res, page());

    // 卡片与统计共用一份快照
    if (req.method === "GET" && p === "/api/overview") return send(res, 200, overview(db));

    if (req.method === "POST" && p === "/api/sticks") {
      const stick = admitStick(db, await body(req));
      await store.save();
      return send(res, 201, { stick, overview: overview(db) });
    }
    if (req.method === "POST" && p === "/api/papers") {
      const paper = admitPaper(db, await body(req));
      await store.save();
      return send(res, 201, { paper, overview: overview(db) });
    }
    if (req.method === "POST" && p === "/api/waters") {
      const water = admitWater(db, await body(req));
      await store.save();
      return send(res, 201, { water, overview: overview(db) });
    }

    // 试磨准入：墨锭 + 同批宣纸 + 水样绑定
    if (req.method === "POST" && p === "/api/tests") {
      const { test, reused } = admitTest(db, await body(req));
      // 重复提交沿用首次：不写入，自然也不 save
      if (!reused) await store.save();
      return send(res, reused ? 200 : 201, { test, reused, overview: overview(db) });
    }

    const actionMatch = p.match(/^\/api\/tests\/([^/]+)\/(seal|retest|adjust)$/);
    if (actionMatch && req.method === "POST") {
      const [, id, action] = actionMatch;
      const input = await body(req);
      let result;
      if (action === "seal") result = { test: sealTest(db, id) };
      if (action === "retest") result = retest(db, id, input);
      if (action === "adjust") result = adjustTest(db, id, input);
      await store.save();
      return send(res, 200, { ...result, overview: overview(db) });
    }

    return send(res, 404, { error: "not_found" });
  } catch (error) {
    if (error instanceof RuleError) {
      return send(res, error.status, { error: error.code, message: error.message });
    }
    return send(res, 500, { error: "internal_error", message: error.message });
  }
});

server.listen(port, () => console.log("纸样水样准入与温湿度校正台 listening on http://localhost:" + port));

function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>纸样水样准入与温湿度校正台</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; --hold:#8a6d1d; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:24px; } h2 { margin:0 0 10px; font-size:16px; } main { display:grid; grid-template-columns:400px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:14px; }
    label { display:block; margin:8px 0 4px; color:var(--muted); font-size:13px; } input,select { width:100%; border:1px solid var(--line); border-radius:6px; padding:8px; font:inherit; background:#fff; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:9px 12px; font-weight:700; cursor:pointer; }
    button.secondary { background:#69736a; } button.warn { background:var(--warn); } button.hold { background:var(--hold); }
    form button { margin-top:12px; width:100%; } .leftcol { display:grid; gap:14px; align-content:start; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:22px; }
    .stat.small strong { font-size:16px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } .toolbar select,.toolbar input { width:auto; min-width:150px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(320px,1fr)); gap:12px; } .card { display:grid; gap:6px; }
    .meta { color:var(--muted); font-size:12px; } .row { display:flex; gap:8px; } .row > * { flex:1; }
    .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:2px 9px; font-size:12px; margin-right:5px; }
    .pill.未封存 { background:#eef2e8; } .pill.待复测 { background:#f7efdc; color:var(--hold); }
    .pill.已封存 { background:#e4ede0; color:var(--accent); } .pill.失效留档 { background:#f2e2dd; color:var(--warn); }
    .verdict { font-weight:700; } .warn { color:var(--warn); font-weight:700; } .hold { color:var(--hold); font-weight:700; }
    .logs { border-top:1px solid var(--line); padding-top:6px; max-height:96px; overflow:auto; } .logs div { margin:2px 0; }
    .ledger { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:12px; margin-bottom:14px; }
    .ledger ul { margin:6px 0 0; padding-left:18px; } .ledger li { margin:3px 0; font-size:13px; }
    .btns { display:flex; gap:6px; flex-wrap:wrap; margin-top:6px; } .btns button { width:auto; padding:7px 10px; font-size:12px; }
    #toast { position:fixed; right:20px; bottom:20px; max-width:420px; display:grid; gap:8px; z-index:10; }
    .toast { padding:10px 14px; border-radius:8px; background:#20241f; color:#fff; font-size:13px; box-shadow:0 4px 16px rgba(0,0,0,.25); }
    .toast.err { background:var(--warn); }
    dialog { border:1px solid var(--line); border-radius:10px; padding:18px; width:min(420px,92vw); }
    dialog::backdrop { background:rgba(20,24,19,.45); }
    @media (max-width:960px){ main{grid-template-columns:1fr;} header{display:block;padding:16px;} main{padding:14px;} }
  </style>
</head>
<body>
  <header>
    <div><h1>纸样水样准入与温湿度校正台</h1>
    <div class="meta">试磨绑定同批宣纸与水样 · 评分按 20℃ / 50% 湿度线性校正 · 越界转待复测</div></div>
    <button id="reload">刷新</button>
  </header>
  <main>
    <div class="leftcol">
      <form id="stickForm"><h2>墨锭建档</h2>
        <label>墨锭编号</label><input name="code" required placeholder="IS-003">
        <div class="row"><div><label>烟料来源</label><input name="smokeSource"></div>
        <div><label>胶料比例</label><input name="glueRatio" placeholder="8%"></div></div>
        <div class="row"><div><label>存放年限</label><input name="ageYears" type="number"></div>
        <div><label>存放位置</label><input name="storage"></div></div>
        <button>保存墨锭</button>
      </form>

      <form id="paperForm"><h2>纸样准入（同批宣纸按批号）</h2>
        <div class="row"><div><label>批号</label><input name="batch" required placeholder="P-2026-053"></div>
        <div><label>名称</label><input name="name" required placeholder="净皮六尺宣"></div></div>
        <label>克重（g/㎡，缺失将被 409 拒绝）</label><input name="grammage" type="number" step="0.1" placeholder="如 32.2">
        <button>登记纸样</button>
      </form>

      <form id="waterForm"><h2>水样准入</h2>
        <div class="row"><div><label>水样编号</label><input name="code" required placeholder="W-04"></div>
        <div><label>水源</label><input name="source" required placeholder="山泉水"></div></div>
        <label>硬度（mg/L CaCO₃，缺失将被 409 拒绝）</label><input name="hardness" type="number" step="1" placeholder="如 42">
        <button>登记水样</button>
      </form>

      <form id="testForm"><h2>创建试磨（绑定墨锭/纸样/水样）</h2>
        <label>墨锭</label><select name="inkCode" id="inkSelect"></select>
        <label>同批宣纸</label><select name="paperBatch" id="paperSelect"></select>
        <label>水样</label><select name="waterId" id="waterSelect"></select>
        <div class="row">
          <div><label>实测温度 ℃（合格 18~22）</label><input name="temp" type="number" step="0.1" value="20"></div>
          <div><label>实测湿度 %（合格 45~55）</label><input name="humidity" type="number" step="1" value="50"></div>
        </div>
        <label>原始评分（0~100，校正后 ≥85 为合格）</label><input name="rawScore" type="number" min="0" max="100" placeholder="如 86">
        <button>提交试磨</button>
      </form>
    </div>

    <section>
      <div class="stats" id="stats"></div>
      <div class="ledger" id="ledger"></div>
      <div class="toolbar">
        <select id="statusFilter"><option value="">全部状态</option>${TEST_STATUSES.map(s => '<option>' + s + '</option>').join('')}</select>
        <input id="search" placeholder="搜索单号 / 墨锭 / 纸样 / 水样">
        <span class="meta" id="basis"></span>
      </div>
      <div class="panel"><h2>试磨单卡片</h2><div class="grid" id="cards"></div></div>
    </section>
  </main>

  <dialog id="dialog">
    <form method="dialog" id="dialogForm">
      <h2 id="dlgTitle"></h2>
      <div id="dlgBody"></div>
      <div class="btns" style="margin-top:14px">
        <button value="confirm" id="dlgOk">提交</button>
        <button type="button" class="secondary" id="dlgCancel">取消</button>
      </div>
    </form>
  </dialog>
  <div id="toast"></div>

  <script>
    const TEST_STATUSES = ${JSON.stringify(TEST_STATUSES)};
    let state = { sticks: [], papers: [], waters: [], tests: [], stats: null };
    const $ = sel => document.querySelector(sel);
    const esc = v => String(v ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
    const formJson = form => Object.fromEntries(new FormData(form).entries());

    function toast(message, isErr) {
      const el = document.createElement('div');
      el.className = 'toast' + (isErr ? ' err' : '');
      el.textContent = message;
      $('#toast').appendChild(el);
      setTimeout(() => el.remove(), 4200);
    }

    async function api(path, options) {
      const res = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json' } });
      const data = await res.json();
      if (!res.ok) {
        const err = new Error(data.message || data.error || '请求失败');
        err.status = res.status;
        throw err;
      }
      return data;
    }
    function apply(data) {
      if (data && data.overview) state = data.overview;
      render();
    }

    function syncSelects() {
      const ink = $('#inkSelect'), paper = $('#paperSelect'), water = $('#waterSelect');
      ink.innerHTML = state.sticks.map(s => '<option value="' + esc(s.code) + '">' + esc(s.code) + ' · ' + esc(s.smokeSource || '') + '</option>').join('');
      paper.innerHTML = state.papers.map(p => '<option value="' + esc(p.batch) + '">' + esc(p.batch) + ' · ' + esc(p.name)
        + (p.grammage == null ? '（缺克重·禁入）' : ' · ' + p.grammage + 'g/㎡') + '</option>').join('');
      water.innerHTML = state.waters.map(w => '<option value="' + esc(w.code) + '">' + esc(w.code) + ' · ' + esc(w.source)
        + (w.hardness == null ? '（缺硬度·禁入）' : ' · ' + w.hardness + 'mg/L') + '</option>').join('');
    }

    function renderStats() {
      const s = state.stats;
      const t = s.tests, sealed = s.sealed;
      const cells = [
        ['未封存', t['未封存']], ['待复测', t['待复测']], ['已封存', t['已封存']], ['失效留档(不计统计)', s.archivedCount]
      ];
      $('#stats').innerHTML = cells.map(([k, v]) => '<div class="stat"><span>' + k + '</span><strong>' + v + '</strong></div>').join('')
        + '<div class="stat small"><span>封存合格 / 观察</span><strong>' + sealed.passCount + ' / ' + sealed.watchCount + '</strong></div>'
        + '<div class="stat small"><span>封存校正均分</span><strong>' + (sealed.avgCorrectedScore ?? '—') + '</strong></div>'
        + Object.entries(s.sticks).map(([k, v]) => '<div class="stat small"><span>墨锭·' + k + '</span><strong>' + v + '</strong></div>').join('');
      $('#basis').textContent = s.countedBasis + '；合格线 ' + s.correction.passScore + ' 分';
    }

    function renderLedger() {
      $('#ledger').innerHTML =
        '<div class="panel"><h2>纸样台账（' + state.papers.length + '）</h2><ul>'
        + state.papers.map(p => '<li>' + esc(p.batch) + ' ' + esc(p.name)
          + (p.grammage == null ? ' <span class="warn">缺克重</span>' : ' · ' + p.grammage + 'g/㎡') + '</li>').join('')
        + '</ul></div>'
        + '<div class="panel"><h2>水样台账（' + state.waters.length + '）</h2><ul>'
        + state.waters.map(w => '<li>' + esc(w.code) + ' ' + esc(w.source)
          + (w.hardness == null ? ' <span class="warn">缺硬度</span>' : ' · ' + w.hardness + 'mg/L') + '</li>').join('')
        + '</ul></div>'
        + '<div class="panel"><h2>墨锭台账（' + state.sticks.length + '）</h2><ul>'
        + state.sticks.map(s => '<li>' + esc(s.code) + ' ' + esc(s.smokeSource || '')
          + ' · <span class="pill">' + esc(s.derivedStatus) + '</span></li>').join('')
        + '</ul></div>';
    }

    function cardButtons(test) {
      if (test.status === '已封存') {
        return '<div class="btns"><button class="warn" data-adjust="' + esc(test.id) + '">调整纸/水样（原结论失效留档）</button></div>';
      }
      if (test.status === '待复测') {
        return '<div class="btns"><button class="hold" data-retest="' + esc(test.id) + '">复测（须换纸样）</button>'
          + '<button class="secondary" data-reeval="' + esc(test.id) + '">重录环境/评分</button></div>';
      }
      if (test.status === '未封存') {
        return '<div class="btns"><button data-seal="' + esc(test.id) + '">封存</button>'
          + '<button class="hold" data-retest="' + esc(test.id) + '">复测（须换纸样）</button>'
          + '<button class="secondary" data-reeval="' + esc(test.id) + '">重录环境/评分</button>'
          + '<button class="warn" data-adjust="' + esc(test.id) + '">调整纸/水样</button></div>';
      }
      return '<div class="meta">已失效留档，不计统计' + (test.successorId && test.successorId !== '(pending)'
        ? '；承接单 ' + esc(test.successorId) : '') + '</div>';
    }

    function cardHtml(test) {
      const logs = (test.history || []).slice(-4).map(l => '<div>' + esc(l.at.slice(0, 16).replace('T', ' ')) + ' ' + esc(l.note) + '</div>').join('');
      const link = test.retestOf ? '<div class="meta">复测自 ' + esc(test.retestOf) + '</div>'
        : test.supersedes ? '<div class="meta">承接自 ' + esc(test.supersedes) + '（原单已失效留档）</div>' : '';
      return '<article class="card">'
        + '<div><h3 style="margin:0;display:inline">' + esc(test.id) + '</h3></div>'
        + '<div><span class="pill ' + esc(test.status) + '">' + esc(test.status) + '</span>'
        + '<span class="verdict ' + (test.verdict === '合格' ? '' : 'hold') + '">'
        + (test.verdict ? esc(test.verdict) : '暂无结论') + '</span></div>'
        + '<div class="meta">墨锭 <b>' + esc(test.inkCode) + '</b></div>'
        + '<div class="meta">纸样 ' + esc(test.paperBatch) + ' ' + esc(test.paperName) + ' · ' + test.paperGrammage + 'g/㎡</div>'
        + '<div class="meta">水样 ' + esc(test.waterId) + ' ' + esc(test.waterSource) + ' · 硬度 ' + test.waterHardness + 'mg/L</div>'
        + '<div>环境 ' + test.temp + '℃ / ' + test.humidity + '%'
        + (test.inRange ? '' : ' <span class="warn">' + esc(test.violations.join('；')) + '</span>') + '</div>'
        + '<div>原始分 <b>' + test.rawScore + '</b> → 校正分 <b>' + test.correctedScore + '</b></div>'
        + link
        + cardButtons(test)
        + '<div class="logs meta">' + (logs || '暂无记录') + '</div>'
        + '</article>';
    }

    function renderCards() {
      const status = $('#statusFilter').value;
      const q = $('#search').value.trim();
      const visible = state.tests.filter(t =>
        (!status || t.status === status)
        && (!q || [t.id, t.inkCode, t.paperBatch, t.paperName, t.waterId, t.waterSource].join(' ').includes(q)));
      // 新单在前，失效留档沉底
      visible.sort((a, b) => (a.status === '失效留档') - (b.status === '失效留档') || b.createdAt.localeCompare(a.createdAt));
      $('#cards').innerHTML = visible.map(cardHtml).join('') || '<div class="meta">暂无试磨单</div>';
    }

    function render() {
      syncSelects();
      renderStats();
      renderLedger();
      renderCards();
    }

    // ---- 复测 / 重录 / 调整 对话框 ----
    const dlg = $('#dialog');
    function openDialog(title, bodyHtml) {
      $('#dlgTitle').textContent = title;
      $('#dlgBody').innerHTML = bodyHtml;
      dlg.showModal();
    }
    $('#dlgCancel').onclick = () => dlg.close();

    function envScoreFields(test) {
      return '<div class="row"><div><label>实测温度 ℃</label><input name="temp" type="number" step="0.1" value="' + (test?.temp ?? 20) + '"></div>'
        + '<div><label>实测湿度 %</label><input name="humidity" type="number" step="1" value="' + (test?.humidity ?? 50) + '"></div></div>'
        + '<label>原始评分</label><input name="rawScore" type="number" min="0" max="100" value="' + (test?.rawScore ?? '') + '">';
    }
    function paperWaterFields(test) {
      return '<label>新纸样（必须换一批）</label><select name="paperBatch">'
        + state.papers.map(p => '<option value="' + esc(p.batch) + '"' + (p.batch === test?.paperBatch ? ' disabled' : '') + '>'
          + esc(p.batch) + ' ' + esc(p.name) + (p.grammage == null ? '（缺克重）' : '') + '</option>').join('')
        + '</select>'
        + '<label>水样（可沿用）</label><select name="waterId">'
        + state.waters.map(w => '<option value="' + esc(w.code) + '"' + (w.code === test?.waterId ? ' selected' : '') + '>'
          + esc(w.code) + ' ' + esc(w.source) + (w.hardness == null ? '（缺硬度）' : '') + '</option>').join('')
        + '</select>';
    }

    document.addEventListener('click', async event => {
      const find = key => event.target.closest('[' + key + ']')?.getAttribute(key);
      const sealId = find('data-seal'), retestId = find('data-retest'),
        reevalId = find('data-reeval'), adjustId = find('data-adjust');
      try {
        if (sealId) {
          apply(await api('/api/tests/' + encodeURIComponent(sealId) + '/seal', { method: 'POST', body: '{}' }));
          toast('已封存，结论计入统计');
        } else if (reevalId) {
          const test = state.tests.find(t => t.id === reevalId);
          openDialog('重录环境 / 评分（不换纸样水样）', envScoreFields(test));
          $('#dlgOk').onclick = async () => {
            apply(await api('/api/tests/' + encodeURIComponent(reevalId) + '/adjust',
              { method: 'POST', body: JSON.stringify(formJson($('#dialogForm'))) }));
            dlg.close();
            toast('已按新环境重算校正分与结论');
          };
        } else if (retestId) {
          const test = state.tests.find(t => t.id === retestId);
          openDialog('复测：须更换纸样', paperWaterFields(test) + envScoreFields(test));
          $('#dlgOk').onclick = async () => {
            apply(await api('/api/tests/' + encodeURIComponent(retestId) + '/retest',
              { method: 'POST', body: JSON.stringify(formJson($('#dialogForm'))) }));
            dlg.close();
            toast('已按新纸样发起复测');
          };
        } else if (adjustId) {
          const test = state.tests.find(t => t.id === adjustId);
          openDialog('调整纸样 / 水样：原结论将失效留档且不计统计', paperWaterFields(test) + envScoreFields(test));
          $('#dlgOk').onclick = async () => {
            apply(await api('/api/tests/' + encodeURIComponent(adjustId) + '/adjust',
              { method: 'POST', body: JSON.stringify(formJson($('#dialogForm'))) }));
            dlg.close();
            toast('原结论已失效留档，新单已建立');
          };
        }
      } catch (err) {
        dlg.close();
        const prefix = err.status === 409 ? '准入冲突 409：' : '操作失败：';
        toast(prefix + err.message, true);
      }
    });

    async function submitForm(form, path, success, reset) {
      try {
        const data = await api(path, { method: 'POST', body: JSON.stringify(formJson(form)) });
        apply(data);
        if (reset) form.reset();
        toast(success(data));
      } catch (err) {
        const prefix = err.status === 409 ? '准入冲突 409：' : err.status === 400 ? '提交有误：' : '操作失败：';
        toast(prefix + err.message, true);
      }
    }
    $('#stickForm').onsubmit = e => { e.preventDefault(); submitForm(e.target, '/api/sticks', () => '墨锭已建档', true); };
    $('#paperForm').onsubmit = e => { e.preventDefault(); submitForm(e.target, '/api/papers', () => '纸样准入成功', true); };
    $('#waterForm').onsubmit = e => { e.preventDefault(); submitForm(e.target, '/api/waters', () => '水样准入成功', true); };
    $('#testForm').onsubmit = e => {
      e.preventDefault();
      submitForm(e.target, '/api/tests', data => data.reused
        ? '该纸样已有未封存试磨，已沿用首次提交：' + data.test.id
        : '试磨已准入：' + data.test.id + (data.test.status === '待复测' ? '（温湿度越界，转待复测）' : ''), true);
    };

    $('#statusFilter').onchange = renderCards;
    $('#search').oninput = renderCards;
    $('#reload').onclick = load;

    async function load() {
      try {
        state = await api('/api/overview');
        render();
      } catch (err) {
        toast('加载失败：' + err.message, true);
      }
    }
    load();
  </script>
</body>
</html>`;
}
