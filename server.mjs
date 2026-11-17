/**
 * 万能翻唱 · 本地网页应用后端
 * ------------------------------------------------------------------
 * 零外部依赖：只用 Node 24 内建模块（http / fetch / child_process / fs）。
 * 流水线复用 dsh-cover 的三个 Python 脚本（scripts/ 下自包含副本，
 * 避开 pnpm file: 软链路径坑）。浏览器打开 http://127.0.0.1:18321 即可用。
 *
 * 架构：
 *   浏览器 (public/index.html)
 *     └─ HTTP API ─> server.mjs
 *                      ├─ 取源：本地上传 / B站搜索下载 (bili.mjs)
 *                      ├─ 五阶段流水线：download→separate→convert→mix→export
 *                      └─ 状态落 data/runs/<id>/run.json，日志 log.txt
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import {
  appendFileSync, copyFileSync, createReadStream, existsSync, mkdirSync,
  readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { audioUrl, extractBvid, pickBest, search } from './bili.mjs';
import { checkEnv, startDownload, downloadStatus, buildScript } from './env-manager.mjs';
import { CONFIG, PORT } from './config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1';

/** 重资产依赖路径（来自 config.local.json / config.example.json / 内置默认） */
const CFG = {
  voicesDir: `${CONFIG.songs}/voices`,
  runsDir: join(HERE, 'data', 'runs'),
  uploadsDir: join(HERE, 'data', 'uploads'),
  scriptsDir: join(HERE, 'scripts'),
  publicDir: join(HERE, 'public'),
  pythonExe: `${CONFIG.gst}/runtime/python.exe`,
  ffmpeg: `${CONFIG.gst}/ffmpeg.exe`,
  ffprobe: `${CONFIG.gst}/ffprobe.exe`,
  seedVcRepo: `${CONFIG.songs}/src/seed-vc-hf`,
  pyLibs: `${CONFIG.songs}/env/pylibs`,
  modelsDir: CONFIG.models,
  uvr5Dir: `${CONFIG.gst}/tools/uvr5`,
  diffusionSteps: 30,
  cfgRate: 0.7,
  targetLufs: '-14',
  mp3Bitrate: '192k',
  previewSeconds: 40,
  timeout: { download: 30 * 60e3, separate: 30 * 60e3, convert: 90 * 60e3, mix: 10 * 60e3 },
  rejectWords: ['伴奏', 'off vocal', 'offvocal', '纯音乐', 'instrumental', '钢琴', 'piano', '教程', '教学', '空耳', '学唱', '吉他', '八音盒', 'remix', 'dj', '谱', '扒谱', '剪辑', '合集', '片段'],
  preferWords: ['原曲', '原版', 'mv', 'official', '官方', '完整版', '高音质'],
};
for (const d of [CFG.voicesDir, CFG.runsDir, CFG.uploadsDir, CFG.publicDir]) {
  try { mkdirSync(d, { recursive: true }); } catch { /* 已存在 */ }
}

const PY_ENV = {
  DSH_COVER_REPO: CFG.seedVcRepo,
  DSH_COVER_PYLIBS: CFG.pyLibs,
  DSH_COVER_WORKROOT: CFG.modelsDir,
  DSH_COVER_FFMPEG: CFG.ffmpeg,
  DSH_COVER_FFPROBE: CFG.ffprobe,
  DSH_COVER_UVR5: CFG.uvr5Dir,
};

// ---------------------------------------------------------------- run state
const jobs = new Map();            // id -> state（内存索引，落盘为准）
const queue = [];                  // 待跑 id
let running = false;

function newRunId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${Math.random().toString(36).slice(2, 6)}`;
}
const runDir = (id) => join(CFG.runsDir, id);
function writeRun(dir, state) {
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, 'run.json.tmp');
  const body = { ...state, updatedAt: new Date().toISOString() };
  writeFileSync(tmp, JSON.stringify(body, null, 2), 'utf8');
  renameSync(tmp, join(dir, 'run.json'));
  return body;
}
function readRun(dir) {
  const p = join(dir, 'run.json');
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}
function log(dir, line) {
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'log.txt'), `[${new Date().toISOString().slice(11, 19)}] ${line}\n`, 'utf8');
  } catch { /* 日志失败不影响主流程 */ }
}
function setStage(dir, state, name, status) {
  const stages = Array.isArray(state.stages) ? state.stages.slice() : [];
  const i = stages.findIndex((s) => s.name === name);
  const now = new Date().toISOString();
  const patch = { name, status };
  if (i >= 0) {
    stages[i] = { ...stages[i], ...patch };
    if (status === 'running' && !stages[i].startedAt) stages[i].startedAt = now;
    if (status === 'done' || status === 'failed') stages[i].endedAt = now;
  } else {
    stages.push({ ...patch, startedAt: now, ...(status === 'done' || status === 'failed' ? { endedAt: now } : {}) });
  }
  state.stages = stages;
  state.stage = name;
  if (status === 'running') state.status = 'running';
  writeRun(dir, state);
  log(dir, `[stage] ${name} -> ${status}`);
}
function finish(dir, state, status, extra = {}) {
  Object.assign(state, extra, { status, finishedAt: new Date().toISOString() });
  writeRun(dir, state);
}

// 启动时从磁盘恢复任务索引
for (const n of readdirSync(CFG.runsDir)) {
  const r = readRun(join(CFG.runsDir, n));
  if (r) jobs.set(r.id, r);
}

// ---------------------------------------------------------------- subprocess
function run(cmd, argv, { timeout = 30 * 60e3, env, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const dir = argv.__dir || null;
    log(dir, `$ ${basename(cmd)} ${argv.filter((a) => typeof a === 'string').map((a) => (a.length > 140 ? a.slice(0, 140) + '…' : a)).join(' ')}`);
    const child = spawn(cmd, argv.filter((a) => typeof a === 'string'), {
      cwd, windowsHide: true,
      env: env ? { ...process.env, ...env } : process.env,
    });
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, timeout);
    const onData = (buf) => {
      const text = buf.toString('utf8');
      for (const line of text.split(/\r?\n/)) if (line.trim()) log(dir, '  ' + line.trim());
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => { clearTimeout(timer); reject(new Error('启动失败 ' + cmd + ': ' + e.message)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) return reject(new Error('超时（' + Math.round(timeout / 60000) + ' 分钟）'));
      if (code !== 0) return reject(new Error('退出码 ' + code));
      resolve();
    });
  });
}
function newestWav(directory) {
  if (!existsSync(directory)) return null;
  const files = readdirSync(directory)
    .filter((f) => f.toLowerCase().endsWith('.wav'))
    .map((f) => join(directory, f))
    .filter((p) => { try { return statSync(p).size > 1024; } catch { return false; } });
  if (!files.length) return null;
  files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return files[0];
}
const safeName = (s) => String(s || 'cover').replace(/[\\/:*?"<>|\r\n]/g, '_').replace(/\s+/g, '_').slice(0, 60) || 'cover';

// ---------------------------------------------------------------- pipeline
async function runPipeline(id) {
  const dir = runDir(id);
  const state = jobs.get(id);
  if (!state) return;
  const src = state.source || {};
  const argvDir = { __dir: dir };

  try {
    state.status = 'running';
    writeRun(dir, state);

    // 1. download：本地上传 or B站
    setStage(dir, state, 'download', 'running');
    const sourceWav = join(dir, 'source.wav');
    let title = src.title || 'cover';
    if (src.kind === 'file') {
      if (!existsSync(src.file)) throw new Error('源文件不存在：' + src.file);
      log(dir, '源文件：' + src.file);
      const a = ['-y', '-v', 'error', '-i', src.file, '-vn', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', sourceWav]; a.__dir = dir;
      await run(CFG.ffmpeg, a, { timeout: CFG.timeout.download });
    } else {
      let bvid = src.bvid || extractBvid(src.query || '');
      if (!bvid && src.query) {
        log(dir, '搜索：' + src.query);
        const list = await search(src.query);
        const { pick } = pickBest(list, CFG);
        if (!pick) throw new Error('没搜到可用的候选：' + src.query);
        bvid = pick.bvid; title = pick.title;
        log(dir, '选中 ' + bvid + ' 《' + pick.title + '》');
      }
      if (!bvid) throw new Error('需要本地文件或 B站歌名/BV号');
      const info = await audioUrl(bvid);
      log(dir, '音轨 ' + Math.round(info.bandwidth / 1000) + 'kbps / ' + info.duration + 's');
      const header = 'Referer: ' + info.referer + '\r\nUser-Agent: Mozilla/5.0\r\n';
      const a = ['-y', '-v', 'error', '-headers', header, '-i', info.url, '-vn', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', sourceWav]; a.__dir = dir;
      await run(CFG.ffmpeg, a, { timeout: CFG.timeout.download });
    }
    if (!existsSync(sourceWav)) throw new Error('取源后没有 source.wav');
    state.meta = { title, source: src.kind };
    log(dir, '源音频就绪');

    // 预览模式：截一段快速验证
    let workSource = sourceWav;
    if (state.preview) {
      let from = Number(state.previewFrom) > 0 ? Number(state.previewFrom) : 60;
      const secs = Number(state.previewSeconds) > 0 ? Number(state.previewSeconds) : CFG.previewSeconds;
      const clip = join(dir, 'source_preview.wav');
      const cut = async (start) => {
        const a = ['-y', '-v', 'error', '-ss', String(start), '-t', String(secs), '-i', sourceWav, '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', clip]; a.__dir = dir;
        await run(CFG.ffmpeg, a, { timeout: 5 * 60e3 });
      };
      await cut(from);
      // 起点超出音频长度会截出空文件（几十字节）——回退从 0s 截
      const clipSize = () => { try { return existsSync(clip) ? statSync(clip).size : 0; } catch { return 0; } };
      if (clipSize() < 4096 && from > 0) {
        log(dir, '预览起点 ' + from + 's 超出音频长度，回退从 0s 截取');
        from = 0;
        await cut(0);
      }
      if (clipSize() < 4096) throw new Error('预览片段截取失败，源文件可能损坏');
      workSource = clip;
      state.meta.preview = { from, seconds: secs };
      log(dir, '预览片段 ' + from + 's 起 ' + secs + 's（' + Math.round(clipSize() / 1024) + ' KB）');
    }
    setStage(dir, state, 'download', 'done');

    // 2. separate：人声 / 伴奏
    setStage(dir, state, 'separate', 'running');
    const sepDir = join(dir, 'sep'); mkdirSync(sepDir, { recursive: true });
    let a = [join(CFG.scriptsDir, 'separate.py'), workSource, sepDir]; a.__dir = dir;
    await run(CFG.pythonExe, a, { timeout: CFG.timeout.separate, env: PY_ENV });
    const vocal = newestWav(join(sepDir, 'vocals'));
    let inst = newestWav(join(sepDir, 'instrumental'));
    if (!vocal) throw new Error('人声分离没产出 vocals/*.wav');
    if (!inst) throw new Error('人声分离没产出 instrumental/*.wav');
    setStage(dir, state, 'separate', 'done');

    // 3. convert：换声（复制音色）
    setStage(dir, state, 'convert', 'running');
    const ref = join(CFG.voicesDir, String(state.voice || 'dsh_main'), 'reference.wav');
    if (!existsSync(ref)) throw new Error('音色不存在：' + ref);
    const vcDir = join(dir, 'vc'); mkdirSync(vcDir, { recursive: true });
    const steps = Number(state.steps) > 0 ? Number(state.steps) : CFG.diffusionSteps;
    const cfgRate = Number(state.cfgRate) > 0 ? Number(state.cfgRate) : CFG.cfgRate;
    // 破音修复：把 Seed-VC 的降调 / 自动音域适配参数透传下去
    const pitchShift = Number.isFinite(Number(state.pitchShift)) ? Math.trunc(Number(state.pitchShift)) : 0;
    const autoF0 = state.autoF0 === 'True' ? 'True' : 'False';
    a = [join(CFG.scriptsDir, 'run_svc.py'), '--source', vocal, '--target', ref, '--output', vcDir,
      '--f0-condition', 'True', '--diffusion-steps', String(steps),
      '--inference-cfg-rate', String(cfgRate), '--fp16', 'True',
      '--semi-tone-shift', String(pitchShift), '--auto-f0-adjust', autoF0]; a.__dir = dir;
    await run(CFG.pythonExe, a, { timeout: CFG.timeout.convert, env: PY_ENV });
    const converted = newestWav(vcDir);
    if (!converted) throw new Error('换声没产出 vc/*.wav');
    setStage(dir, state, 'convert', 'done');

    // 4. mix：换声人声 + 伴奏
    setStage(dir, state, 'mix', 'running');
    const outDir = join(dir, 'out'); mkdirSync(outDir, { recursive: true });

    // 伴奏同步降调：人声移了 pitchShift 个半音，伴奏必须一起移，否则合起来走调
    let instForMix = inst;
    if (pitchShift !== 0 && inst) {
      const factor = Math.pow(2, pitchShift / 12);
      const shifted = join(dir, 'inst_shifted.wav');
      const sh = ['-y', '-v', 'error', '-i', inst,
        '-af', 'asetrate=44100*' + factor + ',aresample=44100',
        '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', shifted]; sh.__dir = dir;
      try {
        await run(CFG.ffmpeg, sh, { timeout: 5 * 60e3 });
        if (existsSync(shifted) && statSync(shifted).size > 4096) {
          instForMix = shifted;
          log(dir, '伴奏同步移调 ' + pitchShift + ' 半音（与人声一致，避免走调）');
        } else log(dir, '伴奏移调产出异常，沿用原伴奏');
      } catch (e) { log(dir, '伴奏移调失败，沿用原伴奏：' + e.message); }
    }

    const mixWav = join(outDir, safeName(title) + '_dsh_voice.wav');
    a = [join(CFG.scriptsDir, 'mix.py'), converted, instForMix, mixWav, String(state.gain || 0), CFG.targetLufs]; a.__dir = dir;
    await run(CFG.pythonExe, a, { timeout: CFG.timeout.mix, env: PY_ENV });
    setStage(dir, state, 'mix', 'done');

    // 5. export：mp3 + 纯人声
    setStage(dir, state, 'export', 'running');
    const mp3 = mixWav.replace(/\.wav$/i, '.mp3');
    a = ['-y', '-v', 'error', '-i', mixWav, '-c:a', 'libmp3lame', '-b:a', CFG.mp3Bitrate, mp3]; a.__dir = dir;
    await run(CFG.ffmpeg, a, { timeout: CFG.timeout.mix });
    const vocalOut = join(outDir, safeName(title) + '_纯人声.wav');
    try { copyFileSync(converted, vocalOut); } catch { /* 可选 */ }
    setStage(dir, state, 'export', 'done');

    finish(dir, state, 'done', {
      outputs: { mp3, wav: mixWav, vocal: existsSync(vocalOut) ? vocalOut : null, dir: outDir },
    });
    log(dir, '完成：' + mp3);
  } catch (e) {
    log(dir, '失败：' + e.message);
    finish(dir, state, 'failed', { error: e.message });
  }
}

function submit(state) {
  jobs.set(state.id, state);
  queue.push(state.id);
  writeRun(runDir(state.id), state);
  pump();
}
async function pump() {
  if (running) return;
  running = true;
  while (queue.length) {
    const id = queue.shift();
    const st = jobs.get(id);
    if (!st || st.status === 'done' || st.status === 'failed') continue;
    await runPipeline(id);
  }
  running = false;
}

// ---------------------------------------------------------------- multipart
function parseMultipart(buf, boundary) {
  const parts = [];
  const delim = Buffer.from('--' + boundary);
  const nextDelim = Buffer.from('\r\n--' + boundary);
  let pos = 0;
  while (pos < buf.length) {
    const start = buf.indexOf(delim, pos);
    if (start < 0) break;
    let p = start + delim.length;
    if (buf[p] === 13 && buf[p + 1] === 10) p += 2;
    if (buf[p] === 45 && buf[p + 1] === 45) break; // closing --
    const headerEnd = buf.indexOf(Buffer.from('\r\n\r\n'), p);
    if (headerEnd < 0) break;
    const headerText = buf.slice(p, headerEnd).toString('utf8');
    const bodyStart = headerEnd + 4;
    const end = buf.indexOf(nextDelim, bodyStart);
    const bodyEnd = end < 0 ? buf.length : end;
    const body = buf.slice(bodyStart, bodyEnd);
    const cd = /Content-Disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/i.exec(headerText);
    const ct = /Content-Type:\s*([^\r\n]+)/i.exec(headerText);
    if (cd) parts.push({ name: cd[1], filename: cd[2] || null, contentType: ct ? ct[1].trim() : 'application/octet-stream', data: body });
    pos = bodyEnd;
    if (end < 0) break;
  }
  return parts;
}

// ---------------------------------------------------------------- HTTP helpers
const json = (res, obj, code = 200) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
};
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon' };
function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  // 兼容用户手动改名：public/ 没了、前端叫「这个也行.html」时也能打开
  const candidates = [join(CFG.publicDir, rel), join(HERE, rel)];
  if (rel === 'index.html') candidates.push(join(HERE, '这个也行.html'));
  const file = candidates.find((f) => f.startsWith(HERE) && existsSync(f));
  if (!file) { json(res, { ok: false, error: 'not found' }, 404); return; }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
  createReadStream(file).pipe(res);
}

// ---------------------------------------------------------------- routes
async function handle(req, res) {
  const u = new URL(req.url, 'http://' + HOST);
  const path = u.pathname;
  const method = req.method;

  try {
    // 音色库
    if (path === '/api/voices' && method === 'GET') {
      const list = [];
      for (const n of readdirSync(CFG.voicesDir)) {
        const p = join(CFG.voicesDir, n, 'reference.wav');
        try { if (statSync(p).size > 1024) list.push({ name: n, ref: p }); } catch { /* skip */ }
      }
      return json(res, { ok: true, voices: list });
    }
    if (path === '/api/voices/upload' && method === 'POST') {
      const buf = await readBody(req);
      const ct = req.headers['content-type'] || '';
      const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(ct);
      if (!m) return json(res, { ok: false, error: '需要 multipart' }, 400);
      const parts = parseMultipart(buf, (m[1] || m[2]).trim());
      const namePart = parts.find((p) => p.name === 'name');
      const filePart = parts.find((p) => p.filename);
      if (!namePart || !filePart) return json(res, { ok: false, error: '缺 name 或 file' }, 400);
      const name = namePart.data.toString('utf8').trim().replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]/g, '_').slice(0, 40);
      if (!name) return json(res, { ok: false, error: '音色名无效' }, 400);
      const dest = join(CFG.voicesDir, name); mkdirSync(dest, { recursive: true });
      const ref = join(dest, 'reference.wav');
      writeFileSync(ref, filePart.data);
      return json(res, { ok: true, name, ref, size: filePart.data.length });
    }

    // B站搜索（返回候选让用户挑）
    if (path === '/api/source/search' && method === 'GET') {
      const q = (u.searchParams.get('q') || '').trim();
      if (!q) return json(res, { ok: true, candidates: [] });
      const list = await search(q);
      const { ranked } = pickBest(list, CFG);
      return json(res, { ok: true, candidates: ranked.slice(0, 8).map((r) => ({ bvid: r.bvid, title: r.title, author: r.author, duration: r.duration, score: Math.round(r.score) })) });
    }
    // 本地音频上传
    if (path === '/api/source/upload' && method === 'POST') {
      const buf = await readBody(req);
      const ct = req.headers['content-type'] || '';
      const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(ct);
      if (!m) return json(res, { ok: false, error: '需要 multipart' }, 400);
      const parts = parseMultipart(buf, (m[1] || m[2]).trim());
      const filePart = parts.find((p) => p.filename);
      if (!filePart) return json(res, { ok: false, error: '没有文件' }, 400);
      const ext = extname(filePart.filename) || '.audio';
      const name = Date.now() + '_' + Math.random().toString(36).slice(2, 6) + ext;
      const dest = join(CFG.uploadsDir, name);
      writeFileSync(dest, filePart.data);
      return json(res, { ok: true, file: dest, name: filePart.filename, size: filePart.data.length });
    }

    // 起任务
    if (path === '/api/sing' && method === 'POST') {
      const body = await readBody(req);
      const args = JSON.parse(body.toString('utf8') || '{}');
      const src = args.source || {};
      if (!src.file && !src.bvid && !src.query) return json(res, { ok: false, error: '需要本地文件、B站链接或歌名' }, 400);
      if (!existsSync(CFG.pythonExe)) return json(res, { ok: false, error: 'Python 不存在：' + CFG.pythonExe }, 500);
      const id = newRunId();
      const state = {
        id, createdAt: new Date().toISOString(), status: 'queued', stage: null, stages: [],
        source: src, voice: args.voice || 'dsh_main',
        preview: !!args.preview, previewFrom: args.previewFrom, previewSeconds: args.previewSeconds,
        steps: args.steps, cfgRate: args.cfgRate, gain: args.gain,
        pitchShift: args.pitchShift, autoF0: args.autoF0,
        meta: null, outputs: null, error: null,
      };
      submit(state);
      return json(res, { ok: true, runId: id, dir: runDir(id), queued: queue.length });
    }

    // 查状态
    if (path === '/api/status' && method === 'GET') {
      const id = u.searchParams.get('id');
      if (!id) {
        const runs = [...jobs.values()].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).slice(0, 12);
        return json(res, { ok: true, runs: runs.map((r) => ({ id: r.id, status: r.status, stage: r.stage, title: r.meta?.title, createdAt: r.createdAt, error: r.error })) });
      }
      const st = jobs.get(id) || readRun(runDir(id));
      if (!st) return json(res, { ok: false, error: '没有这个任务' }, 404);
      return json(res, { ok: true, run: st, queuePos: queue.indexOf(id) });
    }
    // 日志
    if (path === '/api/log' && method === 'GET') {
      const id = u.searchParams.get('id');
      const p = join(runDir(id || ''), 'log.txt');
      if (!existsSync(p)) return json(res, { ok: true, text: '(暂无日志)' });
      const text = readFileSync(p, 'utf8');
      return json(res, { ok: true, text: text.slice(-8000) });
    }
    // 下载成品
    if (path === '/api/download' && method === 'GET') {
      const id = u.searchParams.get('id');
      const which = u.searchParams.get('file') || 'mp3';
      const st = jobs.get(id) || readRun(runDir(id || ''));
      const f = st?.outputs?.[which];
      if (!f || !existsSync(f)) return json(res, { ok: false, error: '成品不存在' }, 404);
      res.writeHead(200, {
        'Content-Type': which === 'mp3' ? 'audio/mpeg' : 'audio/wav',
        'Content-Disposition': 'attachment; filename="' + safeName(basename(f)) + '"',
        'Content-Length': statSync(f).size,
      });
      return createReadStream(f).pipe(res);
    }
    // ---- 环境检测与依赖安装 ----
    if (path === '/api/env/check' && method === 'GET') {
      return json(res, await checkEnv());
    }
    if (path === '/api/env/download' && method === 'POST') {
      const body = await readBody(req);
      const args = JSON.parse(body.toString('utf8') || '{}');
      const keys = args.keys || args.key || [];
      const r = startDownload(keys, join(HERE, 'data', 'envdl'));
      return json(res, r, r.ok ? 200 : 400);
    }
    if (path === '/api/env/download/status' && method === 'GET') {
      return json(res, downloadStatus(u.searchParams.get('id')));
    }
    if (path === '/api/env/script' && method === 'GET') {
      const body = buildScript();
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream; charset=utf-8',
        'Content-Disposition': 'attachment; filename="wfc-install.ps1"',
        'Content-Length': Buffer.byteLength(body, 'utf8'),
      });
      return res.end('\ufeff' + body); // BOM 让 PowerShell 正确识别 UTF-8 中文
    }

    // 健康检查
    if (path === '/api/health') {
      return json(res, { ok: true, running, queue: queue.length, jobs: jobs.size, node: process.version });
    }

    if (method === 'GET' || method === 'HEAD') return serveStatic(res, path);
    return json(res, { ok: false, error: 'unknown route' }, 404);
  } catch (e) {
    return json(res, { ok: false, error: e.message }, 500);
  }
}

const server = http.createServer(handle);
server.listen(PORT, HOST, () => {
  console.log('万能翻唱已启动：http://' + HOST + ':' + PORT);
  console.log('音色库：' + CFG.voicesDir);
  console.log('任务目录：' + CFG.runsDir);
});
