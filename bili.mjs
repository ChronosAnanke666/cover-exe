/**
 * B 站取歌：搜索 → 选版本 → 拿音频直链。
 *
 * 踩过的坑（2026-11 实测，别改回去）：
 *   - `x/web-interface/view` 风控严，免登录经常 412 `request was banned`；改用
 *     `x/player/pagelist` 拿 cid，它宽松得多。
 *   - `x/web-interface/search/type` 必须带首页发下来的 `buvid3` cookie，否则 412。
 *   - `x/player/playurl?fnval=16` 免登录就给 dash.audio 三档 AAC。
 *   - 直链裸 GET 会被 CDN 403，必须带 `Referer: https://www.bilibili.com/video/<bvid>`。
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const HOME = 'https://www.bilibili.com/';

let cookieCache = { value: '', at: 0 };

async function getCookie(force = false) {
  const now = Date.now();
  if (!force && cookieCache.value && now - cookieCache.at < 30 * 60 * 1000) return cookieCache.value;
  const r = await fetch(HOME, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) });
  const raw = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
  const cookie = raw.map((c) => c.split(';')[0]).filter(Boolean).join('; ');
  cookieCache = { value: cookie, at: now };
  return cookie;
}

function headers(cookie, referer = 'https://search.bilibili.com/') {
  return {
    'user-agent': UA,
    referer,
    cookie,
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9',
  };
}

function parseDuration(text) {
  // "4:5" / "12:34" / "1:02:03"
  const parts = String(text || '').split(':').map((n) => parseInt(n, 10));
  if (parts.some((n) => Number.isNaN(n))) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function stripTags(s) {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

/** 搜索视频，返回 [{bvid,title,author,duration,play,description}] */
export async function search(query, { limit = 20 } = {}) {
  const cookie = await getCookie();
  const url = `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(query)}&page=1`;
  let res = await fetch(url, { headers: headers(cookie), signal: AbortSignal.timeout(20000) });
  let json = await res.json();
  if (json?.code === -412 || json?.code === -352) {
    const fresh = await getCookie(true);
    res = await fetch(url, { headers: headers(fresh), signal: AbortSignal.timeout(20000) });
    json = await res.json();
  }
  if (json?.code !== 0) {
    throw new Error(`B 站搜索失败：code=${json?.code} ${json?.message || ''}`);
  }
  const list = json?.data?.result || [];
  return list.slice(0, limit).map((v) => ({
    bvid: v.bvid,
    title: stripTags(v.title),
    author: v.author,
    duration: parseDuration(v.duration),
    play: Number(v.play) || 0,
    description: stripTags(v.description).slice(0, 120),
  }));
}

/**
 * 从搜索结果里挑一个最可能是「有人声的正式版本」的。
 * 返回 { pick, reason, ranked }
 */
export function pickBest(list, cfg) {
  const reject = cfg.rejectWords || [];
  const prefer = cfg.preferWords || [];
  const ranked = list
    .map((v) => {
      let score = 0;
      const t = v.title.toLowerCase();
      const reasons = [];
      for (const w of reject) {
        if (t.includes(w.toLowerCase())) { score -= 6; reasons.push(`-6 标题含「${w}」`); }
      }
      for (const w of prefer) {
        if (t.includes(w.toLowerCase())) { score += 3; reasons.push(`+3 标题含「${w}」`); }
      }
      if (v.duration >= 90 && v.duration <= 420) { score += 2; reasons.push('+2 时长正常'); }
      else if (v.duration > 420) { score -= 2; reasons.push('-2 时长过长'); }
      else if (v.duration > 0 && v.duration < 60) { score -= 4; reasons.push('-4 太短'); }
      score += Math.min(4, Math.log10(Math.max(1, v.play))); // 播放量 1e4→+4
      return { ...v, score, reasons };
    })
    .sort((a, b) => b.score - a.score);
  return { pick: ranked[0] || null, ranked };
}

/** 拿某个 bvid 的最佳音轨直链 */
export async function audioUrl(bvid) {
  const cookie = await getCookie();
  const referer = `https://www.bilibili.com/video/${bvid}`;
  const plRes = await fetch(`https://api.bilibili.com/x/player/pagelist?bvid=${bvid}`, {
    headers: headers(cookie, referer),
    signal: AbortSignal.timeout(20000),
  });
  const pl = await plRes.json();
  if (pl?.code !== 0 || !pl?.data?.length) {
    throw new Error(`拿不到分 P 信息：code=${pl?.code} ${pl?.message || ''}`);
  }
  const first = pl.data[0];
  const u = `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${first.cid}&fnval=16&fourk=1&platform=pc`;
  const jr = await fetch(u, { headers: headers(cookie, referer), signal: AbortSignal.timeout(20000) });
  const j = await jr.json();
  if (j?.code !== 0) throw new Error(`拿不到播放地址：code=${j?.code} ${j?.message || ''}`);
  const audios = j?.data?.dash?.audio || [];
  if (!audios.length) throw new Error('这个视频没有 dash 音轨（可能是纯视频流或需要登录）。');
  audios.sort((a, b) => b.bandwidth - a.bandwidth);
  return {
    url: audios[0].baseUrl,
    bandwidth: audios[0].bandwidth,
    duration: first.duration,
    part: first.part,
    referer,
    cookie,
  };
}

/** 从任意 B 站链接里抠出 BV 号 */
export function extractBvid(input) {
  const s = String(input || '');
  const m = s.match(/BV[0-9A-Za-z]{10}/);
  return m ? m[0] : null;
}
