/**
 * 万能翻唱 · 配置加载器（零依赖）
 * ------------------------------------------------------------------
 * 单一配置源，供 server.mjs / env-manager.mjs 共用。
 * 优先级（从低到高）：内置默认 < config.example.json < config.local.json < 环境变量
 *
 *   - config.example.json：提交到仓库，作为可运行示例；别人 clone 后复制成
 *     config.local.json 并把路径改成自己机器上的实际位置。
 *   - config.local.json：每台机器私有，已加入 .gitignore，不会被提交。
 *   - 环境变量（可选）：PORT / WFC_GST / WFC_SONGS / WFC_MODELS / WFC_NODE
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// 内置默认 = 开发机路径，仅作最后兜底；正常应写进 config.local.json
const DEFAULTS = {
  port: 18321,
  node: '',
  gst: 'D:/GPT-SoVITS-v3lora-20250228-nvidia50',
  songs: 'D:/AI-Song',
  models: 'D:/AI-Song/models',
};

function readJson(file) {
  try {
    const obj = JSON.parse(readFileSync(file, 'utf8'));
    return obj && typeof obj === 'object' ? obj : {};
  } catch (e) {
    console.error(`[config] 无法解析 ${file}: ${e.message}`);
    return {};
  }
}

function load() {
  let cfg = { ...DEFAULTS };
  // example 先、local 后——local 覆盖 example
  for (const name of ['config.example.json', 'config.local.json']) {
    const f = join(HERE, name);
    if (existsSync(f)) cfg = { ...cfg, ...readJson(f) };
  }
  // 环境变量最高优先级（沿用 PORT 的既有习惯，并补齐其它项）
  if (process.env.PORT) cfg.port = Number(process.env.PORT);
  if (process.env.WFC_GST) cfg.gst = process.env.WFC_GST;
  if (process.env.WFC_SONGS) cfg.songs = process.env.WFC_SONGS;
  if (process.env.WFC_MODELS) cfg.models = process.env.WFC_MODELS;
  if (process.env.WFC_NODE) cfg.node = process.env.WFC_NODE;
  return cfg;
}

export const CONFIG = load();
export const PORT = Number(CONFIG.port) || 18321;
