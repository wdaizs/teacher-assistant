/* 小学数学教学助手 - 前端逻辑（纯原生JS，无框架依赖） */
'use strict';
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

const state = {
  token: localStorage.getItem('token') || '',
  username: '',
  classes: [], students: [], items: [], periods: [],
  currentPeriodId: null,
  scoreClassId: '', selectedStudents: new Set(), selectedItem: null,
  queryClassId: '', queryPeriods: new Set(),
  totals: [], lastReset: {},
  audioCtx: null, ws: null, wsTimer: null
};

/* ---------- 工具 ---------- */
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function fmtTime(t) {
  const d = new Date(t), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
let toastTimer = null;
function toast(msg, type = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast ' + (type === 'ok' ? 'toast-ok' : type === 'err' ? 'toast-err' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}
function beep(freq = 880, dur = 0.18, times = 2) {
  try {
    if (!state.audioCtx) state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const ctx = state.audioCtx;
    if (ctx.state === 'suspended') ctx.resume();
    for (let i = 0; i < times; i++) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = freq; o.type = 'sine';
      g.gain.setValueAtTime(0.001, ctx.currentTime);
      const t0 = ctx.currentTime + i * (dur + 0.12);
      g.gain.setValueAtTime(0.25, t0);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
      o.connect(g); g.connect(ctx.destination);
      o.start(t0); o.stop(t0 + dur + 0.02);
    }
  } catch (e) { /* 音频不可用则静默 */ }
}
async function api(path, opts = {}) {
  const headers = { 'Authorization': 'Bearer ' + state.token };
  if (opts.form) {
    const res = await fetch(path, { method: 'POST', headers, body: opts.form });
    return handleRes(res);
  }
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, {
    method: opts.method || (opts.body !== undefined ? 'POST' : 'GET'),
    headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
  });
  return handleRes(res);
}
async function handleRes(res) {
  if (res.status === 401) { doLogout('登录已失效，请重新登录'); throw new Error('未登录'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '请求失败');
  return data;
}
function confirmModal(title, text, onOk, okText = '确认') {
  showModal(`<h3>${esc(title)}</h3><p style="color:var(--muted)">${text}</p>
    <div class="modal-actions"><button class="btn btn-light" data-mc="cancel">取消</button>
    <button class="btn btn-danger" data-mc="ok">${esc(okText)}</button></div>`, card => {
    card.querySelector('[data-mc=ok]').onclick = () => { hideModal(); onOk(); };
    card.querySelector('[data-mc=cancel]').onclick = hideModal;
  });
}
function showModal(html, bind) {
  $('#modalCard').innerHTML = html;
  $('#modalMask').hidden = false;
  bind && bind($('#modalCard'));
}
function hideModal() { $('#modalMask').hidden = true; $('#modalCard').innerHTML = ''; }
$('#modalMask') && $('#modalMask').addEventListener('click', e => { if (e.target === e.currentTarget) hideModal(); });

/* ---------- 登录 ---------- */
if (state.token) bootstrap();
$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const username = $('#loginUser').value.trim(), password = $('#loginPass').value;
  $('#loginError').hidden = true;
  try {
    const d = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) }).then(r => r.json());
    if (!d.token) throw new Error(d.error || '登录失败');
    state.token = d.token;
    localStorage.setItem('token', d.token);
    bootstrap();
  } catch (err) {
    $('#loginError').textContent = err.message || '账号或密码错误';
    $('#loginError').hidden = false;
  }
});
function doLogout(msg) {
  localStorage.removeItem('token');
  state.token = '';
  if (state.ws) try { state.ws.close(); } catch (e) {}
  $('#appView').hidden = true;
  $('#loginView').style.display = '';
  if (msg) toast(msg, 'err');
}
$('#logoutBtn').onclick = () => doLogout('已退出登录');

async function bootstrap() {
  try {
    const d = await api('/api/bootstrap');
    Object.assign(state, d);
    $('#loginView').style.display = 'none';
    $('#appView').hidden = false;
    renderAll();
    connectWs();
    refreshMessages();
    beep(660, 0.1, 1); // 提前激活音频上下文（用户已点击登录）
  } catch (e) { /* 401 已处理 */ }
}

/* ---------- 渲染总入口 ---------- */
function renderAll() {
  renderPeriodSel();
  renderClassSels();
  renderStudentGrid();
  renderItemChips();
  renderItemList();
  renderPeriodList();
  renderResetSels();
  renderQueryPeriodChips();
  renderServerUrl();
}
function renderPeriodSel() {
  const sel = $('#periodSel');
  sel.innerHTML = state.periods.map(p => `<option value="${p.id}" ${p.id === state.currentPeriodId ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
}
$('#periodSel').onchange = async e => {
  try {
    await api('/api/periods/current', { body: { id: e.target.value } });
    state.currentPeriodId = e.target.value;
    renderStudentGrid(); renderQueryPeriodChips(); renderResetSels();
  } catch (err) { toast(err.message, 'err'); }
};
function renderClassSels() {
  if (!state.scoreClassId && state.classes.length) state.scoreClassId = state.classes[0].id;
  if (!state.queryClassId && state.classes.length) state.queryClassId = state.classes[0].id;
  const opts = state.classes.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  const cur = c => state.classes.map(x => `<option value="${x.id}" ${x.id === c ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
  $('#scoreClassSel').innerHTML = state.classes.length ? cur(state.scoreClassId) : '<option value="">（请先创建班级）</option>';
  $('#stuClassSel').innerHTML = cur(state.scoreClassId);
  $('#queryClassSel').innerHTML = state.classes.length ? cur(state.queryClassId) : '<option value="">（请先创建班级）</option>';
  $('#resetClassSel').innerHTML = '<option value="">全部班级</option>' + cur('');
  state.scoreClassId = $('#scoreClassSel').value;
  state.queryClassId = $('#queryClassSel').value;
  renderStudentList();
}

/* ---------- Tab 切换 ---------- */
$('#tabNav').addEventListener('click', e => {
  const btn = e.target.closest('.tab-btn'); if (!btn) return;
  $$('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
  $$('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + btn.dataset.tab));
  if (btn.dataset.tab === 'message') refreshMessages();
});

/* ---------- 打分页 ---------- */
$('#scoreClassSel').onchange = e => { state.scoreClassId = e.target.value; state.selectedStudents.clear(); $('#stuClassSel').value = e.target.value; renderStudentGrid(); renderStudentList(); };
$('#scoreSelectAll').onclick = () => {
  studentsOfClass().forEach(s => state.selectedStudents.add(s.id));
  renderStudentGrid();
};
$('#scoreClearSel').onclick = () => { state.selectedStudents.clear(); renderStudentGrid(); };

function studentsOfClass() { return state.students.filter(s => s.classId === state.scoreClassId); }

async function renderStudentGrid() {
  const grid = $('#studentGrid');
  const stus = studentsOfClass();
  $('#scoreStuTip').hidden = stus.length > 0;
  $('#selCount').textContent = state.selectedStudents.size;
  grid.innerHTML = stus.map(s => {
    const t = (state.totals.find(r => r.studentId === s.id) || {}).total;
    const scoreHtml = t === undefined || t === null ? '—' :
      `<span class="${t > 0 ? 'pos' : t < 0 ? 'neg' : ''}">${t > 0 ? '+' : ''}${t}分</span>`;
    return `<div class="stu-cell ${state.selectedStudents.has(s.id) ? 'selected' : ''}" data-sid="${s.id}">
      <div class="stu-name">${esc(s.name)}</div><div class="stu-score">${scoreHtml}</div></div>`;
  }).join('');
  // 当前周期总分
  if (stus.length && state.currentPeriodId) {
    try {
      const d = await api(`/api/totals?classId=${state.scoreClassId}&periodIds=${state.currentPeriodId}`);
      state.totals = d.rows;
      stus.forEach(s => {
        const cell = grid.querySelector(`[data-sid="${s.id}"] .stu-score`);
        const r = d.rows.find(x => x.studentId === s.id);
        const t = r ? r.total : 0;
        if (cell) cell.innerHTML = `<span class="${t > 0 ? 'pos' : t < 0 ? 'neg' : ''}">${t > 0 ? '+' : ''}${t}分</span>`;
      });
    } catch (e) { /* ignore */ }
  }
}
$('#studentGrid').addEventListener('click', e => {
  const cell = e.target.closest('.stu-cell'); if (!cell) return;
  const sid = cell.dataset.sid;
  if (state.selectedStudents.has(sid)) state.selectedStudents.delete(sid); else state.selectedStudents.add(sid);
  cell.classList.toggle('selected');
  $('#selCount').textContent = state.selectedStudents.size;
});

function renderItemChips() {
  const box = $('#itemChips');
  const items = state.items.filter(i => i.active);
  box.innerHTML = items.map(i => {
    const sign = i.type === 'sub' ? '-' : '+';
    const signCls = i.type === 'sub' ? 'sub' : 'add';
    return `<div class="chip ${state.selectedItem === i.id ? 'selected' : ''}" data-iid="${i.id}">
      ${esc(i.name)}<span class="chip-score ${signCls}">${sign}${i.score}</span></div>`;
  }).join('') + (items.length ? '' : '<div class="muted-tip">请先在「项目」页添加加分/减分项目，或直接在下方手动填分值</div>');
}
$('#itemChips').addEventListener('click', e => {
  const chip = e.target.closest('.chip'); if (!chip) return;
  const iid = chip.dataset.iid;
  state.selectedItem = state.selectedItem === iid ? null : iid;
  $$('#itemChips .chip').forEach(c => c.classList.toggle('selected', c.dataset.iid === state.selectedItem));
  if (state.selectedItem) {
    const it = state.items.find(i => i.id === state.selectedItem);
    if (it) $('#scoreInput').value = (it.type === 'sub' ? -Math.abs(it.score) : Math.abs(it.score));
  }
});

$('#scoreSubmit').onclick = async () => {
  const score = Number($('#scoreInput').value);
  if (!state.selectedStudents.size) return toast('请先选择学生', 'err');
  if (!isFinite(score) || score === 0) return toast('请输入有效分值（减分请填负数）', 'err');
  if (!state.currentPeriodId) return toast('请先在「周期」页创建计分周期', 'err');
  const stus = studentsOfClass().filter(s => state.selectedStudents.has(s.id));
  try {
    const d = await api('/api/score', {
      body: {
        periodId: state.currentPeriodId, classId: state.scoreClassId,
        itemId: state.selectedItem || '', score,
        studentIds: stus.map(s => s.id)
      }
    });
    state.selectedStudents.clear();
    toast(`已为 ${d.count} 名学生记录 ${score > 0 ? '+' : ''}${score} 分`, 'ok');
    renderStudentGrid();
  } catch (err) { toast(err.message, 'err'); }
};

/* ---------- 学生管理页 ---------- */
$('#stuClassSel').onchange = e => { state.scoreClassId = e.target.value; $('#scoreClassSel').value = e.target.value; renderStudentList(); renderStudentGrid(); };
function renderStudentList() {
  const box = $('#studentList');
  const cls = state.classes.find(c => c.id === $('#stuClassSel').value);
  const stus = state.students.filter(s => s.classId === $('#stuClassSel').value);
  if (!cls) { box.innerHTML = '<div class="muted-tip">请先创建班级</div>'; return; }
  box.innerHTML = stus.length ? stus.map(s => `<div class="list-item">
    <div class="list-main"><div class="list-title">${esc(s.name)}</div><div class="list-sub">${s.studentNo ? '学号 ' + esc(s.studentNo) : ''}</div></div>
    <button class="btn btn-light btn-sm" data-act="edit" data-sid="${s.id}">编辑</button>
    <button class="btn btn-light btn-sm danger-text" data-act="del" data-sid="${s.id}">删除</button>
  </div>`).join('') : '<div class="muted-tip">暂无学生，可在上方添加或导入Excel名单</div>';
}
$('#studentList').addEventListener('click', e => {
  const btn = e.target.closest('button'); if (!btn) return;
  const sid = btn.dataset.sid, s = state.students.find(x => x.id === sid);
  if (btn.dataset.act === 'edit') {
    showModal(`<h3>编辑学生</h3><div class="form-col">
      <label>姓名</label><input id="mStuName" value="${esc(s.name)}">
      <label>学号</label><input id="mStuNo" value="${esc(s.studentNo || '')}">
      <label>班级</label><select id="mStuClass">${state.classes.map(c => `<option value="${c.id}" ${c.id === s.classId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
      <div class="modal-actions"><button class="btn btn-light" data-mc="c">取消</button><button class="btn btn-primary" data-mc="s">保存</button></div></div>`, card => {
      card.querySelector('[data-mc=s]').onclick = async () => {
        try {
          await api('/api/students/' + sid, { method: 'PUT', body: { name: card.querySelector('#mStuName').value, studentNo: card.querySelector('#mStuNo').value, classId: card.querySelector('#mStuClass').value } });
          hideModal(); await reload(); toast('已保存', 'ok');
        } catch (err) { toast(err.message, 'err'); }
      };
      card.querySelector('[data-mc=c]').onclick = hideModal;
    });
  } else if (btn.dataset.act === 'del') {
    confirmModal('删除学生', `确定删除 <b>${esc(s.name)}</b>？历史打分记录仍会保留。`, async () => {
      try { await api('/api/students/' + sid, { method: 'DELETE' }); await reload(); toast('已删除', 'ok'); } catch (err) { toast(err.message, 'err'); }
    });
  }
});
$('#addStuBtn').onclick = async () => {
  try {
    await api('/api/students', { body: { classId: $('#stuClassSel').value, name: $('#stuNameInput').value, studentNo: $('#stuNoInput').value } });
    $('#stuNameInput').value = ''; $('#stuNoInput').value = '';
    await reload(); toast('已添加', 'ok');
  } catch (err) { toast(err.message, 'err'); }
};
$('#tplLink').onclick = e => { e.preventDefault(); location.href = '/api/students/template?token=' + state.token; };
$('#importFile').onchange = async () => {
  const f = $('#importFile').files[0]; if (!f) return;
  const fd = new FormData();
  fd.append('classId', $('#stuClassSel').value);
  fd.append('file', f);
  $('#importStatus').hidden = false;
  $('#importStatus').textContent = '正在导入…';
  try {
    const d = await api('/api/students/import', { form: fd });
    $('#importFile').value = '';
    $('#importStatus').textContent = `导入成功：新增 ${d.added} 名学生` + (d.skipped.length ? `，跳过重复 ${d.skipped.length} 名（${d.skipped.join('、')}）` : '');
    await reload(); toast('导入完成', 'ok');
  } catch (err) {
    $('#importStatus').textContent = '';
    $('#importStatus').hidden = true;
    toast(err.message, 'err');
  }
};

/* ---------- 班级管理 ---------- */
$('#addClassBtn').onclick = () => {
  showModal(`<h3>新增班级</h3><div class="form-col"><label>班级名称</label><input id="mClassName" placeholder="如：三年二班">
    <div class="modal-actions"><button class="btn btn-light" data-mc="c">取消</button><button class="btn btn-primary" data-mc="s">添加</button></div></div>`, card => {
    card.querySelector('[data-mc=s]').onclick = async () => {
      try { await api('/api/classes', { body: { name: card.querySelector('#mClassName').value } }); hideModal(); await reload(); state.scoreClassId = state.classes[state.classes.length-1].id; renderClassSels(); toast('班级已创建', 'ok'); }
      catch (err) { toast(err.message, 'err'); }
    };
    card.querySelector('[data-mc=c]').onclick = hideModal;
  });
};
$('#renameClassBtn').onclick = () => {
  const cls = state.classes.find(c => c.id === $('#stuClassSel').value); if (!cls) return toast('请先创建班级', 'err');
  showModal(`<h3>重命名班级</h3><div class="form-col"><label>班级名称</label><input id="mClassName" value="${esc(cls.name)}">
    <div class="modal-actions"><button class="btn btn-light" data-mc="c">取消</button><button class="btn btn-primary" data-mc="s">保存</button></div></div>`, card => {
    card.querySelector('[data-mc=s]').onclick = async () => {
      try { await api('/api/classes/' + cls.id, { method: 'PUT', body: { name: card.querySelector('#mClassName').value } }); hideModal(); await reload(); toast('已保存', 'ok'); }
      catch (err) { toast(err.message, 'err'); }
    };
    card.querySelector('[data-mc=c]').onclick = hideModal;
  });
};
$('#delClassBtn').onclick = () => {
  const cls = state.classes.find(c => c.id === $('#stuClassSel').value); if (!cls) return toast('请先选择班级', 'err');
  confirmModal('删除班级', `确定删除班级 <b>${esc(cls.name)}</b> 及其学生名单？历史打分记录仍会保留。`, async () => {
    try { await api('/api/classes/' + cls.id, { method: 'DELETE' }); state.scoreClassId = ''; state.queryClassId = ''; await reload(); renderClassSels(); renderStudentGrid(); toast('已删除', 'ok'); }
    catch (err) { toast(err.message, 'err'); }
  });
};

/* ---------- 项目管理 ---------- */
function renderItemList() {
  const box = $('#itemList');
  box.innerHTML = state.items.length ? state.items.map(i => `<div class="list-item">
    <div class="list-main"><div class="list-title">${esc(i.name)} <span class="${i.type === 'sub' ? 'score-neg' : 'score-pos'}">${i.type === 'sub' ? '-' : '+'}${i.score}</span>${i.active ? '' : ' <span class="list-sub">（已停用）</span>'}</div></div>
    <button class="btn btn-light btn-sm" data-act="edit" data-iid="${i.id}">编辑</button>
    <button class="btn btn-light btn-sm" data-act="toggle" data-iid="${i.id}">${i.active ? '停用' : '启用'}</button>
    <button class="btn btn-light btn-sm danger-text" data-act="del" data-iid="${i.id}">删除</button>
  </div>`).join('') : '<div class="muted-tip">暂无项目</div>';
}
$('#itemList').addEventListener('click', e => {
  const btn = e.target.closest('button'); if (!btn) return;
  const iid = btn.dataset.iid, it = state.items.find(x => x.id === iid);
  const act = btn.dataset.act;
  if (act === 'edit') {
    showModal(`<h3>编辑项目</h3><div class="form-col">
      <label>名称</label><input id="mItemName" value="${esc(it.name)}">
      <label>类型</label><select id="mItemType"><option value="add" ${it.type !== 'sub' ? 'selected' : ''}>加分</option><option value="sub" ${it.type === 'sub' ? 'selected' : ''}>减分</option></select>
      <label>默认分值（正数）</label><input id="mItemScore" type="number" step="any" min="1" value="${it.score}">
      <div class="modal-actions"><button class="btn btn-light" data-mc="c">取消</button><button class="btn btn-primary" data-mc="s">保存</button></div></div>`, card => {
      card.querySelector('[data-mc=s]').onclick = async () => {
        try {
          await api('/api/items/' + iid, { method: 'PUT', body: { name: card.querySelector('#mItemName').value, type: card.querySelector('#mItemType').value, score: card.querySelector('#mItemScore').value } });
          hideModal(); await reload(); toast('已保存', 'ok');
        } catch (err) { toast(err.message, 'err'); }
      };
      card.querySelector('[data-mc=c]').onclick = hideModal;
    });
  } else if (act === 'toggle') {
    api('/api/items/' + iid, { method: 'PUT', body: { active: !it.active } }).then(() => reload()).catch(err => toast(err.message, 'err'));
  } else if (act === 'del') {
    confirmModal('删除项目', `确定删除项目 <b>${esc(it.name)}</b>？历史记录仍保留项目名。`, async () => {
      try { await api('/api/items/' + iid, { method: 'DELETE' }); await reload(); toast('已删除', 'ok'); } catch (err) { toast(err.message, 'err'); }
    });
  }
});
$('#addItemBtn').onclick = async () => {
  try {
    await api('/api/items', { body: { name: $('#itemNameInput').value, type: $('#itemTypeSel').value, score: $('#itemScoreInput').value } });
    $('#itemNameInput').value = ''; $('#itemScoreInput').value = '';
    await reload(); toast('项目已添加', 'ok');
  } catch (err) { toast(err.message, 'err'); }
};

/* ---------- 周期管理 ---------- */
function renderPeriodList() {
  const box = $('#periodList');
  box.innerHTML = state.periods.length ? state.periods.map(p => `<div class="list-item">
    <div class="list-main"><div class="list-title">${esc(p.name)}${p.id === state.currentPeriodId ? ' <span class="list-sub">（当前）</span>' : ''}</div></div>
    <button class="btn btn-light btn-sm" data-act="cur" data-pid="${p.id}">设为当前</button>
    <button class="btn btn-light btn-sm" data-act="edit" data-pid="${p.id}">重命名</button>
    <button class="btn btn-light btn-sm danger-text" data-act="del" data-pid="${p.id}">删除</button>
  </div>`).join('') : '<div class="muted-tip">暂无周期</div>';
}
$('#periodList').addEventListener('click', e => {
  const btn = e.target.closest('button'); if (!btn) return;
  const pid = btn.dataset.pid, p = state.periods.find(x => x.id === pid);
  if (btn.dataset.act === 'cur') {
    api('/api/periods/current', { body: { id: pid } }).then(() => { state.currentPeriodId = pid; reload(); }).catch(err => toast(err.message, 'err'));
  } else if (btn.dataset.act === 'edit') {
    showModal(`<h3>重命名周期</h3><div class="form-col"><label>名称</label><input id="mPeriodName" value="${esc(p.name)}">
      <div class="modal-actions"><button class="btn btn-light" data-mc="c">取消</button><button class="btn btn-primary" data-mc="s">保存</button></div></div>`, card => {
      card.querySelector('[data-mc=s]').onclick = async () => {
        try { await api('/api/periods/' + pid, { method: 'PUT', body: { name: card.querySelector('#mPeriodName').value } }); hideModal(); await reload(); toast('已保存', 'ok'); } catch (err) { toast(err.message, 'err'); }
      };
      card.querySelector('[data-mc=c]').onclick = hideModal;
    });
  } else if (btn.dataset.act === 'del') {
    confirmModal('删除周期', `确定删除周期 <b>${esc(p.name)}</b>？该周期历史记录仍保留但不再参与查询。`, async () => {
      try { await api('/api/periods/' + pid, { method: 'DELETE' }); await reload(); toast('已删除', 'ok'); } catch (err) { toast(err.message, 'err'); }
    });
  }
});
$('#addPeriodBtn').onclick = async () => {
  try { await api('/api/periods', { body: { name: $('#periodNameInput').value } }); $('#periodNameInput').value = ''; await reload(); toast('周期已添加', 'ok'); }
  catch (err) { toast(err.message, 'err'); }
};

function renderResetSels() {
  const p = $('#resetPeriodSel');
  p.innerHTML = state.periods.map(x => `<option value="${x.id}" ${x.id === state.currentPeriodId ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
  loadResetHistory();
}
async function loadResetHistory() {
  try {
    const d = await api('/api/resets');
    $('#resetHistory').innerHTML = d.resets.slice(0, 20).map(r => `<div>${r.timeText} · ${esc(r.className)} · ${esc(r.periodName)} 已重置</div>`).join('') || '<div>暂无重置记录</div>';
  } catch (e) { /* ignore */ }
}
$('#resetBtn').onclick = () => {
  const pid = $('#resetPeriodSel').value;
  const cid = $('#resetClassSel').value || null;
  const pname = ($('#resetPeriodSel').selectedOptions[0] || {}).textContent || '';
  const cname = cid ? ($('#resetClassSel').selectedOptions[0] || {}).textContent : '全部班级';
  confirmModal('重置周期统计', `将对 <b>${esc(cname)}</b> 的「${esc(pname)}」执行重置：当前统计分数清零，开始新一轮计分。<br>历史打分明细<b>永久保留</b>，可在查询导出中追溯。确认重置？`, async () => {
    try {
      await api('/api/reset', { body: { periodId: pid, classId: cid } });
      toast('已重置，开始新一轮计分', 'ok');
      renderStudentGrid(); loadResetHistory();
    } catch (err) { toast(err.message, 'err'); }
  }, '确认重置');
};

/* ---------- 查询导出 ---------- */
$('#queryClassSel').onchange = e => { state.queryClassId = e.target.value; };
function renderQueryPeriodChips() {
  if (!state.queryPeriods.size && state.currentPeriodId) state.queryPeriods.add(state.currentPeriodId);
  const box = $('#queryPeriodChips');
  box.innerHTML = state.periods.map(p => `<div class="chip ${state.queryPeriods.has(p.id) ? 'selected' : ''}" data-pid="${p.id}">${esc(p.name)}</div>`).join('') || '<div class="muted-tip">暂无周期</div>';
}
$('#queryPeriodChips').addEventListener('click', e => {
  const chip = e.target.closest('.chip'); if (!chip) return;
  const pid = chip.dataset.pid;
  if (state.queryPeriods.has(pid)) state.queryPeriods.delete(pid); else state.queryPeriods.add(pid);
  chip.classList.toggle('selected');
});
$('#queryBtn').onclick = async () => {
  if (!state.queryClassId) return toast('请选择班级', 'err');
  if (!state.queryPeriods.size) return toast('请至少选择一个周期', 'err');
  try {
    const d = await api(`/api/totals?classId=${state.queryClassId}&periodIds=${[...state.queryPeriods].join(',')}`);
    state.totals = d.rows; state.lastReset = d.lastReset;
    renderQueryResult(d.rows);
  } catch (err) { toast(err.message, 'err'); }
};
function renderQueryResult(rows) {
  const box = $('#queryResult');
  const periods = state.periods.filter(p => state.queryPeriods.has(p.id));
  const multi = periods.length > 1;
  if (!rows.length) { box.innerHTML = '<div class="query-empty muted-tip">该班级暂无学生</div>'; return; }
  const maxTotal = Math.max(...rows.map(r => Math.abs(r.total)), 1);
  box.innerHTML = `<div class="rank-table-wrap"><table class="rank-table">
    <thead><tr><th>排名</th><th>姓名</th><th>学号</th>${periods.map(p => `<th>${esc(p.name)}</th>`).join('')}${multi ? '<th>累计总分</th>' : '<th>总分</th>'}</tr></thead>
    <tbody>${rows.map(r => `<tr class="data-row" data-sid="${r.studentId}">
      <td class="${r.rank <= 3 ? 'rank-' + r.rank : ''}">${r.rank}</td>
      <td>${esc(r.name)}</td><td>${esc(r.studentNo || '')}</td>
      ${periods.map(p => `<td class="${(r.perPeriod[p.id] || 0) > 0 ? 'score-pos' : (r.perPeriod[p.id] || 0) < 0 ? 'score-neg' : ''}">${r.perPeriod[p.id] || 0}</td>`).join('')}
      <td class="total-cell ${r.total > 0 ? 'score-pos' : r.total < 0 ? 'score-neg' : ''}">${r.total}</td>
    </tr>`).join('')}</tbody></table></div>
    <div class="muted-tip">点击学生行查看打分明细（含重置前历史）</div>`;
  box.querySelectorAll('tr.data-row').forEach(tr => {
    tr.onclick = () => showStudentDetail(tr.dataset.sid);
  });
}
async function showStudentDetail(sid) {
  const stu = state.students.find(s => s.id === sid);
  const pids = [...state.queryPeriods];
  let allHtml = '';
  for (const pid of pids) {
    const pname = (state.periods.find(p => p.id === pid) || {}).name || '';
    const t = state.lastReset[pid] || 0;
    try {
      const d = await api(`/api/logs?classId=${state.queryClassId}&periodId=${pid}&studentId=${sid}`);
      const logs = d.logs;
      let html = '';
      if (!logs.length) html = '<div class="muted-tip">该周期暂无记录</div>';
      else {
        let resetShown = false;
        html = logs.map(l => {
          let mark = '';
          if (l.time <= t && !resetShown) {
            resetShown = true;
            mark = `<div class="log-reset-mark">—— 以下为重置前的历史记录，不计入本轮统计 ——</div>`;
          }
          return mark + `<div class="log-line" style="${l.time <= t ? 'opacity:.55' : ''}">
            <span class="t">${l.timeText}</span><span>${esc(l.itemName)}</span>
            <span class="${l.score > 0 ? 'score-pos' : 'score-neg'}">${l.score > 0 ? '+' : ''}${l.score}</span></div>`;
        }).join('');
      }
      allHtml += `<h3 style="font-size:15px;margin:10px 0 6px">${esc(stu ? stu.name : '')} · ${esc(pname)}</h3>${html}`;
    } catch (e) { /* ignore */ }
  }
  showModal(`<h3>打分明细</h3>${allHtml}<div class="modal-actions"><button class="btn btn-light" data-mc="c" style="flex:1">关闭</button></div>`, card => {
    card.querySelector('[data-mc=c]').onclick = hideModal;
  });
}
$('#exportBtn').onclick = () => {
  if (!state.queryClassId) return toast('请选择班级', 'err');
  if (!state.queryPeriods.size) return toast('请至少选择一个周期', 'err');
  const url = `/api/export?classId=${state.queryClassId}&periodIds=${[...state.queryPeriods].join(',')}&token=${state.token}`;
  location.href = url;
};

/* ---------- 消息发送 ---------- */
$('#msgSendBtn').onclick = async () => {
  const content = $('#msgInput').value.trim();
  if (!content) return toast('请输入消息内容', 'err');
  beep(660, 0.1, 1); // 用户手势内激活音频
  try {
    await api('/api/messages', { body: { content } });
    $('#msgInput').value = '';
    $('#receiptBanner').hidden = true;
    toast('已发送到教室客户端', 'ok');
    refreshMessages();
  } catch (err) { toast(err.message, 'err'); }
};
async function refreshMessages() {
  try {
    const d = await api('/api/messages');
    const box = $('#msgHistory');
    box.innerHTML = d.messages.slice(0, 50).map(m => `<div class="list-item msg-item">
      <div class="msg-content">${esc(m.content)}</div>
      <div style="text-align:right;min-width:130px"><div class="list-sub">${m.timeText}</div>
      <div class="msg-status ${m.status}">${m.status === 'received' ? '✓ 教室已确认 ' + m.receivedTimeText : '等待教室确认…'}</div></div>
    </div>`).join('') || '<div class="muted-tip">暂无发送记录</div>';
  } catch (e) { /* ignore */ }
}
function showReceiptBanner(timeText) {
  const b = $('#receiptBanner');
  b.textContent = `✓ 教室已点击「收到」（${timeText}）`;
  b.hidden = false;
  toast('教室已确认收到消息', 'ok');
  beep(990, 0.15, 3);
  refreshMessages();
}

/* ---------- WebSocket ---------- */
function connectWs() {
  if (state.ws) try { state.ws.close(); } catch (e) {}
  clearTimeout(state.wsTimer);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?token=${state.token}&role=web`);
  state.ws = ws;
  ws.onmessage = e => {
    try {
      const m = JSON.parse(e.data);
      if (m.type === 'receipt' && m.data) showReceiptBanner(m.data.timeText);
      if (m.type === 'message_sent') refreshMessages();
    } catch (err) { /* ignore */ }
  };
  ws.onclose = () => { state.wsTimer = setTimeout(() => { if (state.token) connectWs(); }, 4000); };
  ws.onerror = () => { try { ws.close(); } catch (e) {} };
}

/* ---------- 设置 ---------- */
function renderServerUrl() { $('#serverUrlShow').textContent = location.origin; }
$('#changePassBtn').onclick = async () => {
  try {
    const d = await api('/api/password', { body: { oldPassword: $('#oldPassInput').value, newPassword: $('#newPassInput').value } });
    state.token = d.token;
    localStorage.setItem('token', d.token);
    $('#oldPassInput').value = ''; $('#newPassInput').value = '';
    connectWs();
    toast('密码已修改，其他设备需重新登录', 'ok');
  } catch (err) { toast(err.message, 'err'); }
};

/* ---------- 数据备份 / 恢复 ---------- */
$('#backupBtn').onclick = async () => {
  try {
    const res = await fetch('/api/backup', { headers: { 'Authorization': 'Bearer ' + state.token } });
    if (!res.ok) throw new Error('备份下载失败');
    const blob = await res.blob();
    const a = document.createElement('a');
    const d = new Date(), p = n => String(n).padStart(2, '0');
    a.href = URL.createObjectURL(blob);
    a.download = `教学助手备份_${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('备份已下载，请妥善保存', 'ok');
  } catch (err) { toast(err.message, 'err'); }
};
$('#restoreFile').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  confirmModal('恢复备份数据', '将用备份文件<b>覆盖</b>服务器当前全部数据（班级、学生、积分历史、消息）。此操作不可撤销，确定继续？', async () => {
    try {
      const form = new FormData();
      form.append('file', file);
      const d = await api('/api/restore', { form });
      toast(`恢复成功：${d.counts.classes}个班级 / ${d.counts.students}名学生 / ${d.counts.logs}条打分记录`, 'ok');
      await reload();
      refreshMessages();
    } catch (err) { toast(err.message, 'err'); }
  }, '覆盖恢复');
});

/* ---------- 数据刷新 ---------- */
async function reload() {
  const d = await api('/api/bootstrap');
  Object.assign(state, d);
  renderAll();
}
