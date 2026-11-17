/**
 * 万能翻唱 · 环境检测与依赖下载
 * ------------------------------------------------------------------
 * 零外部依赖。职责：
 *   1) 扫描本机依赖（运行时/代码/模型/音色），报告存在与否和真实大小；
 *   2) 对可从 HuggingFace 直链下载的模型，提供"点击即下载"（curl + 断点续传 + 进度）；
 *   3) 生成一份 PowerShell 一键安装脚本，供换机时补齐无法自动下载的部分。
 *
 * 模型 repo id 来自本机 huggingface_hub 缓存目录名 models--<owner>--<repo>，
 * 文件名来自实际落盘文件，因此 resolve 直链可靠（非猜测）。
 */
import { spawn } from 'node:child_process';
import {
  existsSync, statSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, renameSync, unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { CONFIG } from './config.mjs';

const CP = `${CONFIG.models}/checkpoints`;
const GST = CONFIG.gst;
const SONGS = CONFIG.songs;
const SNAP = {
  seedvc: CP + '/models--Plachta--Seed-VC/snapshots/257283f9f41585055e8f858fba4fd044e5caed6e',
  whisper: CP + '/models--openai--whisper-small/snapshots/973afd24965f72e36ca33b3055d56a652f456b4d',
  bigvgan: CP + '/models--nvidia--bigvgan_v2_44khz_128band_512x/snapshots/95a9d1dcb12906c03edd938d77b9333d6ded7dfb',
  campplus: CP + '/models--funasr--campplus/snapshots/e4b6ede7ce16997aff4ae69fbca1f0175e2afede',
  rmvpe: CP + '/models--lj1995--VoiceConversionWebUI/snapshots/e6d0c1a17da07c33557852f9dfa2bd44cc75737d',
};

// 国内网络下 huggingface.co 常不可达（实测 curl 返回 000），hf-mirror.com 镜像全部可达。
// 若用户有代理、想改用官方源，把下面这一行改回 'https://huggingface.co' 即可。
const HF = 'https://hf-mirror.com';
const GST_RELEASE = 'https://github.com/RVC-Project/GPT-SoVITS/releases';
const dl = (repo, file) => `${HF}/${repo}/resolve/main/${file}`;

/**
 * 依赖清单。type: file|dir；min = 判定"完整"的最小字节数；
 * url 非空 = 可点击自动下载（curl 直链）；link = 只打开网页；hint = 手动安装提示。
 */
export const ENV_ITEMS = [
  // ---- 运行时 ----
  { key: 'python', name: 'Python 运行时', cat: '运行时', path: `${GST}/runtime/python.exe`, type: 'file', min: 50000,
    link: GST_RELEASE, linkLabel: '整合包下载页', hint: '随 GPT-SoVITS v3lora nvidia50 整合包提供（RTX 40/50 系需 nvidia50 版）' },
  { key: 'ffmpeg', name: 'FFmpeg', cat: '运行时', path: `${GST}/ffmpeg.exe`, type: 'file', min: 1000000,
    link: 'https://www.gyan.dev/ffmpeg/builds/', linkLabel: 'FFmpeg 下载页', hint: '随整合包提供，或独立下载 essentials 版' },
  { key: 'ffprobe', name: 'FFprobe', cat: '运行时', path: `${GST}/ffprobe.exe`, type: 'file', min: 1000000,
    link: 'https://www.gyan.dev/ffmpeg/builds/', linkLabel: 'FFmpeg 下载页', hint: '随整合包提供' },
  // ---- 代码 ----
  { key: 'seedvc', name: 'Seed-VC 源码', cat: '代码', path: `${SONGS}/src/seed-vc-hf/inference.py`, type: 'file', min: 5000,
    link: 'https://github.com/Plachtaa/seed-vc', linkLabel: 'GitHub 仓库', hint: `git clone https://github.com/Plachtaa/seed-vc.git 到 ${SONGS}/src/seed-vc-hf` },
  { key: 'uvr5code', name: 'UVR5 人声分离代码', cat: '代码', path: `${GST}/tools/uvr5/bsroformer.py`, type: 'file', min: 1000,
    link: GST_RELEASE, linkLabel: '整合包下载页', hint: '随 GPT-SoVITS 整合包提供（tools/uvr5 目录）' },
  { key: 'pylibs', name: 'Python 依赖库', cat: '代码', path: `${SONGS}/env/pylibs`, type: 'dir', min: 1,
    link: 'https://github.com/Plachtaa/seed-vc/blob/main/requirements.txt', linkLabel: '依赖清单', hint: `pip install -t ${SONGS}/env/pylibs -r requirements.txt` },
  // ---- 模型（可点击直链下载）----
  { key: 'dit', name: 'Seed-VC DiT 主模型 · 783MB', cat: '模型', path: `${SNAP.seedvc}/DiT_seed_v2_uvit_whisper_base_f0_44k_bigvgan_pruned_ft_ema_v2.pth`, type: 'file', min: 800000000,
    url: dl('Plachta/Seed-VC', 'DiT_seed_v2_uvit_whisper_base_f0_44k_bigvgan_pruned_ft_ema_v2.pth'),
    extra: [{ path: `${SNAP.seedvc}/config_dit_mel_seed_uvit_whisper_base_f0_44k.yml`, url: dl('Plachta/Seed-VC', 'config_dit_mel_seed_uvit_whisper_base_f0_44k.yml') }] },
  { key: 'whisper', name: 'Whisper-small · 922MB', cat: '模型', path: `${SNAP.whisper}/model.safetensors`, type: 'file', min: 900000000,
    url: dl('openai/whisper-small', 'model.safetensors') },
  { key: 'bigvgan', name: 'BigVGAN 声码器 · 466MB', cat: '模型', path: `${SNAP.bigvgan}/bigvgan_generator.pt`, type: 'file', min: 400000000,
    url: dl('nvidia/bigvgan_v2_44khz_128band_512x', 'bigvgan_generator.pt') },
  { key: 'campplus', name: 'CampPlus 说话人 · 27MB', cat: '模型', path: `${SNAP.campplus}/campplus_cn_common.bin`, type: 'file', min: 20000000,
    url: dl('funasr/campplus', 'campplus_cn_common.bin') },
  { key: 'rmvpe', name: 'RMVPE 音高提取 · 173MB', cat: '模型', path: `${SNAP.rmvpe}/rmvpe.pt`, type: 'file', min: 150000000,
    url: dl('lj1995/VoiceConversionWebUI', 'rmvpe.pt') },
  { key: 'uvrmodel', name: 'UVR5 人声分离模型 · 305MB', cat: '模型', path: `${GST}/tools/uvr5/uvr5_weights/model_bs_roformer_ep_317_sdr_12.9755.ckpt`, type: 'file', min: 300000000,
    link: GST_RELEASE, linkLabel: '整合包下载页', hint: '随 GPT-SoVITS 整合包提供（uvr5_weights 目录）；国内可用 modelscope 镜像' },
  // ---- 音色 ----
  { key: 'voice', name: '默认音色 dsh_main', cat: '音色', path: `${SONGS}/voices/dsh_main/reference.wav`, type: 'file', min: 100000, optional: true,
    link: null, hint: '任意干净人声 10~30 秒 wav；或用主界面「音色①→添加」上传' },
];

function human(n) {
  if (n == null) return '—';
  if (n >= 1 << 30) return (n / (1 << 30)).toFixed(2) + ' GB';
  if (n >= 1 << 20) return (n / (1 << 20)).toFixed(1) + ' MB';
  if (n >= 1 << 10) return (n / (1 << 10)).toFixed(0) + ' KB';
  return n + ' B';
}
function dirSize(p) {
  let total = 0;
  try { for (const n of readdirSync(p)) { const f = join(p, n); try { total += statSync(f).size; } catch {} } } catch {}
  return total;
}
import { readdirSync } from 'node:fs';

// ---- GPU / 系统信息（缓存 5 分钟）----
let sysCache = null;
function runCapture(cmd, args) {
  return new Promise((resolve) => {
    try {
      const p = spawn(cmd, args, { windowsHide: true });
      let out = '';
      p.stdout?.on('data', (d) => { out += d.toString(); });
      p.on('error', () => resolve(''));
      p.on('close', () => resolve(out.trim()));
    } catch { resolve(''); }
  });
}
export async function systemInfo() {
  if (sysCache && Date.now() - sysCache.t < 5 * 60e3) return sysCache.v;
  const gpu = await runCapture('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader']);
  const v = {
    os: process.platform === 'win32' ? 'Windows' : process.platform,
    arch: process.arch,
    node: process.version,
    gpu: gpu || null,
    gpuOk: !!gpu && /NVIDIA/i.test(gpu),
  };
  sysCache = { t: Date.now(), v };
  return v;
}

/** 扫描全部依赖，返回结构化报告 */
export async function checkEnv() {
  const sys = await systemInfo();
  const items = ENV_ITEMS.map((it) => {
    let size = null;
    try { size = it.type === 'dir' ? dirSize(it.path) : (existsSync(it.path) ? statSync(it.path).size : null); } catch {}
    const ok = size != null && size >= it.min;
    return {
      key: it.key, name: it.name, cat: it.cat, path: it.path, type: it.type,
      ok, size, sizeText: human(size), needText: human(it.min),
      canDownload: !!it.url, link: it.link || null, linkLabel: it.linkLabel || null,
      hint: it.hint || null, optional: !!it.optional,
      url: it.url || null,
    };
  });
  const required = items.filter((i) => !i.optional);
  const ready = required.filter((i) => i.ok).length;
  return {
    ok: true, sys, items,
    summary: {
      ready, total: required.length,
      percent: Math.round((ready / required.length) * 100),
      allReady: ready === required.length,
      missing: items.filter((i) => !i.ok).map((i) => i.key),
    },
  };
}

// ---- 下载任务 ----
const downloads = new Map(); // id -> {id,key,items,status,log,startedAt,files,totalBytes,...}

/** 启动下载；keys 为数组，可一次下多个（顺序执行） */
export function startDownload(keys, logRoot) {
  const list = (Array.isArray(keys) ? keys : [keys]).map((k) => ENV_ITEMS.find((i) => i.key === k)).filter((i) => i && i.url);
  if (!list.length) return { ok: false, error: '所选依赖没有可自动下载的直链（整合包/源码请用"打开下载页"或安装脚本）' };
  const id = 'envdl-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  const logFile = join(logRoot, id + '.log');
  try { mkdirSync(logRoot, { recursive: true }); } catch {}
  const job = { id, keys: list.map((i) => i.key), status: 'running', logFile, done: 0, total: list.length, current: null, error: null };
  downloads.set(id, job);
  log(job, `开始下载 ${list.length} 项依赖\n`);
  (async () => {
    for (const it of list) {
      job.current = it.key;
      for (const f of [{ path: it.path, url: it.url }, ...(it.extra || [])]) {
        const ok = await curlToFile(job, f.url, f.path);
        if (!ok) { job.status = 'failed'; job.error = `下载失败：${it.name}`; log(job, `✗ ${job.error}\n`); return; }
      }
      job.done++;
      log(job, `✓ ${it.name} 完成\n`);
    }
    job.status = 'done'; job.current = null;
    log(job, '全部完成。请点「重新检测」确认。\n');
  })();
  return { ok: true, id };
}

function log(job, text) {
  try { appendFileSync(job.logFile, text); } catch {}
}
function curlToFile(job, url, dest) {
  return new Promise((resolve) => {
    try { mkdirSync(dirname(dest), { recursive: true }); } catch {}
    const tmp = dest + '.part';
    const args = ['-L', '--fail', '--retry', '3', '--retry-delay', '2', '-C', '-', '-o', tmp, url];
    log(job, `$ curl.exe -L -C - -o "${tmp}"\n  ${url}\n`);
    let p;
    try { p = spawn('curl.exe', args, { windowsHide: true }); }
    catch { p = spawn('curl', args, { windowsHide: true }); }
    let err = '';
    p.stderr?.on('data', (d) => { err += d.toString(); });
    p.on('error', (e) => { log(job, '  启动失败：' + e.message + '\n'); resolve(false); });
    p.on('close', (code) => {
      if (code !== 0) { log(job, `  curl 退出码 ${code}：${err.slice(-500)}\n`); resolve(false); return; }
      try {
        if (existsSync(dest)) unlinkSync(dest);
        renameSync(tmp, dest);
        log(job, `  → ${dest} (${human(statSync(dest).size)})\n`);
        resolve(true);
      } catch (e) { log(job, '  落盘失败：' + e.message + '\n'); resolve(false); }
    });
  });
}

export function downloadStatus(id) {
  const j = downloads.get(id);
  if (!j) {
    const p = id ? join('', '') : '';
    return { ok: false, error: '没有这个下载任务' };
  }
  let text = '';
  try { text = readFileSync(j.logFile, 'utf8').slice(-8000); } catch {}
  return { ok: true, id: j.id, status: j.status, done: j.done, total: j.total, current: j.current, error: j.error, log: text };
}

/** 生成 PowerShell 一键安装脚本（换机时补齐无法自动下载的部分） */
export function buildScript() {
  const items = ENV_ITEMS;
  const lines = [
    '# 万能翻唱 · 环境一键安装脚本（PowerShell）',
    '# 用法：以管理员身份打开 PowerShell，运行  .\\万能翻唱-环境安装.ps1',
    '# 前提：已装 Node 24、git、NVIDIA 驱动；脚本只负责本项目依赖。',
    '$ErrorActionPreference = "Continue"',
    '',
    `$GST = "${GST}"`,
    `$ROOT = "${SONGS}"`,
    '$CP  = "$ROOT\\models\\checkpoints"',
    'function Ensure-Dir($p){ if(-not (Test-Path $p)){ New-Item -ItemType Directory -Force -Path $p | Out-Null; Write-Host "创建目录 $p" -ForegroundColor Cyan } }',
    'function Get-File($url,$dest){',
    '  Ensure-Dir (Split-Path $dest)',
    '  if(Test-Path $dest){ Write-Host "已存在，跳过 $dest" -ForegroundColor DarkGray; return }',
    '  Write-Host "下载 $([System.IO.Path]::GetFileName($dest)) ..." -ForegroundColor Yellow',
    '  curl.exe -L --fail --retry 3 -C - -o "$dest.part" "$url"',
    '  if($LASTEXITCODE -ne 0){ Write-Host "下载失败：$url" -ForegroundColor Red; return }',
    '  Move-Item -Force "$dest.part" $dest',
    '}',
    '',
    'Write-Host "=== 0. 需要手动准备的部分 ===" -ForegroundColor Magenta',
    `Write-Host "① 下载 GPT-SoVITS v3lora nvidia50 整合包并解压到 $GST"`,
    `Write-Host "   地址：${GST_RELEASE}"`,
    'Write-Host "   （整合包内含 runtime/python.exe、ffmpeg.exe、ffprobe.exe、tools/uvr5 及其权重）"',
    'Write-Host "② 安装 Node 24：https://nodejs.org/"',
    '',
    'Write-Host "=== 1. Seed-VC 源码 ===" -ForegroundColor Magenta',
    'Ensure-Dir "$ROOT\\src"',
    'if(-not (Test-Path "$ROOT\\src\\seed-vc-hf\\inference.py")){ git clone https://github.com/Plachtaa/seed-vc.git "$ROOT\\src\\seed-vc-hf" }',
    '',
    'Write-Host "=== 2. Python 依赖库 ===" -ForegroundColor Magenta',
    'Ensure-Dir "$ROOT\\env\\pylibs"',
    '& "$GST\\runtime\\python.exe" -m pip install --upgrade pip',
    '& "$GST\\runtime\\python.exe" -m pip install -t "$ROOT\\env\\pylibs" -r "$ROOT\\src\\seed-vc-hf\\requirements.txt"',
    '',
    'Write-Host "=== 3. 模型（HuggingFace 直链，断点续传）===" -ForegroundColor Magenta',
  ];
  const models = items.filter((i) => i.url);
  for (const m of models) {
    lines.push(`Get-File "${m.url}" "${m.path.replace(/\//g, '\\')}"`);
    for (const ex of m.extra || []) lines.push(`Get-File "${ex.url}" "${ex.path.replace(/\//g, '\\')}"`);
  }
  lines.push(
    '',
    'Write-Host "=== 4. 音色 ===" -ForegroundColor Magenta',
    `Write-Host "把任意干净人声 wav 放到 ${SONGS}/voices/dsh_main/reference.wav，或在网页界面用「添加」上传。"`,
    '',
    'Write-Host "`n全部完成。运行 万能翻唱.exe，在网页顶部「环境检测」点「重新检测」确认。" -ForegroundColor Green',
  );
  return lines.join('\r\n');
}
