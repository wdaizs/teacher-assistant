/**
 * 小学数学教师教学助手 - 后端服务
 * 功能：教师登录、班级/学生/加分项目/计分周期管理、打分日志（不可删除）、
 *       周期重置（保留历史）、多周期累计查询、Excel导入导出、
 *       消息推送（WebSocket 长连接，Web端 <-> Windows教室客户端）
 * 数据存储（双模式）：
 *   云端模式：设置 TURSO_DATABASE_URL + TURSO_AUTH_TOKEN 环境变量后，
 *             数据存入 Turso 云数据库（云端 SQLite），服务器重启/重新部署数据不丢失；
 *             本地 JSON 文件仅作为镜像备份同步保留。
 *   本地模式：未设置环境变量时，数据存 server/data/db.json（原子写入）。
 *   首次以云端模式启动时，若 Turso 为空而本地 JSON 有数据，会自动把本地数据迁移上云。
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const WebSocket = require('ws');
const XLSX = require('xlsx');

const PORT = process.env.PORT || 8765;
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

const DEFAULT_DB = {
  username: 'teacher',
  passHash: sha256('123456'),
  token: crypto.randomBytes(24).toString('hex'),
  classes: [],      // {id, name}
  students: [],     // {id, classId, name, studentNo}
  items: [],        // {id, name, type:'add'|'sub', score, active}
  periods: [],      // {id, name}
  currentPeriodId: null,
  logs: [],         // 打分明细（永久保留，含快照字段）
  resets: [],       // 重置记录（永久保留）
  messages: [],     // 消息 + 回执（永久保留）
  seq: 1
};

let db;
if (fs.existsSync(DB_FILE)) {
  try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { db = null; }
}
if (!db) db = JSON.parse(JSON.stringify(DEFAULT_DB));
for (const k of Object.keys(DEFAULT_DB)) if (db[k] === undefined) db[k] = DEFAULT_DB[k];

// ---------------- Turso 云数据库适配层 ----------------
// 数据模型保持内存对象形式（读写即内存操作，性能无损），
// Turso 中用 kv 表整库存取（k='db'，v=全量JSON）。规模完全够用且事务简单可靠。
const TURSO_URL = process.env.TURSO_DATABASE_URL || '';
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN || '';
const USE_TURSO = !!TURSO_URL;
let turso = null;          // libsql client
let saveTimer = null;      // 防抖定时器
let flushing = false;
let pendingAfterFlush = false;

function localSave() {
  try {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
    fs.renameSync(tmp, DB_FILE);
  } catch (e) { /* 本地镜像写失败不影响主流程 */ }
}

async function flushTurso() {
  if (!turso || flushing) { pendingAfterFlush = true; return; }
  flushing = true;
  try {
    const payload = JSON.stringify(db);
    await turso.execute({
      sql: 'INSERT INTO kv (k, v, updated_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at',
      args: ['db', payload, Date.now()]
    });
  } catch (e) {
    console.error('[教师助手] Turso 写入失败（稍后将随下次保存重试）:', e.message);
  } finally {
    flushing = false;
    if (pendingAfterFlush) { pendingAfterFlush = false; scheduleTursoSave(); }
  }
}
function scheduleTursoSave() {
  if (!turso || saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; flushTurso(); }, 300);
}

// save()：同步更新本地镜像；Turso 模式下防抖异步落云（300ms 合并连续写入）
function save() {
  localSave();
  if (USE_TURSO) scheduleTursoSave();
}

async function initStorage() {
  if (!USE_TURSO) return;
  // Turso 有两种数据库：libsql://（经典 libSQL 引擎）与 turso://（新版 Turso 引擎）
  // 两者协议不同，按地址前缀自动选择对应客户端，接口一致（execute/getRows）
  const isNewEngine = TURSO_URL.startsWith('turso://');
  if (isNewEngine) {
    const { createClient } = require('@tursodatabase/serverless/compat');
    turso = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN || undefined });
  } else {
    const { createClient } = require('@libsql/client');
    turso = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN || undefined });
  }
  await turso.execute('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, updated_at INTEGER)');
  const rs = await turso.execute({ sql: 'SELECT v FROM kv WHERE k = ?', args: ['db'] });
  if (rs.rows.length) {
    // 云端有数据：以云端为准
    const cloud = JSON.parse(rs.rows[0].v);
    for (const k of Object.keys(DEFAULT_DB)) if (cloud[k] === undefined) cloud[k] = DEFAULT_DB[k];
    db = cloud;
    console.log('[教师助手] 已从 Turso 云数据库加载:', fmtTime(Date.now()));
  } else if (db.periods.length || db.logs.length || db.students.length || db.classes.length) {
    // 云端为空、本地有数据：自动迁移上云（一次性）
    await flushTurso();
    console.log('[教师助手] 本地数据已迁移至 Turso 云数据库');
  } else {
    await flushTurso(); // 全新库也落一次盘
  }
  localSave(); // 同步本地镜像
}

// 进程退出前把未落云的数据冲刷掉
async function flushOnExit() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (turso && (flushing || true)) { try { await flushTurso(); } catch (e) {} }
}
process.on('SIGTERM', () => flushOnExit().finally(() => process.exit(0)));
process.on('SIGINT', () => flushOnExit().finally(() => process.exit(0)));

// 首次运行：自动创建一个默认周期，方便直接打分
if (db.periods.length === 0) {
  const id = 'p' + (db.seq++);
  db.periods.push({ id, name: '当前计分周期' });
  db.currentPeriodId = id;
}
if (db.currentPeriodId && !db.periods.find(p => p.id === db.currentPeriodId)) {
  db.currentPeriodId = db.periods[0] ? db.periods[0].id : null;
}
save();

function nid() { return 'n' + (db.seq++); }
function now() { return Date.now(); }
function fmtTime(t) {
  const d = new Date(t);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const app = express();
app.use(express.json({ limit: '2mb' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
app.use(express.static(path.join(__dirname, 'public')));

// ---------------- 健康检查（无需鉴权，供云平台/保活监控使用）----------------
app.get('/api/health', (req, res) => res.json({
  ok: true, time: fmtTime(now()),
  storage: USE_TURSO ? (TURSO_URL.startsWith('turso://') ? 'turso-new' : 'turso-libsql') : 'file',
  connected: USE_TURSO ? !!turso : true
}));

// ---------------- 数据备份 / 恢复（云端部署磁盘不持久，用于灾备）----------------
app.get('/api/backup', auth, (req, res) => {
  const fname = encodeURIComponent(`教学助手备份_${fmtTime(now()).replace(/[: ]/g, '-')}.json`);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${fname}`);
  res.send(JSON.stringify(db));
});
app.post('/api/restore', auth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请选择备份文件(.json)' });
  let data;
  try { data = JSON.parse(req.file.buffer.toString('utf8')); } catch (e) {
    return res.status(400).json({ error: '文件不是有效的备份格式' });
  }
  if (!data || !Array.isArray(data.classes) || !Array.isArray(data.logs)) {
    return res.status(400).json({ error: '备份文件内容不完整，请使用本系统导出的备份' });
  }
  // 保留当前登录 token，恢复后不强制重新登录
  const keepToken = db.token;
  data.token = keepToken;
  for (const k of Object.keys(DEFAULT_DB)) if (data[k] === undefined) data[k] = DEFAULT_DB[k];
  db = data;
  save();
  res.json({ ok: true, counts: { classes: db.classes.length, students: db.students.length, logs: db.logs.length, messages: db.messages.length } });
});

// ---------------- 鉴权 ----------------
function auth(req, res, next) {
  const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.query.token;
  if (t && t === db.token) return next();
  return res.status(401).json({ error: '未登录或登录已失效，请重新登录' });
}

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (String(username || '').trim() !== db.username || sha256(password || '') !== db.passHash) {
    return res.status(400).json({ error: '账号或密码错误' });
  }
  // 每次登录刷新 token，踢掉旧会话（单教师账号）
  db.token = crypto.randomBytes(24).toString('hex');
  save();
  res.json({ token: db.token, username: db.username });
});

app.post('/api/password', auth, (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (sha256(oldPassword || '') !== db.passHash) return res.status(400).json({ error: '原密码错误' });
  if (!newPassword || String(newPassword).length < 4) return res.status(400).json({ error: '新密码至少4位' });
  db.passHash = sha256(newPassword);
  db.token = crypto.randomBytes(24).toString('hex'); // 改密后强制重新登录
  save();
  res.json({ ok: true, token: db.token });
});

app.get('/api/bootstrap', auth, (req, res) => {
  res.json({
    username: db.username,
    classes: db.classes,
    students: db.students,
    items: db.items,
    periods: db.periods,
    currentPeriodId: db.currentPeriodId
  });
});

// ---------------- 班级 ----------------
app.post('/api/classes', auth, (req, res) => {
  const name = String((req.body || {}).name || '').trim();
  if (!name) return res.status(400).json({ error: '班级名称不能为空' });
  if (db.classes.find(c => c.name === name)) return res.status(400).json({ error: '已存在同名班级' });
  const c = { id: nid(), name };
  db.classes.push(c); save();
  res.json(c);
});
app.put('/api/classes/:id', auth, (req, res) => {
  const c = db.classes.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: '班级不存在' });
  const name = String((req.body || {}).name || '').trim();
  if (!name) return res.status(400).json({ error: '班级名称不能为空' });
  c.name = name; save();
  res.json(c);
});
app.delete('/api/classes/:id', auth, (req, res) => {
  const i = db.classes.findIndex(x => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: '班级不存在' });
  db.classes.splice(i, 1);
  db.students = db.students.filter(s => s.classId !== req.params.id); // 历史日志保留快照
  save();
  res.json({ ok: true });
});

// ---------------- 学生 ----------------
app.post('/api/students', auth, (req, res) => {
  const { classId, name, studentNo } = req.body || {};
  const nameS = String(name || '').trim();
  if (!nameS) return res.status(400).json({ error: '学生姓名不能为空' });
  if (!db.classes.find(c => c.id === classId)) return res.status(400).json({ error: '请选择班级' });
  const s = { id: nid(), classId, name: nameS, studentNo: String(studentNo || '').trim() };
  db.students.push(s); save();
  res.json(s);
});
app.put('/api/students/:id', auth, (req, res) => {
  const s = db.students.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: '学生不存在' });
  const { name, studentNo, classId } = req.body || {};
  if (name !== undefined) {
    const n = String(name).trim();
    if (!n) return res.status(400).json({ error: '学生姓名不能为空' });
    s.name = n;
  }
  if (studentNo !== undefined) s.studentNo = String(studentNo).trim();
  if (classId !== undefined && db.classes.find(c => c.id === classId)) s.classId = classId;
  save();
  res.json(s);
});
app.delete('/api/students/:id', auth, (req, res) => {
  const i = db.students.findIndex(x => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: '学生不存在' });
  db.students.splice(i, 1); // 历史日志保留快照
  save();
  res.json({ ok: true });
});

// Excel 批量导入学生名单
app.post('/api/students/import', auth, upload.single('file'), (req, res) => {
  const classId = req.body.classId;
  if (!db.classes.find(c => c.id === classId)) return res.status(400).json({ error: '请选择班级' });
  if (!req.file) return res.status(400).json({ error: '请选择Excel文件' });
  let rows;
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  } catch (e) {
    return res.status(400).json({ error: '无法解析该Excel文件，请使用普通Excel格式(.xlsx/.xls)' });
  }
  // 寻找表头行（含“姓名”）
  let headerIdx = -1, nameCol = 0, noCol = -1;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const row = (rows[i] || []).map(c => String(c).trim());
    const ni = row.findIndex(c => c === '姓名' || c === '学生姓名' || c === '名字');
    if (ni >= 0) {
      headerIdx = i; nameCol = ni;
      noCol = row.findIndex(c => c === '学号' || c === '编号' || c === '座号' || c === '序号');
      break;
    }
  }
  const added = [], skipped = [];
  const existing = new Set(db.students.filter(s => s.classId === classId).map(s => s.name));
  const dataRows = headerIdx >= 0 ? rows.slice(headerIdx + 1) : rows;
  for (const row of dataRows) {
    if (!row || !row.length) continue;
    const name = String(row[nameCol] != null ? row[nameCol] : '').trim();
    if (!name || name === '姓名') continue;
    const no = noCol >= 0 && row[noCol] != null ? String(row[noCol]).trim() : (headerIdx < 0 && row[1] != null ? String(row[1]).trim() : '');
    if (existing.has(name)) { skipped.push(name); continue; }
    existing.add(name);
    const s = { id: nid(), classId, name, studentNo: no };
    db.students.push(s);
    added.push(s);
  }
  save();
  res.json({ added: added.length, skipped, students: added });
});

// 导入模板下载
app.get('/api/students/template', auth, (req, res) => {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([['姓名', '学号'], ['张三', '1'], ['李四', '2']]);
  XLSX.utils.book_append_sheet(wb, ws, '学生名单');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', "attachment; filename=student_template.xlsx");
  res.send(buf);
});

// ---------------- 加分/减分项目 ----------------
app.post('/api/items', auth, (req, res) => {
  const { name, score, type, active } = req.body || {};
  const nameS = String(name || '').trim();
  if (!nameS) return res.status(400).json({ error: '项目名称不能为空' });
  const sc = Number(score);
  if (!isFinite(sc) || sc <= 0) return res.status(400).json({ error: '默认分值必须为正数' });
  if (db.items.find(i => i.name === nameS)) return res.status(400).json({ error: '已存在同名项目' });
  const it = { id: nid(), name: nameS, type: type === 'sub' ? 'sub' : 'add', score: sc, active: active !== false };
  db.items.push(it); save();
  res.json(it);
});
app.put('/api/items/:id', auth, (req, res) => {
  const it = db.items.find(x => x.id === req.params.id);
  if (!it) return res.status(404).json({ error: '项目不存在' });
  const { name, score, type, active } = req.body || {};
  if (name !== undefined) {
    const n = String(name).trim();
    if (!n) return res.status(400).json({ error: '项目名称不能为空' });
    it.name = n;
  }
  if (score !== undefined) {
    const sc = Number(score);
    if (!isFinite(sc) || sc <= 0) return res.status(400).json({ error: '默认分值必须为正数' });
    it.score = sc;
  }
  if (type !== undefined) it.type = type === 'sub' ? 'sub' : 'add';
  if (active !== undefined) it.active = !!active;
  save();
  res.json(it);
});
app.delete('/api/items/:id', auth, (req, res) => {
  const i = db.items.findIndex(x => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: '项目不存在' });
  db.items.splice(i, 1); // 历史日志保留项目名快照
  save();
  res.json({ ok: true });
});

// ---------------- 计分周期 ----------------
app.post('/api/periods', auth, (req, res) => {
  const name = String((req.body || {}).name || '').trim();
  if (!name) return res.status(400).json({ error: '周期名称不能为空' });
  const p = { id: nid(), name };
  db.periods.push(p);
  if (!db.currentPeriodId) db.currentPeriodId = p.id;
  save();
  res.json(p);
});
app.put('/api/periods/:id', auth, (req, res) => {
  const p = db.periods.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: '周期不存在' });
  const name = String((req.body || {}).name || '').trim();
  if (!name) return res.status(400).json({ error: '周期名称不能为空' });
  p.name = name; save();
  res.json(p);
});
app.delete('/api/periods/:id', auth, (req, res) => {
  const i = db.periods.findIndex(x => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: '周期不存在' });
  db.periods.splice(i, 1);
  if (db.currentPeriodId === req.params.id) db.currentPeriodId = db.periods[0] ? db.periods[0].id : null;
  save();
  res.json({ ok: true });
});
app.post('/api/periods/current', auth, (req, res) => {
  const id = (req.body || {}).id;
  if (!db.periods.find(p => p.id === id)) return res.status(400).json({ error: '周期不存在' });
  db.currentPeriodId = id; save();
  res.json({ ok: true });
});

// ---------------- 打分 ----------------
app.post('/api/score', auth, (req, res) => {
  const { periodId, classId, itemId, score, studentIds, note } = req.body || {};
  const period = db.periods.find(p => p.id === periodId);
  const cls = db.classes.find(c => c.id === classId);
  if (!period) return res.status(400).json({ error: '请选择计分周期' });
  if (!cls) return res.status(400).json({ error: '请选择班级' });
  const sc = Number(score);
  if (!isFinite(sc) || sc === 0) return res.status(400).json({ error: '分值不能为空且不能为0' });
  if (!Array.isArray(studentIds) || !studentIds.length) return res.status(400).json({ error: '请选择学生' });
  let item = itemId ? db.items.find(i => i.id === itemId) : null;
  const t = now();
  const created = [];
  for (const sid of studentIds) {
    const stu = db.students.find(s => s.id === sid);
    if (!stu) continue;
    created.push({
      id: nid(), time: t,
      periodId: period.id, periodName: period.name,
      classId: cls.id, className: cls.name,
      studentId: stu.id, studentName: stu.name, studentNo: stu.studentNo || '',
      itemId: item ? item.id : '', itemName: item ? item.name : '自定义',
      score: sc, // 有符号分值：加分为正、减分为负
      note: String(note || '').trim()
    });
  }
  if (!created.length) return res.status(400).json({ error: '所选学生不存在' });
  db.logs.push(...created);
  save();
  res.json({ ok: true, count: created.length, logs: created });
});

// 明细日志查询（支持只看“重置后生效”部分）
app.get('/api/logs', auth, (req, res) => {
  const { classId, periodId, studentId, effective } = req.query;
  let list = db.logs;
  if (classId) list = list.filter(l => l.classId === classId);
  if (periodId) list = list.filter(l => l.periodId === periodId);
  if (studentId) list = list.filter(l => l.studentId === studentId);
  if (effective === '1' && periodId) {
    const cls = classId || (list[0] ? list[0].classId : null);
    const t = lastResetTime(periodId, classId || cls);
    list = list.filter(l => l.time > t);
  }
  list = list.slice().sort((a, b) => b.time - a.time).slice(0, 5000);
  res.json({ logs: list.map(l => ({ ...l, timeText: fmtTime(l.time) })) });
});

app.get('/api/resets', auth, (req, res) => {
  let list = db.resets;
  if (req.query.periodId) list = list.filter(r => r.periodId === req.query.periodId);
  res.json({ resets: list.slice().sort((a, b) => b.time - a.time).map(r => ({ ...r, timeText: fmtTime(r.time) })) });
});

// ---------------- 重置（只清统计，不删历史）----------------
function lastResetTime(periodId, classId) {
  let t = 0;
  for (const r of db.resets) {
    if (r.periodId === periodId && (r.classId === null || r.classId === classId)) {
      if (r.time > t) t = r.time;
    }
  }
  return t;
}

app.post('/api/reset', auth, (req, res) => {
  const { periodId, classId } = req.body || {}; // classId 为 null 表示全部班级
  const period = db.periods.find(p => p.id === periodId);
  if (!period) return res.status(400).json({ error: '请选择计分周期' });
  if (classId && !db.classes.find(c => c.id === classId)) return res.status(400).json({ error: '班级不存在' });
  const r = {
    id: nid(), time: now(),
    periodId: period.id, periodName: period.name,
    classId: classId || null,
    className: classId ? (db.classes.find(c => c.id === classId) || {}).name : '全部班级'
  };
  db.resets.push(r);
  save();
  res.json({ ok: true, reset: { ...r, timeText: fmtTime(r.time) } });
});

// ---------------- 汇总统计（单周期 / 多周期累计）----------------
app.get('/api/totals', auth, (req, res) => {
  const classId = req.query.classId;
  const periodIds = String(req.query.periodIds || '').split(',').filter(Boolean);
  if (!classId || !periodIds.length) return res.json({ rows: [], lastReset: {} });
  const students = db.students.filter(s => s.classId === classId);
  const rows = students.map(s => {
    const perPeriod = {}, perItem = {};
    let total = 0;
    for (const pid of periodIds) {
      const t = lastResetTime(pid, classId);
      let sum = 0;
      for (const l of db.logs) {
        if (l.periodId === pid && l.classId === classId && l.studentId === s.id && l.time > t) {
          sum += l.score; total += l.score;
          perItem[l.itemName] = (perItem[l.itemName] || 0) + l.score;
        }
      }
      perPeriod[pid] = sum;
    }
    return { studentId: s.id, name: s.name, studentNo: s.studentNo || '', perPeriod, perItem, total };
  });
  rows.sort((a, b) => b.total - a.total);
  rows.forEach((r, i) => r.rank = i + 1);
  const lastReset = {};
  for (const pid of periodIds) lastReset[pid] = lastResetTime(pid, classId);
  res.json({ rows, lastReset });
});

// ---------------- Excel 导出 ----------------
app.get('/api/export', auth, (req, res) => {
  const classId = req.query.classId;
  const periodIds = String(req.query.periodIds || '').split(',').filter(Boolean);
  const cls = db.classes.find(c => c.id === classId);
  if (!cls) return res.status(400).json({ error: '请选择班级' });
  const periods = periodIds.map(pid => db.periods.find(p => p.id === pid)).filter(Boolean);
  if (!periods.length) return res.status(400).json({ error: '请选择计分周期' });

  const { rows } = (function compute() {
    const students = db.students.filter(s => s.classId === classId);
    const rws = students.map(s => {
      const perPeriod = {}, perItem = {};
      let total = 0;
      for (const p of periods) {
        const t = lastResetTime(p.id, classId);
        let sum = 0;
        for (const l of db.logs) {
          if (l.periodId === p.id && l.classId === classId && l.studentId === s.id && l.time > t) {
            sum += l.score; total += l.score;
            perItem[l.itemName] = (perItem[l.itemName] || 0) + l.score;
          }
        }
        perPeriod[p.id] = sum;
      }
      return { studentId: s.id, name: s.name, studentNo: s.studentNo || '', perPeriod, perItem, total };
    });
    rws.sort((a, b) => b.total - a.total);
    rws.forEach((r, i) => r.rank = i + 1);
    return { rows: rws };
  })();

  const itemNames = [...new Set(rows.flatMap(r => Object.keys(r.perItem)))];
  const wb = XLSX.utils.book_new();

  // Sheet1: 汇总
  const header = ['排名', '学号', '姓名', ...periods.map(p => p.name), ...itemNames, '总分'];
  const aoa = [header];
  for (const r of rows) {
    aoa.push([
      r.rank, r.studentNo, r.name,
      ...periods.map(p => r.perPeriod[p.id] || 0),
      ...itemNames.map(n => r.perItem[n] || 0),
      r.total
    ]);
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), '汇总');

  // Sheet2: 明细（重置后生效的打分记录）
  const detail = [['时间', '班级', '学号', '姓名', '周期', '项目', '分值', '备注']];
  const logsAll = [];
  for (const p of periods) {
    const t = lastResetTime(p.id, classId);
    for (const l of db.logs) {
      if (l.periodId === p.id && l.classId === classId && l.time > t) logsAll.push(l);
    }
  }
  logsAll.sort((a, b) => a.time - b.time);
  for (const l of logsAll) detail.push([fmtTime(l.time), l.className, l.studentNo, l.studentName, l.periodName, l.itemName, l.score, l.note || '']);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(detail), '打分明细');

  // Sheet3: 全部历史原始记录（含已重置部分，永久追溯）
  const history = [['时间', '班级', '学号', '姓名', '周期', '项目', '分值', '备注', '是否计入当前统计']];
  const histLogs = db.logs.filter(l => l.classId === classId && periodIds.includes(l.periodId)).sort((a, b) => a.time - b.time);
  for (const l of histLogs) {
    const eff = l.time > lastResetTime(l.periodId, classId);
    history.push([fmtTime(l.time), l.className, l.studentNo, l.studentName, l.periodName, l.itemName, l.score, l.note || '', eff ? '是' : '否(已被重置)']);
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(history), '全部历史记录');

  // Sheet4: 重置记录
  const resets = [['时间', '班级', '周期']];
  for (const r of db.resets) {
    if (periodIds.includes(r.periodId) && (r.classId === null || r.classId === classId)) {
      resets.push([fmtTime(r.time), r.className, r.periodName]);
    }
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(resets), '重置记录');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const fname = encodeURIComponent(`${cls.name}_${periods.map(p => p.name).join('+')}_积分导出.xlsx`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${fname}`);
  res.send(buf);
});

// ---------------- 消息（手机网页 -> Windows教室客户端）----------------
app.get('/api/messages', auth, (req, res) => {
  res.json({ messages: db.messages.slice().sort((a, b) => b.time - a.time).map(m => ({ ...m, timeText: fmtTime(m.time), receivedTimeText: m.receivedAt ? fmtTime(m.receivedAt) : '' })) });
});

app.post('/api/messages', auth, (req, res) => {
  const content = String((req.body || {}).content || '').trim();
  if (!content) return res.status(400).json({ error: '消息内容不能为空' });
  if (content.length > 2000) return res.status(400).json({ error: '消息内容过长（最多2000字）' });
  const m = { id: nid(), time: now(), content, status: 'pending', receivedAt: null };
  db.messages.push(m); save();
  pushToClient({ type: 'message', data: { ...m, timeText: fmtTime(m.time) } });
  broadcastToWebs({ type: 'message_sent', data: { ...m, timeText: fmtTime(m.time) } });
  res.json({ ok: true, message: { ...m, timeText: fmtTime(m.time) } });
});

function markReceived(id) {
  const m = db.messages.find(x => x.id === id);
  if (!m || m.status === 'received') return m;
  m.status = 'received';
  m.receivedAt = now();
  save();
  broadcastToWebs({ type: 'receipt', data: { id: m.id, receivedAt: m.receivedAt, timeText: fmtTime(m.receivedAt) } });
  return m;
}
app.post('/api/messages/:id/receipt', auth, (req, res) => {
  const m = markReceived(req.params.id);
  if (!m) return res.status(404).json({ error: '消息不存在' });
  res.json({ ok: true });
});

// ---------------- WebSocket 长连接 ----------------
const state = { clientWs: null, webSockets: new Set() };

function pushToClient(payload) {
  const ws = state.clientWs;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
    return true;
  }
  return false; // 客户端离线，消息保持 pending，客户端上线后补推
}
function broadcastToWebs(payload) {
  for (const ws of state.webSockets) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  }
}

let httpServer;
(async function main() {
  if (USE_TURSO) {
    try {
      await initStorage();
    } catch (e) {
      console.error('[教师助手] Turso 初始化失败，本次运行改用本地文件模式:', e.message);
      turso = null; // 回退本地模式（save 不再尝试落云，本地镜像仍在写）
    }
  }
  httpServer = app.listen(PORT, () => {
    console.log(`[教师助手] 后端服务已启动: http://localhost:${PORT}`);
    const mode = USE_TURSO && turso ? `Turso 云数据库（持久） ${TURSO_URL}` : '本地文件 ' + DB_FILE;
    console.log(`[教师助手] 数据存储: ${mode}`);
  });
  attachWsUpgrade();
})();

const wss = new WebSocket.Server({ noServer: true });
function attachWsUpgrade() {
httpServer.on('upgrade', (req, socket, head) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch (e) { socket.destroy(); return; }
  const token = url.searchParams.get('token');
  const role = url.searchParams.get('role');
  if (!token || token !== db.token) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => {
    ws.role = role;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    if (role === 'client') {
      if (state.clientWs && state.clientWs !== ws && state.clientWs.readyState === WebSocket.OPEN) {
        state.clientWs.close(); // 一个账号只绑定一台教室客户端，新连接替换旧连接
      }
      state.clientWs = ws;
      // 补推未确认的消息
      for (const m of db.messages) {
        if (m.status === 'pending') ws.send(JSON.stringify({ type: 'message', data: { ...m, timeText: fmtTime(m.time) } }));
      }
      console.log('[教师助手] 教室客户端已连接');
      ws.on('message', raw => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'receipt' && msg.id) {
            markReceived(msg.id);
            const ack = { type: 'receipt_ack', id: msg.id };
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(ack));
          }
        } catch (e) { /* ignore */ }
      });
      ws.on('close', () => { if (state.clientWs === ws) state.clientWs = null; });
    } else {
      state.webSockets.add(ws);
      ws.on('close', () => state.webSockets.delete(ws));
    }
  });
});
}

// 心跳检测，清理死连接
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);
