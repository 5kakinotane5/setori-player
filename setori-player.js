// ==UserScript==
// @name         setori-player
// @namespace    setori-player
// @version      1.0
// @description  タイムスタンプの区間だけを順番に再生し、曲の終わりで次の曲の頭へ飛ぶ
// @match        https://www.youtube.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  const TIME_RE = /(?:(\d{1,2}):)?(\d{1,2}):(\d{2})/g;
  const HAS_TIME = /\d{1,2}:\d{2}/;
  const EPS = 0.6;            // シーク直後の位置ズレの許容（秒）
  const SEEK_COOLDOWN = 800;  // シーク直後は判定を休む（ms）
  const KEY = id => 'yt-setlist:' + id;

  const state = { segments: [], active: false, loop: false, idx: -1, videoId: null, lastSeek: 0 };
  let ui = null;

  // ---------- 小物 ----------
  const toSec = (h, m, s) => (+h || 0) * 3600 + +m * 60 + +s;
  const fmt = t => {
    if (!isFinite(t)) return '最後';
    t = Math.floor(t);
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
  };
  const player = () => document.getElementById('movie_player');
  const video = () =>
    document.querySelector('#movie_player video.html5-main-video') || document.querySelector('#movie_player video');
  const isAd = () => !!player()?.classList.contains('ad-showing');
  const isWatch = () => location.pathname === '/watch';
  const getVideoId = () => new URLSearchParams(location.search).get('v');

  // YouTube は Trusted Types で innerHTML を禁止しているので、DOM は全部 createElement で作る
  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k in el) el[k] = v;
      else el.setAttribute(k, v);
    }
    el.append(...children);
    return el;
  }

  // ---------- タイムスタンプの解析 ----------
  // 1行に時刻が2つ → 開始〜終了、1つ → 開始（終了は次の曲の開始）
  function parse(text) {
    const out = [];
    for (const line of text.split(/\r?\n/)) {
      const times = [...line.matchAll(TIME_RE)].map(m => toSec(m[1], m[2], m[3]));
      if (!times.length) continue;
      const title = line
        .replace(/(?:\d{1,2}:)?\d{1,2}:\d{2}\s*[-–—~〜～]?\s*/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/^[\s\-–—~〜～|:：.、,]+/, '')
        .replace(/[\s\-–—~〜～|:：、,]+$/, '')
        .trim();
      out.push({ start: times[0], end: times.length > 1 ? times[1] : null, title });
    }
    out.sort((a, b) => a.start - b.start);
    out.forEach((s, i) => {
      if (s.end == null || s.end <= s.start) s.end = out[i + 1] ? out[i + 1].start : Infinity;
    });
    return out;
  }

  // ---------- 再生制御 ----------
  function seek(t) {
    const p = player(), v = video();
    state.lastSeek = performance.now();
    if (p && typeof p.seekTo === 'function') p.seekTo(t, true);
    else if (v) v.currentTime = t;
  }

  function tick() {
    if (!state.active || !state.segments.length || isAd()) return;
    if (performance.now() - state.lastSeek < SEEK_COOLDOWN) return;
    const v = video();
    if (!v || !isFinite(v.currentTime)) return;
    const segs = state.segments;

    if (v.ended) {
      if (state.loop) { seek(segs[0].start); setCurrent(0); v.play(); }
      else setActive(false);
      return;
    }

    const t = v.currentTime;
    const i = segs.findIndex(s => t >= s.start - EPS && t < s.end);
    if (i !== -1) return setCurrent(i);

    // 曲と曲の間（MCなど）にいる → 次の曲の頭へ
    const next = segs.findIndex(s => s.start > t);
    if (next !== -1) { seek(segs[next].start); setCurrent(next); }
    else if (state.loop) { seek(segs[0].start); setCurrent(0); }
    else { v.pause(); setActive(false); }
  }
  setInterval(tick, 100);

  function setCurrent(i) {
    if (i === state.idx) return;
    state.idx = i;
    render();
    if (ui && !ui.panel.classList.contains('ysp-min')) {
      ui.list.children[i]?.scrollIntoView({ block: 'nearest' });
    }
  }

  function setActive(on) {
    state.active = on && state.segments.length > 0;
    if (state.active) {
      const v = video(), segs = state.segments;
      if (v && v.currentTime >= segs[segs.length - 1].end - EPS) { seek(segs[0].start); state.idx = 0; }
      v?.play();
    }
    render();
  }

  function jump(i) {
    const s = state.segments[i];
    if (!s) return;
    seek(s.start);
    state.idx = -1;
    setCurrent(i);
    if (!state.active) setActive(true);
    else video()?.play();
  }

  function step(dir) {
    const segs = state.segments;
    if (!segs.length) return;
    let i = state.idx;
    if (i === -1) {
      const t = video()?.currentTime ?? 0;
      i = dir > 0 ? segs.findIndex(s => s.start > t) : segs.findLastIndex(s => s.end <= t);
      if (i === -1) i = dir > 0 ? segs.length - 1 : 0;
    } else {
      i += dir;
      if (i >= segs.length) i = state.loop ? 0 : segs.length - 1;
      if (i < 0) i = 0;
    }
    jump(i);
  }

  function apply() {
    const text = ui.textarea.value;
    state.segments = parse(text);
    state.idx = -1;
    try { localStorage.setItem(KEY(state.videoId), text); } catch {}
    render();
  }

  function readDescription() {
    try {
      const pr = player()?.getPlayerResponse?.();
      const d = pr?.videoDetails?.shortDescription;
      if (d && pr.videoDetails.videoId === state.videoId) return d;
    } catch {}
    const el =
      document.querySelector('#description-inline-expander #expanded') ||
      document.querySelector('#description-inline-expander') ||
      document.querySelector('#description');
    return el ? el.textContent : '';
  }

  // ---------- 画面 ----------
  const CSS = `
#ysp-panel{--bg:#fff;--fg:#0f0f0f;--sub:#606060;--line:#e5e5e5;--hl:#f2f2f2;--acc:#cc0000;
  position:fixed;right:16px;bottom:16px;z-index:2300;width:300px;max-height:70vh;
  display:flex;flex-direction:column;background:var(--bg);color:var(--fg);
  border:1px solid var(--line);border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,.2);
  font:13px/1.45 Roboto,"Noto Sans JP",sans-serif}
html[dark] #ysp-panel{--bg:#212121;--fg:#f1f1f1;--sub:#aaa;--line:#3a3a3a;--hl:#303030;--acc:#ff4e45}
#ysp-panel .ysp-head{display:flex;justify-content:space-between;align-items:center;
  padding:8px 12px;font-weight:600;border-bottom:1px solid var(--line)}
#ysp-panel.ysp-min .ysp-head{border-bottom:0}
#ysp-panel.ysp-min .ysp-body{display:none}
#ysp-panel .ysp-body{display:flex;flex-direction:column;gap:8px;padding:10px 12px;flex:1;min-height:0}
#ysp-panel textarea{width:100%;box-sizing:border-box;height:90px;resize:vertical;padding:6px 8px;
  background:var(--hl);color:var(--fg);border:1px solid var(--line);border-radius:8px;
  font:12px/1.4 Roboto,"Noto Sans JP",sans-serif}
#ysp-panel .ysp-row{display:flex;gap:6px;align-items:center}
#ysp-panel button{background:var(--hl);color:var(--fg);border:1px solid var(--line);
  border-radius:16px;padding:4px 10px;cursor:pointer;font:inherit}
#ysp-panel button:focus-visible{outline:2px solid var(--acc);outline-offset:1px}
#ysp-panel button.ysp-play{background:var(--acc);border-color:var(--acc);color:#fff;min-width:76px}
#ysp-panel button.ysp-x{border:0;background:none;font-size:16px;padding:0 4px;line-height:1}
#ysp-panel label{display:flex;align-items:center;gap:4px;margin-left:auto;color:var(--sub);cursor:pointer}
#ysp-panel .ysp-status{color:var(--sub);font-size:12px}
#ysp-panel ol{list-style:none;margin:0;padding:0;overflow:auto;flex:1;min-height:0}
#ysp-panel li{display:flex;gap:8px;padding:5px 6px;border-radius:6px;cursor:pointer}
#ysp-panel li:hover{background:var(--hl)}
#ysp-panel li.ysp-cur{background:var(--hl);color:var(--acc);font-weight:600}
#ysp-panel .ysp-time{color:var(--sub);font-variant-numeric:tabular-nums;white-space:nowrap;font-size:12px;font-weight:400}
#ysp-panel .ysp-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`;

  function buildUI() {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.append(style);

    let timer = 0;
    const textarea = h('textarea', {
      spellcheck: false,
      placeholder: '1行に1曲。例：\n0:03:15 - 0:07:40 曲名A\n0:12:05 - 0:16:30 曲名B\n終わりを省くと次の曲の頭まで再生',
      oninput: () => { clearTimeout(timer); timer = setTimeout(apply, 400); },
    });
    // 入力中に YouTube のショートカット（k, j, l など）が反応しないようにする
    for (const ev of ['keydown', 'keyup', 'keypress']) textarea.addEventListener(ev, e => e.stopPropagation());

    const playBtn = h('button', { className: 'ysp-play', onclick: () => setActive(!state.active) });
    const loopCb = h('input', { type: 'checkbox', onchange: e => { state.loop = e.target.checked; } });
    const list = h('ol');
    const status = h('div', { className: 'ysp-status' });

    const panel = h('div', { id: 'ysp-panel' });
    panel.append(
      h('div', { className: 'ysp-head' },
        h('span', { textContent: 'セトリ再生' }),
        h('button', { className: 'ysp-x', textContent: '–', title: 'たたむ / ひらく',
          onclick: () => panel.classList.toggle('ysp-min') })),
      h('div', { className: 'ysp-body' },
        textarea,
        h('div', { className: 'ysp-row' },
          h('button', { textContent: '説明欄から読み込む', onclick: () => {
            const lines = readDescription().split(/\r?\n/).filter(l => HAS_TIME.test(l));
            if (!lines.length) { status.textContent = '説明欄にタイムスタンプが見つかりません（コメント欄なら貼り付けてください）'; return; }
            textarea.value = lines.join('\n');
            apply();
          } })),
        h('div', { className: 'ysp-row' },
          h('button', { textContent: '⏮', title: '前の曲', onclick: () => step(-1) }),
          playBtn,
          h('button', { textContent: '⏭', title: '次の曲', onclick: () => step(1) }),
          h('label', {}, loopCb, 'ループ')),
        status,
        list));
    document.body.append(panel);
    ui = { panel, textarea, list, status, playBtn, loopCb };
  }

  function render() {
    if (!ui) return;
    const segs = state.segments, n = segs.length, cur = segs[state.idx];
    ui.playBtn.textContent = state.active ? '■ 停止' : '▶ 開始';
    ui.list.replaceChildren(...segs.map((s, i) =>
      h('li', { className: i === state.idx ? 'ysp-cur' : '', onclick: () => jump(i) },
        h('span', { className: 'ysp-time', textContent: `${fmt(s.start)}–${fmt(s.end)}` }),
        h('span', { className: 'ysp-title', textContent: s.title || `${i + 1}曲目` }))));
    ui.status.textContent =
      !n ? 'タイムスタンプを貼り付けると、曲だけを順番に再生します'
      : state.active ? (cur ? `再生中 ${state.idx + 1}/${n}：${cur.title || `${state.idx + 1}曲目`}` : '次の曲へ移動中')
      : `${n}曲を読み込み済み`;
  }

  // YouTube はページ遷移しない（SPA）ので、動画が切り替わるたびに呼ばれるイベントで差し替える
  function onNavigate() {
    if (!ui) buildUI();
    ui.panel.style.display = isWatch() ? '' : 'none';
    const id = getVideoId();
    if (!isWatch() || id === state.videoId) return;
    state.videoId = id;
    state.active = false;
    state.idx = -1;
    let saved = '';
    try { saved = localStorage.getItem(KEY(id)) || ''; } catch {}
    ui.textarea.value = saved;
    state.segments = parse(saved);
    render();
  }

  document.addEventListener('yt-navigate-finish', onNavigate);
  onNavigate();
})();