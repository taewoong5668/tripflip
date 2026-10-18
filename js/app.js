import { readPlanFile, parsePlanText, isHotel } from './parser.js?v=202610181411';
import {
  MODES, computeSchedule, estimateMin, haversine, fmtClock, clockOf, fmtDur, fmtDist, fmtCountdown, todayStr, dayStart, dayLabel,
} from './schedule.js?v=202610181411';
import { createMap } from './map.js?v=202610181411';
import { routeFor, inKorea, searchPlaces, searchPlacesFree, decodePolyline, navUrl, placeUrl, nearbyPlaces, nearbyPlacesFree, VIA_PROXY, setInvite, checkInvite, proxyHooks } from './google.js?v=202610181411';
import { PROXY_URL } from './config.js?v=202610181411';
import { isNative, Geo, Alarms, webNotify, beep, openExternal, onBackButton, exitApp } from './device.js?v=202610181411';
import { saveFile, getFile, deleteFile, isPdf, renderPdf } from './files.js?v=202610181411';

const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 저장 공간 부족 */ } },
};
const newId = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const emptyPlan = () => ({ title: '내 여행', days: [] });

const DEFAULTS = { apiKey: '', radius: 100, lead: 10, buffer: 5, sim: false, invite: '', inviteAsked: false };
// 구글 검색·경로에 쓸 키: 내가 넣은 키가 있으면 그것, 없으면 트립플립 중간 서버(초대 코드가 있을 때), 둘 다 없으면 '' (무료 지도)
const gkey = () => S.settings.apiKey || (PROXY_URL && S.settings.invite ? VIA_PROXY : '');
const S = {
  settings: { ...DEFAULTS, ...store.get('tg.settings', {}) },
  plan: store.get('tg.plan', null) || emptyPlan(),
  progress: store.get('tg.progress', {}), // 날짜 → 장소id → {arr, dep, skip} (ms)
  legCache: store.get('tg.legs', {}),      // 구간별 실제 경로
  geoCache: store.get('tg.geo', {}),
  selected: null, followToday: true, lastToday: null,
  cur: { legs: [], sched: [] },
  pos: null, follow: false, map: null,
  open: null, sheet: null, routeView: null,
  pick: false,      // 지도에서 위치 고르는 중
  live: null,       // 내 위치 → 다음 장소 실시간 경로 {id, path, at, from}
  calMonth: null,   // 달력에 보이는 달 {y, m}
  view: 'list',     // 'list' 시간표 / 'map' 지도
  focus: null,      // 지도에서 강조할 장소 번호 (null이면 하루 전체)
  pickReturn: null, // 지도에서 위치 고른 뒤 돌아갈 화면
  dayBack: [],      // 뒤로 가기로 돌아갈 이전 날짜들
  stack: ['list'],  // 쌓인 화면: list(시간표) → detail(상세) → map(지도)
  detail: null,     // 상세 페이지로 보고 있는 장소 번호
};
const savePlan = () => store.set('tg.plan', S.plan);
const saveProgress = () => store.set('tg.progress', S.progress);
const saveLegs = () => store.set('tg.legs', S.legCache);

// 장소마다 다른 색 (지도 도형, 시간표 번호, 그 장소로 가는 선)
const PALETTE = ['#e53935', '#1e88e5', '#43a047', '#fb8c00', '#8e24aa', '#00897b', '#d81b60', '#3949ab', '#7cb342', '#6d4c41'];

// ---------- 일정 계산 ----------
const curDay = () => S.plan.days.find(d => d.date === S.selected) || null;
const progOf = date => (S.progress[date] ||= {});
const isLive = () => !!curDay() && (S.selected === todayStr() || S.settings.sim);
const atMs = (date, min) => dayStart(date) + min * 60000;
const hasPos = p => !!p && p.lat != null && p.lng != null;
const legKey = (a, b, mode) => `${mode}|${a.lat.toFixed(4)},${a.lng.toFixed(4)}|${b.lat.toFixed(4)},${b.lng.toFixed(4)}`;
const addDays = (date, n) => { const t = new Date(dayStart(date)); t.setDate(t.getDate() + n); return todayStr(t); };

function ensureDay(date) {
  let d = S.plan.days.find(x => x.date === date);
  if (!d) {
    d = { date, title: '', subtitle: '', notes: [], items: [] };
    S.plan.days.push(d);
    S.plan.days.sort((a, b) => a.date.localeCompare(b.date));
  }
  return d;
}

function legInfo(a, b, mode) {
  if (!hasPos(a) || !hasPos(b)) return { dur: null, dist: null, est: true };
  const c = S.legCache[legKey(a, b, mode)];
  if (c && !c.fail) return { ...c, est: false };
  const dist = haversine(a, b);
  return { dur: estimateMin(dist, mode), dist, est: true };
}

function dayPlan(d) {
  const legs = d.items.map((it, i) => (i ? legInfo(d.items[i - 1], it, it.mode) : null));
  const prog = S.progress[d.date] || {}, base = dayStart(d.date);
  const toMin = ts => (ts == null ? null : (ts - base) / 60000);
  const actual = d.items.map(it => ({ arr: toMin(prog[it.id]?.arr), dep: toMin(prog[it.id]?.dep) }));
  return { legs, sched: computeSchedule(d.items, legs, actual, S.settings.buffer) };
}

function recompute() {
  const d = curDay();
  S.cur = d ? dayPlan(d) : { legs: [], sched: [] };
}

const schedOf = d => (d === curDay() && S.cur.sched.length === d.items.length ? S.cur.sched : dayPlan(d).sched);

// 그 장소 일정이 끝나는 시각(ms): 다음 장소로 출발하는 시각, 마지막 장소면 체류가 끝나는 시각
function endMs(d, i) {
  const s = schedOf(d)[i], last = i === d.items.length - 1;
  return atMs(d.date, last ? (s.arrive ?? s.depart) + (d.items[i].stay || 0) : s.depart);
}

// 시간이 지나 끝난 일정인지 (지난 날은 전부, 오늘은 출발 시각이 지난 곳)
function isPast(d, i) {
  const t = todayStr();
  if (d.date < t) return true;
  if (d.date > t) return false;
  return Date.now() > endMs(d, i);
}

// 지금 어느 단계인지: 출발 전 / 체류 중 / 이동 중 / 끝
// 도착·출발 기록이 하나도 없으면 시간표 시각만으로 판단
function phase(d) {
  const prog = S.progress[d.date] || {};
  if (!d.items.some(it => prog[it.id])) return phaseByTime(d);
  let here = -1, last = -1;
  d.items.forEach((it, i) => {
    const p = prog[it.id];
    if (!p) return;
    if (p.arr && !p.dep) here = i;
    if (p.arr || p.dep || p.skip) last = i;
  });
  if (here >= 0) return { type: 'stay', i: here };
  if (last < 0) return { type: 'before', i: 0 };
  if (last >= d.items.length - 1) return { type: 'done' };
  return { type: 'move', i: last + 1 };
}

function phaseByTime(d) {
  const sched = schedOf(d), now = Date.now(), n = d.items.length;
  for (let k = 0; k < n; k++) {
    const arr = sched[k].arrive != null ? atMs(d.date, sched[k].arrive) : null;
    if (arr != null && now < arr) return k === 0 ? { type: 'before', i: 0 } : { type: 'move', i: k, timed: true };
    if (now < endMs(d, k)) return arr == null ? { type: 'before', i: 0 } : { type: 'stay', i: k, timed: true };
  }
  return { type: 'done' };
}

function itemState(d, i, ph) {
  const p = (S.progress[d.date] || {})[d.items[i].id] || {};
  if (ph?.type === 'move' && ph.i === i) return 'next';
  if (ph?.type === 'stay' && ph.i === i) return 'here';
  if (ph?.type === 'before' && i === 0) return 'here';
  if (p.skip) return 'skip';
  if (p.dep) return 'done';
  if (p.arr) return 'here';
  return isPast(d, i) ? 'done' : '';
}

const placeColor = (i, state) => (state === 'done' || state === 'skip' ? '#9e9e9e' : PALETTE[i % PALETTE.length]);

// 장소 번호: 엑셀에서 자동으로 넣은 "숙소 출발" 줄만 "출", 나머지는 1부터
const labelOf = (d, i) => (d.items[0]?.auto ? (i === 0 ? '출' : String(i)) : String(i + 1));

// ---------- 화면 ----------

function renderAll(fit) {
  renderHeader();
  renderTabs();
  renderStatus();
  renderTimeline();
  if (S.detail != null && S.stack.includes('detail')) {
    if (curDay()?.items[S.detail]) renderDetail();
    else { S.detail = null; S.stack = ['list']; applyLayers(); } // 상세로 보던 장소가 지워짐
  }
  renderMap(fit);
  renderCarousel();
  renderMapStatus();
}

function renderHeader() {
  $('#tripTitle').textContent = S.plan.title || '내 여행';
  const date = S.selected;
  if (!date) { $('#dayTitle').textContent = ''; return; }
  const [, m, dd] = date.split('-').map(Number);
  const w = '일월화수목금토'[new Date(dayStart(date)).getDay()];
  $('#dayTitle').textContent = `${m}월 ${dd}일 ${w}요일${date === todayStr() ? ' · 오늘' : ''}`;
}

function renderTabs() {
  const t = todayStr();
  const dates = [...new Set([...S.plan.days.map(d => d.date), S.selected])].filter(Boolean).sort();
  $('#dayTabs').innerHTML = dates.map(date =>
    `<button class="tab ${date === S.selected ? 'on' : ''} ${date < t ? 'past' : ''}" data-date="${date}">${date === t ? '<span class="today-dot"></span>' : ''}${dayLabel(date)}</button>`).join('');
  $('#dayTabs').hidden = dates.length < 2;
  $('#dayTabs .tab.on')?.scrollIntoView({ inline: 'center', block: 'nearest' });
}

const urgency = ms => (ms < 0 ? 'danger' : ms < S.settings.lead * 60000 ? 'warn' : '');

function nextLine(d, j) {
  const it = d.items[j], leg = S.cur.legs[j] || {}, m = MODES[it.mode];
  return `<div class="st-row">다음 <b>${esc(it.place)}</b> · ${m.icon} ${fmtDur(leg.dur)}${leg.est ? '(추정)' : ''} · ${fmtClock(S.cur.sched[j].arrive)} 도착</div>`;
}

const legButtons = i => `<button data-act="nav" data-i="${i}" class="primary">길안내 시작</button><button data-act="route" data-i="${i}">경로 추천</button>`;

// 남은 거리·시간 (실시간 경로를 받았으면 그 값, 아니면 직선거리로 추정)
function liveEta(it) {
  const useLive = S.live?.id === it.id;
  const dist = useLive && S.live.dist != null ? S.live.dist : haversine(S.pos, it);
  const est = useLive && S.live.dur != null ? S.live.dur : estimateMin(dist, it.mode);
  return { dist, est, eta: Date.now() + est * 60000 };
}

// ---------- 이동 중: 진행 막대 · 작은 지도 · 대중교통 단계 ----------
const polyCache = new Map();
const decodeCached = poly => {
  if (!poly) return null;
  if (!polyCache.has(poly)) polyCache.set(poly, decodePolyline(poly));
  return polyCache.get(poly);
};

// 이전 장소에서 출발한 시각(실제 기록이 있으면 그것)과 지금까지 지난 분
function moveTimes(d, i) {
  const prev = d.items[i - 1], p = progOf(d.date)[prev.id] || {};
  const dep = p.dep ?? atMs(d.date, S.cur.sched[i - 1].depart);
  return { dep, elapsed: Math.max(0, (Date.now() - dep) / 60000) };
}

function moveVisual(d, i) {
  const prev = d.items[i - 1], it = d.items[i];
  if (!prev || !hasPos(prev) || !hasPos(it)) return '';
  const leg = S.cur.legs[i] || {}, m = MODES[it.mode];
  const { elapsed } = moveTimes(d, i);
  // 얼마나 왔는지: 내 위치가 있으면 거리로, 없으면 시간으로
  let ratio;
  const total = leg.dist || haversine(prev, it) * 1.3;
  if (S.pos && !S.pos.stale) ratio = 1 - liveEta(it).dist / total;
  else ratio = leg.dur ? elapsed / leg.dur : 0;
  ratio = Math.min(1, Math.max(0, ratio));
  const pct = Math.round(ratio * 100);
  const bar = `<div class="trip-prog">
      <div class="tp-ends"><span>${esc(prev.place)}</span><span>${esc(it.place)}</span></div>
      <div class="tp-bar"><div class="tp-fill" style="width:${pct}%"></div><span class="tp-dot start"></span><span class="tp-dot end"></span><span class="tp-me" style="left:${pct}%">${m.icon}</span></div>
      <div class="tp-meta">${pct}% 왔어요${total ? ` · 전체 ${fmtDist(total)}` : ''}</div>
    </div>`;
  return bar + miniMapSvg(d, i) + transitSteps(leg, it, elapsed);
}

// 지도 화면에 가지 않아도 보이는 작은 동선 그림: 이전 장소(■) → 내 위치(●) → 다음 장소(◎)
function miniMapSvg(d, i) {
  const prev = d.items[i - 1], it = d.items[i], leg = S.cur.legs[i] || {};
  const planned = decodeCached(leg.poly) || [prev, it];
  const live = S.live?.id === it.id && S.live.path?.length && S.pos ? [S.pos, ...S.live.path] : null;
  const me = S.pos && !S.pos.stale ? S.pos : null;
  const pts = [...planned, prev, it, ...(me ? [me] : []), ...(live || [])];
  const lat0 = pts.reduce((a, p) => a + p.lat, 0) / pts.length, k = Math.cos(lat0 * Math.PI / 180);
  const xs = pts.map(p => p.lng * k), ys = pts.map(p => -p.lat);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const W = 320, H = 130, pad = 16;
  const sc = Math.min((W - pad * 2) / Math.max(maxX - minX, 1e-6), (H - pad * 2) / Math.max(maxY - minY, 1e-6));
  const ox = (W - (maxX - minX) * sc) / 2, oy = (H - (maxY - minY) * sc) / 2;
  const P = p => [((p.lng * k - minX) * sc + ox).toFixed(1), ((-p.lat - minY) * sc + oy).toFixed(1)];
  const line = a => a.map(P).map(q => q.join(',')).join(' ');
  const [px, py] = P(prev), [tx, ty] = P(it);
  const meDot = me ? (() => { const [mx, my] = P(me); return `<circle cx="${mx}" cy="${my}" r="9" class="mm-halo"/><circle cx="${mx}" cy="${my}" r="5" class="mm-me"/>`; })() : '';
  return `<button class="mini-map" data-act="openMap" data-i="${i}" aria-label="지도로 크게 보기">
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
      <polyline points="${line(planned)}" class="mm-plan"/>
      ${live ? `<polyline points="${line(live)}" class="mm-live"/>` : ''}
      <rect x="${px - 5}" y="${py - 5}" width="10" height="10" rx="2" class="mm-start"/>
      <circle cx="${tx}" cy="${ty}" r="7" class="mm-end"/><circle cx="${tx}" cy="${ty}" r="3" class="mm-end-in"/>
      ${meDot}
    </svg><span class="mm-hint">누르면 큰 지도</span></button>`;
}

// 대중교통: 🚶 3분 → 🚇 T1 4정거장 → 🚶 2분, 지금 단계 강조 (출발 뒤 지난 시간 기준)
function transitSteps(leg, it, elapsed) {
  if (it.mode !== 'TRANSIT' || !leg.segs?.length) return '';
  let acc = 0, cur = leg.segs.length - 1;
  for (let j = 0; j < leg.segs.length; j++) { acc += leg.segs[j].dur || 0; if (elapsed < acc) { cur = j; break; } }
  const chip = (s, j) => {
    const txt = s.type === 'TRANSIT'
      ? `${s.icon} ${esc(s.line || '')}${s.stops ? ` ${s.stops}정거장` : ''}`
      : `${s.type === 'WALK' ? '🚶' : '🚗'} ${fmtDur(s.dur)}`;
    const tip = s.type === 'TRANSIT' && s.from ? ` title="${esc(s.from)} → ${esc(s.to)}"` : '';
    return `<span class="ts-step ${j < cur ? 'done' : j === cur ? 'now' : ''}"${tip}>${txt}</span>`;
  };
  const now = leg.segs[cur];
  const where = now.type === 'TRANSIT' ? `${esc(now.from)} → ${esc(now.to)} (${esc(now.headsign || '')})` : '';
  return `<div class="transit-steps">${leg.segs.map(chip).join('<span class="ts-arrow">›</span>')}</div>${where ? `<div class="st-row small">지금: ${where}</div>` : ''}`;
}

// 카드 오른쪽 위 작은 버튼: 일정과 상관없이 지금 내 위치 근처 편의점·약국·병원
const NEAR_ME = {
  conv: { icon: '🏪', label: '편의점' },
  pharmacy: { icon: '💊', label: '약국' },
  hospital: { icon: '🏥', label: '병원' },
};
const quickNear = () => `<div class="quick-near">${Object.entries(NEAR_ME).map(([t, v]) =>
  `<button data-act="nearMe" data-type="${t}" aria-label="내 주변 ${v.label}" title="내 주변 ${v.label}">${v.icon}</button>`).join('')}</div>`;

function renderStatus() {
  const el = $('#status'), d = curDay();
  if (!d || !d.items.length) { el.innerHTML = ''; el.hidden = true; return; }
  el.hidden = false;
  if (S.cur.sched.length !== d.items.length) recompute(); // 일정이 바뀐 직후면 다시 계산
  const { sched } = S.cur, items = d.items, now = Date.now();
  el.classList.toggle('calm', !isLive());

  if (!isLive()) {
    const t = todayStr(), last = sched[items.length - 1];
    const firstDep = atMs(d.date, sched[0].depart);
    const when = d.date < t ? '지난 일정 · 모두 완료' : d.date === addDays(t, 1) ? '내일 일정' : '예정된 일정';
    el.innerHTML = `${quickNear()}<div class="st-label">${when}</div>
      <div class="st-title">${esc(d.title || `장소 ${items.length}곳`)}</div>
      <div class="st-row">${fmtClock(sched[0].depart)} 출발 → ${fmtClock(last.arrive ?? last.depart)} 마침 · ${items.length}곳</div>
      ${d.date > t ? `<div class="st-big"><small>첫 출발까지</small><span data-cd="${firstDep}">${fmtCountdown(firstDep - now)}</span></div>` : ''}
      ${d.date >= t ? `<div class="st-actions">${wakeButton(d)}<button data-act="toggleView">하루 동선 지도</button></div>` : ''}`;
    return;
  }

  const ph = phase(d);
  let html;
  if (ph.type === 'done') {
    el.classList.add('calm');
    const next = S.plan.days.find(x => x.date > d.date && x.items.length);
    html = `<div class="st-label">오늘 일정</div><div class="st-title">🎉 오늘 일정을 모두 마쳤어요</div>
      ${next ? `<div class="st-actions"><button class="primary" data-act="goDay" data-date="${next.date}">${dayLabel(next.date)} 일정 보기</button></div>` : ''}`;
  } else if (ph.type === 'before' || (ph.type === 'stay' && ph.i === 0)) {
    const dep = atMs(d.date, sched[0].depart);
    html = `<div class="st-label">${ph.type === 'stay' ? '출발지에 있어요' : '일정 시작 전'} · ${esc(items[0].place)}</div>
      <div class="st-big ${urgency(dep - now)}"><small>출발까지</small><span data-cd="${dep}">${fmtCountdown(dep - now)}</span></div>
      <div class="st-row">${fmtClock(sched[0].depart)}에 출발하세요</div>
      ${items[1] ? nextLine(d, 1) : ''}
      <div class="st-actions">${items[1] ? legButtons(1) : ''}<button data-act="depart" data-i="0">출발 처리</button>${wakeButton(d)}</div>`;
  } else if (ph.type === 'stay') {
    const i = ph.i, it = items[i], s = sched[i], next = items[i + 1];
    const arr = progOf(d.date)[it.id]?.arr ?? atMs(d.date, s.arrive);
    const dep = atMs(d.date, s.depart);
    html = `<div class="st-label">지금 여기 · ${labelOf(d, i)}번</div>
      <div class="st-title">${esc(it.place)}</div>
      <div class="st-row">${clockOf(arr)} 도착 ${s.late ? `<span class="badge">${s.late}분 늦음</span>` : ''} · 머문 시간 <span data-el="${arr}">${fmtDur((now - arr) / 60000)}</span></div>
      ${next ? `<div class="st-big ${urgency(dep - now)}"><small>출발까지</small><span data-cd="${dep}">${fmtCountdown(dep - now)}</span></div>
      <div class="st-row">${fmtClock(s.depart)} 출발 ${s.short ? `<span class="badge">체류 ${s.short}분 부족</span>` : ''}</div>${nextLine(d, i + 1)}`
        : '<div class="st-row">마지막 장소예요. 오늘 일정 끝!</div>'}
      <div class="st-actions">${next ? legButtons(i + 1) + `<button data-act="depart" data-i="${i}">출발 처리</button>` : ''}</div>`;
  } else {
    const i = ph.i, it = items[i], s = sched[i], m = MODES[it.mode];
    let live = `<div class="st-row">${S.pos ? '이 장소는 위치 정보가 없어요' : '내 위치 확인 중…'}</div>`;
    if (S.pos && hasPos(it)) {
      const { dist, est, eta } = liveEta(it);
      const diff = Math.round((eta - atMs(d.date, s.arrive)) / 60000);
      const badge = diff > 2 ? `<span class="badge">${diff}분 늦음</span>` : diff < -2 ? `<span class="badge">${-diff}분 여유</span>` : '<span class="badge">제시간</span>';
      live = `<div class="st-big"><small>남은 거리</small>${fmtDist(dist)}</div>
        <div class="st-row">약 ${fmtDur(est)} · ${clockOf(eta)} 도착 예상 ${badge}</div>`;
    }
    html = `<div class="st-label">이동 중 → ${labelOf(d, i)}번 · ${m.icon} ${m.label}</div>
      <div class="st-title">${esc(it.place)}</div>${live}
      <div class="st-row">계획 ${fmtClock(s.arrive)} 도착${it.time != null ? ' (예약)' : ''}</div>
      ${moveVisual(d, i)}
      <div class="st-actions"><button class="primary" data-act="openMap" data-i="${i}">지도로 길 보기</button><button data-act="nav" data-i="${i}">길안내</button><button data-act="arrive" data-i="${i}">도착 처리</button></div>`;
  }
  el.innerHTML = quickNear() + html;
}

function wakeButton(d) {
  const w = d.wake;
  return `<button class="${w?.on ? 'wake-on' : 'primary'}" data-act="wake" data-date="${d.date}">⏰ ${w?.on ? `모닝콜 ${fmtClock(w.time)}` : '모닝콜 설정'}</button>`;
}

// "a. 커피  b. 페이스트리" → ['커피', '페이스트리']
const splitChips = t => t.split(/\s+(?=[a-zA-Z]\.\s)/).map(x => x.replace(/^[a-zA-Z]\.\s*/, '').trim()).filter(Boolean);

function notesHtml(it, i) {
  const parts = (it.notes || []).map(n => n.label === '주변 추천'
    ? `<div class="note"><div class="note-label">주변 추천 <span class="muted small">· 누르면 위치와 정보</span></div><div class="chips">${splitChips(n.text).map(c => `<button class="chip poi" data-act="poi" data-i="${i}" data-name="${esc(c)}">📍 ${esc(c)}</button>`).join('')}</div></div>`
    : `<div class="note"><div class="note-label">${esc(n.label)}</div><div>${esc(n.text)}</div></div>`);
  if (it.memo) parts.push(`<div class="note"><div class="note-label">메모</div><div class="pre">${esc(it.memo)}</div></div>`);
  return parts.join('');
}


function dayHeaderHtml(d, done) {
  const n = d?.items.length || 0;
  const title = d?.title || (n ? `오늘의 동선 · ${n}곳` : '');
  const wake = d?.wake?.on ? `<button class="progress wake" data-act="wake" data-date="${d.date}">⏰ ${fmtClock(d.wake.time)}</button>` : '';
  return `<div class="day-head"><div><div class="t">${esc(title)}</div>${d?.subtitle ? `<div class="s">${esc(d.subtitle)}</div>` : ''}</div>
    <div class="head-pills">${wake}${n ? `<span class="progress">${done}/${n} 완료</span>` : ''}</div></div>`;
}

// 표 아래 요약·가이드 메모를 읽기 좋게
function dayNotesHtml(d) {
  if (!d?.notes?.length) return '';
  const out = [];
  let list = [];
  const flush = () => { if (list.length) out.push(`<ol>${list.join('')}</ol>`); list = []; };
  for (const line of d.notes) {
    const [head, ...rest] = line.split('\n').map(s => s.trim()).filter(Boolean);
    const m = head.match(/^\d+\.\s*(.*)$/);
    if (m && !rest.length) { list.push(`<li>${esc(m[1])}</li>`); continue; }
    flush();
    out.push(`<div class="note-label">${esc(head.replace('초등학생도 따라가기 쉬운 ', ''))}</div>`);
    if (rest.length) out.push(`<ul>${rest.map(r => `<li>${esc(r.replace(/^[•·-]\s*/, ''))}</li>`).join('')}</ul>`);
  }
  flush();
  return `<div class="day-notes">${out.join('')}</div>`;
}

function renderTimeline() {
  const el = $('#timeline'), d = curDay(), date = S.selected;
  if (!date) { el.innerHTML = ''; return; }
  if (!d || !d.items.length) {
    const [, mm, dd] = date.split('-').map(Number);
    el.innerHTML = `<div class="empty">${quickNear()}
        <div class="empty-icon">🧳</div>
        <h2>${date === todayStr() ? '오늘 떠날 여행' : `${mm}월 ${dd}일 떠날 여행`}</h2>
        <p>가고 싶은 곳(도착지)을 고르고, 어디서 출발할지 정하면 동선과 출발 시간이 자동으로 계산되고 지도에 표시돼요.</p>
        <p class="muted small">← 화면을 좌우로 밀면 다른 날짜로 넘어가요 →</p>
        <div class="st-actions"><button class="primary" data-act="addPlace" data-i="0">＋ 어디로 갈까요?</button>
        <button data-act="guide">📄 엑셀로 여행 전체 넣기</button></div>
        ${S.plan.days.length ? '' : '<p class="muted small">여행 일정이 길다면 양식을 받아 ChatGPT·Claude·Gemini에게 채워 달라고 하면 한 번에 넣을 수 있어요.</p>'}
      </div>`;
    return;
  }
  const { legs, sched } = S.cur, ph = isLive() ? phase(d) : null, n = d.items.length;
  const states = d.items.map((_, i) => itemState(d, i, ph));
  // 식사 시간인데 식당·카페 일정이 없는 자리 → 점선 "식사 추가" 칸 (지난 날은 생략)
  const gaps = {};
  if (d.date >= todayStr()) for (const g of [...mealGaps(d), ...extraGaps(d)]) (gaps[g.k] ||= []).push(g);
  const rows = d.items.map((it, i) => {
    const s = sched[i], state = states[i], done = state === 'done' || state === 'skip', color = placeColor(i, state);
    let leg = '';
    if (i > 0) {
      const l = legs[i], m = MODES[it.mode];
      leg = `<div class="row-leg ${done ? 'done' : ''}"><span>${m.icon} ${fmtDur(l.dur)}${l.dist != null ? ` · ${fmtDist(l.dist)}` : ''}</span></div>`;
    }
    // 여유 = 도착해서 다음 장소로 떠나기 전까지 남는 시간 (정해 둔 체류시간이 아니라 실제 시간표 기준)
    const isArr = s.arrive != null, free = i < n - 1 && s.stayEff > 0 ? s.stayEff : 0;
    const tag = state === 'here' ? '<span class="row-tag now">지금</span>' : state === 'next' ? '<span class="row-tag next">다음</span>'
      : done ? `<span class="row-tag">${state === 'skip' ? '건너뜀' : '완료'}</span>` : '';
    // 하루의 첫 장소는 머물던 곳이자 출발지: "00:00에 떠나기"만
    const first = i === 0 && n > 1;
    const sub = first ? `${fmtClock(s.depart)}에 떠나기`
      : [isArr ? '도착' : '출발', free ? `${fmtDur(free)}의 여유` : '', i < n - 1 && isArr ? `${fmtClock(s.depart)} 출발` : ''].filter(Boolean).join(' · ');
    return `${leg}<div class="row ${state}" data-act="openDetail" data-i="${i}" style="--c:${color}">
      <div class="row-time">${fmtClock(first || !isArr ? s.depart : s.arrive)}</div>
      <div class="row-main">
        <div class="row-name">${esc(it.place)}${tag}${it.files?.length ? `<button class="clip" data-act="files" data-i="${i}" aria-label="첨부 파일 보기">📎${it.files.length > 1 ? `<small>${it.files.length}</small>` : ''}</button>` : ''}</div>
        <div class="row-sub">${sub}${s.late > 0 && !done ? ` <span class="late-tag">⚠ ${fmtDur(s.late)} 늦음</span>` : ''}${hasPos(it) ? '' : ` · <button class="bad" data-act="fixPlace" data-i="${i}">⚠ 위치 없음 · 눌러서 찾기</button>`}</div>
      </div>
      <span class="row-num ${i === 0 ? 'sq' : ''}">${done ? '✓' : labelOf(d, i)}</span>
    </div>${(gaps[i] || []).map(g => `<div class="suggest-slot ${g.icon ? g.type : ''}" data-act="suggest" data-type="${g.type}" data-k="${i}">
      ${g.icon ? `<span>${g.icon} ${g.label} <span class="muted">· ${g.text}</span></span>`
        : `<span>🍽 ${g.label} 추가 <span class="muted">· ${fmtClock(g.center)} 무렵 · 근처 맛집 추천</span></span>`}
      <button class="suggest-x" data-act="suggestSkip" data-type="${g.skip || g.type}" aria-label="숨기기">✕</button></div>`).join('')}`;
  }).join('');
  const doneCount = states.filter(s => s === 'done' || s === 'skip').length;
  el.innerHTML = `${dayHeaderHtml(d, doneCount)}<div class="rows">${rows}</div>
    <button class="add-btn" data-act="addPlace" data-i="${n}">＋ 장소 추가</button>
    ${dayNotesHtml(d)}`;
}

// ---------- 식사 빈칸 찾기 ----------
const MEALS = [
  { type: 'brunch', label: '아침·브런치', ws: 7 * 60 + 30, we: 10 * 60 + 30, center: 9 * 60, stay: 45 },
  { type: 'lunch', label: '점심', ws: 11 * 60 + 30, we: 14 * 60, center: 12 * 60 + 30, stay: 60 },
  { type: 'dinner', label: '저녁', ws: 17 * 60 + 30, we: 20 * 60 + 30, center: 19 * 60, stay: 75 },
];
const FOOD_RE = /식당|레스토랑|음식|맛집|카페|커피|브런치|아침|조식|점심|저녁|식사|디너|런치|그릴|바(?:\s|$)|펍|스낵|음료|베이커리|빵|피시마켓|푸드|야시장|디저트|요치|cafe|coffee|restaurant|grill|bistro|diner|\bbar\b|pub|bakery|brunch|lunch|dinner|breakfast|kitchen|eatery|food/i;

// 식사 말고 다른 추천 칸
const FREE_MIN = 120;      // 이만큼 여유가 생기면 근처 카페·소품샵·명소 추천
const NIGHT_BEFORE = 19 * 60; // 숙소에 이 시각보다 일찍 들어가면 숙소 근처 밤 추천
const EXTRA = {
  free: { type: 'free', icon: '☕', label: '여유 시간 둘러보기', what: '카페·소품샵·명소', web: 'cafe gift shop attractions', stay: 60 },
  night: { type: 'night', icon: '🌙', label: '숙소 근처 밤 나들이', what: '술집·야식·편의점', web: 'bar late night food convenience store', stay: 60 },
};

// 받침이 있으면 "을", 없으면 "를"
const eul = w => { const c = w.charCodeAt(w.length - 1) - 0xac00; return c >= 0 && c < 11172 && c % 28 ? '을' : '를'; };

// 일정 사이 2시간 넘는 여유, 일찍 숙소에 들어간 저녁 → 추천 칸
function extraGaps(d) {
  const sched = S.cur.sched, n = d.items.length, out = [];
  if (n < 2 || sched.length !== n) return out;
  const skip = d.skipMeals || {}; // 숨긴 추천 칸 (저장된 이름이라 그대로 둠: 식사·여유·밤 모두)
  for (let i = 1; i < n - 1; i++) {
    const it = d.items[i], s = sched[i];
    if (s.arrive == null || !(s.stayEff >= FREE_MIN) || isHotel(it.place) || skip[`free-${it.id}`]) continue;
    out.push({ ...EXTRA.free, k: i, skip: `free-${it.id}`, when: `${fmtClock(s.arrive)}~${fmtClock(s.depart)}`, free: s.stayEff,
      text: `${fmtDur(s.stayEff)}의 여유 · 근처 ${EXTRA.free.what} 추천` });
  }
  const last = d.items[n - 1], ls = sched[n - 1], arr = ls.arrive ?? ls.depart;
  if (isHotel(last.place) && arr < NIGHT_BEFORE && !skip.night) {
    out.push({ ...EXTRA.night, k: n - 1, skip: 'night', when: `${fmtClock(Math.max(NIGHT_BEFORE, arr + 60))} 이후`,
      text: `${fmtClock(arr)}에 숙소 도착 · 근처 ${EXTRA.night.what} 추천` });
  }
  return out;
}

// 이 일정이 식사 자리인지 (이름·메모·설명에서 판단)
const isFood = it => FOOD_RE.test([it.place, it.memo, ...(it.notes || []).map(n => n.text)].join(' '));

function mealGaps(d) {
  const sched = S.cur.sched, n = d.items.length;
  if (n < 2 || sched.length !== n) return [];
  const startT = sched[0].depart, last = sched[n - 1], endT = last.arrive ?? last.depart;
  const out = [];
  for (const m of MEALS) {
    if (d.skipMeals?.[m.type]) continue;
    if (startT > m.we - 30 || endT < m.ws + 30) continue; // 그 시간대에 여행 중이 아님
    const covered = d.items.some((it, i) => {
      if (!isFood(it)) return false;
      const a = sched[i].arrive ?? sched[i].depart, b = Math.max(sched[i].depart, a + (it.stay || 0));
      return a < m.we && b > m.ws;
    });
    if (covered) continue;
    // 그 식사 시각에 머물고 있거나 막 지나온 장소 뒤에 끼워 넣음
    let k = 0;
    sched.forEach((s, i) => { if ((s.arrive ?? s.depart) <= m.center) k = i; });
    out.push({ ...m, k });
  }
  return out;
}

// ---------- 일정 상세 페이지 ----------
function renderDetail() {
  const el = $('#detailView'), d = curDay(), i = S.detail;
  const it = d?.items[i];
  if (!it) { el.innerHTML = ''; return; }
  const { legs, sched } = S.cur, s = sched[i], n = d.items.length, ph = isLive() ? phase(d) : null;
  const state = itemState(d, i, ph), color = placeColor(i, state), p = (S.progress[d.date] || {})[it.id] || {};
  const free = i < n - 1 && s.stayEff > 0 ? s.stayEff : 0;
  const stateTag = { done: '완료한 일정', skip: '건너뛴 일정', here: '지금 여기', next: '다음 목적지' }[state] || '';
  const prev = d.items[i - 1], l = legs[i], m = MODES[it.mode];
  const warns = [];
  if (s.late) warns.push(`예약 시각보다 ${s.late}분 늦어요`);
  el.innerHTML = `<div class="dt-scroll">
    <div class="dt-hero" style="--c:${color}">
      <div class="dt-kicker"><span class="dt-num ${i === 0 ? 'sq' : ''}">${state === 'done' ? '✓' : labelOf(d, i)}</span>${dayLabel(d.date)} · ${i + 1}/${n}번째</div>
      <h1>${esc(it.place)}</h1>
      ${stateTag ? `<span class="dt-state ${state}">${stateTag}</span>` : ''}
      ${it.address ? `<div class="dt-addr">${esc(it.address)}</div>` : ''}
    </div>
    ${i === 0 && n > 1
      ? `<div class="dt-times one"><div><span>출발지</span><b>${fmtClock(s.depart)}에 떠나기</b>${p.dep ? `<em>실제 ${clockOf(p.dep)} 출발</em>` : ''}</div></div>`
      : `<div class="dt-times">
      <div><span>도착</span><b>${s.arrive != null ? fmtClock(s.arrive) : '—'}</b>${p.arr ? `<em>실제 ${clockOf(p.arr)}</em>` : ''}</div>
      <div><span>여유</span><b>${free ? fmtDur(free) : '—'}</b></div>
      <div><span>출발</span><b>${i < n - 1 ? fmtClock(s.depart) : '—'}</b>${p.dep ? `<em>실제 ${clockOf(p.dep)}</em>` : ''}</div>
    </div>`}
    ${warns.map(w => `<div class="dt-warn">⚠ ${esc(w)}</div>`).join('')}
    ${hasPos(it) ? '' : `<button class="dt-warn fix" data-act="fixPlace" data-i="${i}">⚠ 위치를 찾지 못했어요 · <u>눌러서 지도에서 찾기</u></button>`}
    <div class="dt-card"><div class="dt-dist" data-dist="${i}">📍 내 위치를 확인하는 중…</div></div>
    ${i > 0 ? `<div class="dt-card">
      <div class="note-label">가는 방법 · ${esc(prev.place)}에서</div>
      <div class="dt-leg">${m.icon} <b>${m.label} ${fmtDur(l.dur)}</b>${l.dist != null ? ` · ${fmtDist(l.dist)}` : ''}${l.est ? '<span class="est">추정</span>' : ''}</div>
      <div class="st-actions"><button data-act="route" data-i="${i}">경로 보기</button><button class="primary" data-act="nav" data-i="${i}">길안내 시작</button></div>
    </div>` : ''}
    ${(it.notes || []).length || it.memo ? `<div class="dt-card">${notesHtml(it, i)}</div>` : ''}
    <div class="dt-card">
      <div class="note-label">📎 첨부 파일 <span class="muted small">· 바우처, 예약 티켓 사진이나 PDF</span></div>
      <div class="att-grid" data-att="${i}"></div>
      <button class="chip-btn" data-act="attach" data-i="${i}">＋ 사진·파일 첨부</button>
    </div>
    <div class="dt-card dt-acts">
      <button data-act="editPlace" data-i="${i}">✏️ 수정</button>
      <button data-act="addPlace" data-i="${i + 1}">＋ 이 장소 뒤에 일정 넣기</button>
      ${i > 0 ? `<button data-act="moveUp" data-i="${i}">↑ 순서 앞으로</button>` : ''}
      ${i < n - 1 ? `<button data-act="moveDown" data-i="${i}">↓ 순서 뒤로</button>` : ''}
      ${isLive() && i > 0 ? `<button data-act="arrive" data-i="${i}">도착 처리</button>` : ''}
      ${isLive() && i < n - 1 ? `<button data-act="depart" data-i="${i}">출발 처리</button>` : ''}
      ${p.arr || p.dep || p.skip ? `<button data-act="clear" data-i="${i}">기록 지우기</button>` : ''}
      ${hasPos(it) ? `<button data-act="gmap" data-i="${i}">지도 앱에서 보기</button>` : ''}
      <button data-act="delPlace" data-i="${i}" class="danger">삭제</button>
    </div>
    <div class="dt-nav">
      ${i > 0 ? `<button data-act="openDetail" data-i="${i - 1}" data-swap="1">‹ ${esc(prev.place)}</button>` : '<span></span>'}
      ${i < n - 1 ? `<button data-act="openDetail" data-i="${i + 1}" data-swap="1">${esc(d.items[i + 1].place)} ›</button>` : ''}
    </div>
    <button class="dt-pull" data-act="detailMap"><span class="grab"></span>위로 밀거나 눌러서 지도 보기</button>
  </div>`;
  updateDistances();
  fillAttachments(i);
}

// ---------- 첨부 파일 (바우처·예약 티켓) ----------
const urls = new Set(); // 화면에 쓴 사진 주소 (다 쓰면 메모리 정리)
const blobUrl = b => { const u = URL.createObjectURL(b); urls.add(u); return u; };
const freeUrls = () => { urls.forEach(u => URL.revokeObjectURL(u)); urls.clear(); };

// 상세 페이지 첨부 칸에 작은 미리보기
async function fillAttachments(i) {
  const box = document.querySelector(`[data-att="${i}"]`), it = curDay()?.items[i];
  if (!box || !it) return;
  const files = it.files || [];
  if (!files.length) { box.innerHTML = '<div class="muted small pad">아직 첨부한 파일이 없어요</div>'; return; }
  box.innerHTML = files.map((f, k) => `<button class="att-thumb" data-act="viewFile" data-i="${i}" data-k="${k}">${isPdf(f) ? '<span class="pdf">PDF</span>' : '<span class="ph"></span>'}<em>${esc(f.name)}</em></button>`).join('');
  for (const [k, f] of files.entries()) {
    if (isPdf(f)) continue;
    const rec = await getFile(f.id).catch(() => null);
    const el = box.querySelector(`[data-k="${k}"] .ph`);
    if (rec && el) el.style.backgroundImage = `url(${blobUrl(rec.blob)})`;
  }
}

// 첨부 고르기: target이 'draft'면 수정 창, 아니면 그 일정에 바로 붙임
async function attachFiles(fileList) {
  const to = S.attachTo;
  S.attachTo = null;
  if (!to || !fileList.length) return;
  const metas = [];
  for (const f of fileList) {
    try { metas.push(await saveFile(f)); } catch (e) { toast(`첨부 실패: ${e.message}`, 5000); }
  }
  if (!metas.length) return;
  if (to.draft && S.sheet?.type === 'edit') {
    const sh = S.sheet;
    sh.draft.files = [...(sh.draft.files || []), ...metas];
    (sh.added ||= []).push(...metas.map(m => m.id));
    renderSheet();
  } else {
    const it = curDay()?.items[to.i];
    if (!it) return;
    it.files = [...(it.files || []), ...metas];
    savePlan();
    renderTimeline();
    if (topLayer() === 'detail') renderDetail();
  }
  toast(`📎 ${metas.length}개 첨부했어요`);
}

// 크게 보기: 사진은 화면에 맞춰, PDF는 페이지별로. 여러 개면 좌우로 넘기기
async function openViewer(i, k) {
  const it = curDay()?.items[i], f = it?.files?.[k];
  if (!f) return;
  S.viewer = { i, k };
  const el = $('#viewer'), n = it.files.length;
  el.hidden = false;
  el.innerHTML = `<div class="vw-top">
      <button class="vw-btn" data-act="closeViewer" aria-label="닫기">✕</button>
      <div class="vw-title"><b>${esc(f.name)}</b><span>${esc(it.place)}${n > 1 ? ` · ${k + 1}/${n}` : ''}</span></div>
      <button class="vw-btn" data-act="delFile" aria-label="첨부 삭제">🗑</button>
    </div>
    <div class="vw-body"><div class="muted pad">불러오는 중…</div></div>
    ${n > 1 ? `<button class="vw-nav prev" data-act="vwPrev" ${k === 0 ? 'disabled' : ''}>‹</button><button class="vw-nav next" data-act="vwNext" ${k === n - 1 ? 'disabled' : ''}>›</button>` : ''}`;
  const body = el.querySelector('.vw-body');
  const rec = await getFile(f.id).catch(() => null);
  if (S.viewer?.k !== k || S.viewer?.i !== i) return;
  if (!rec) { body.innerHTML = '<div class="muted pad">파일을 찾을 수 없어요 (다른 휴대폰에서 첨부했거나 지워졌어요)</div>'; return; }
  body.innerHTML = '';
  if (isPdf(f)) {
    try { await renderPdf(rec.blob, body); } catch { body.innerHTML = '<div class="muted pad">PDF를 열지 못했어요</div>'; }
  } else {
    body.innerHTML = `<img src="${blobUrl(rec.blob)}" alt="${esc(f.name)}">`;
  }
}

function closeViewer() {
  S.viewer = null;
  $('#viewer').hidden = true;
  $('#viewer').innerHTML = '';
  freeUrls();
  if (topLayer() === 'detail') fillAttachments(S.detail);
}

async function deleteAttachment() {
  const { i, k } = S.viewer, it = curDay().items[i], f = it.files[k];
  if (!confirm(`"${f.name}" 첨부를 지울까요?`)) return;
  it.files.splice(k, 1);
  await deleteFile(f.id).catch(() => {});
  savePlan();
  renderTimeline();
  if (topLayer() === 'detail') renderDetail();
  if (it.files.length) openViewer(i, Math.min(k, it.files.length - 1)); else closeViewer();
  toast('첨부를 지웠어요');
}

// 장소마다 "내 위치에서 얼마나 먼지" (GPS가 바뀔 때마다 갱신)
function updateDistances() {
  const d = curDay();
  if (!d) return;
  document.querySelectorAll('[data-dist]').forEach(el => {
    const it = d.items[+el.dataset.dist];
    if (!it) return;
    if (!hasPos(it)) { el.textContent = '📍 위치가 없어 거리를 알 수 없어요'; return; }
    if (!S.pos) { el.textContent = '📍 내 위치를 확인하는 중…'; return; }
    const dist = haversine(S.pos, it);
    el.textContent = dist < S.settings.radius ? '📍 지금 여기 있어요'
      : `📍 내 위치에서 ${fmtDist(dist)} · ${MODES[it.mode].icon} 약 ${fmtDur(estimateMin(dist, it.mode))}`;
  });
}

const polyMemo = new Map();
const decodeMemo = s => { if (!polyMemo.has(s)) polyMemo.set(s, decodePolyline(s)); return polyMemo.get(s); };

function renderMap(fit) {
  if (!S.map) return;
  const d = curDay(), ph = d && isLive() ? phase(d) : null;
  const pts = [], places = [];
  d?.items.forEach((it, i) => {
    if (!hasPos(it)) return;
    pts.push(it);
    const st = itemState(d, i, ph), focus = S.focus === i;
    places.push({
      lat: it.lat, lng: it.lng, label: st === 'done' ? '✓' : labelOf(d, i), color: placeColor(i, st), title: it.place,
      shape: i === 0 ? 'square' : 'circle', ring: focus || (S.focus == null && st === 'next'), z: focus ? 15 : st === 'next' ? 10 : 2,
      onClick: () => focusMapItem(i),
    });
  });
  // 추가/수정 중인 장소 미리보기
  const dr = S.sheet?.type === 'edit' ? S.sheet.draft : null;
  const og = S.sheet?.type === 'edit' && S.sheet.trip ? S.sheet.origin : null;
  if (hasPos(og)) places.push({ lat: og.lat, lng: og.lng, label: '출', color: '#43a047', shape: 'square', ring: true, z: 19, title: og.place });
  if (S.poi) places.push({ lat: S.poi.lat, lng: S.poi.lng, label: '★', color: '#ff7043', ring: true, z: 18, title: S.poi.name });
  if (hasPos(dr)) places.push({ lat: dr.lat, lng: dr.lng, label: '＋', color: '#fdd835', textColor: '#000', ring: true, z: 20, title: dr.place });
  S.map.setPlaces(places);
  drawLines();
  if (fit) S.map.fit([...pts, ...[og, dr].filter(hasPos)]);
}

// 동선 선: 장소 사이(그 장소 색, 선택한 구간은 굵게), 경로 추천에서 고른 길, 내 위치 → 다음 장소 실시간 길(파란 굵은 선)
function drawLines() {
  if (!S.map) return;
  const d = curDay(), lines = [], ph = d && isLive() ? phase(d) : null;
  d?.items.forEach((it, i) => {
    const a = d.items[i - 1];
    if (!i || !hasPos(a) || !hasPos(it)) return;
    const l = S.cur.legs[i] || {}, color = placeColor(i, itemState(d, i, ph));
    const focus = S.focus === i, dim = S.focus != null && !focus;
    const style = { color, width: focus ? 7 : 4, opacity: dim ? 0.3 : focus ? 1 : 0.7, z: focus ? 6 : 1 };
    if (l.est === false && l.poly) lines.push({ path: decodeMemo(l.poly), ...style });
    else lines.push({ path: [a, it], dashed: true, ...style, width: focus ? 4 : 3 });
  });
  const sh = S.sheet;
  if (sh?.type === 'edit' && hasPos(sh.draft)) {
    const prev = sh.trip ? originOf(sh) : d?.items[sh.index - 1];
    if (hasPos(prev) && !sh.id) lines.push({ path: [prev, sh.draft], color: '#fdd835', dashed: true, width: 3 });
  }
  if (S.routeView) lines.push({ path: S.routeView.path, color: S.routeView.color, width: 7, opacity: 0.95, z: 7 });
  const poiFrom = S.poi && d?.items[S.poi.from];
  if (hasPos(poiFrom)) lines.push({ path: [poiFrom, S.poi], color: '#ff7043', dashed: true, width: 3, z: 7 });
  if (S.live && S.pos) {
    const path = S.live.path?.length ? [S.pos, ...S.live.path] : [S.pos, S.live.to];
    lines.push({ path, color: '#ffffff', width: 10, opacity: 0.9, z: 8 });
    lines.push({ path, color: '#1a73e8', width: 6, opacity: 1, z: 9 });
  }
  S.map.setLines(lines);
}

// 지도 아래 장소 카드 (옆으로 넘기면 지도도 그 장소로, 누르면 시간표의 그 일정으로)
function renderCarousel() {
  const el = $('#carousel'), d = curDay();
  if (!d?.items.length) { el.innerHTML = ''; return; }
  const ph = isLive() ? phase(d) : null, n = d.items.length;
  el.innerHTML = d.items.map((it, i) => {
    const s = S.cur.sched[i], st = itemState(d, i, ph), l = S.cur.legs[i];
    const sub = i === 0 && n > 1 ? `${fmtClock(s.depart)}에 떠나기`
      : [s.arrive != null ? `${fmtClock(s.arrive)} 도착` : `${fmtClock(s.depart)} 출발`, i < n - 1 && s.arrive != null ? `${fmtClock(s.depart)} 출발` : '', i > 0 && l?.dur != null ? `${MODES[it.mode].icon} ${fmtDur(l.dur)}` : ''].filter(Boolean).join(' · ');
    return `<button class="c-card ${S.focus === i ? 'on' : ''} ${st === 'done' ? 'done' : ''}" data-act="cardToList" data-i="${i}">
      <span class="dot ${i === 0 ? 'sq' : ''}" style="--c:${placeColor(i, st)}">${st === 'done' ? '✓' : labelOf(d, i)}</span>
      <span class="c-text"><div class="c-name">${esc(it.place)}</div><div class="c-sub">${sub}</div></span>
      <span class="c-go">목록 ›</span></button>`;
  }).join('');
}

// 카드를 옆으로 넘기면 가운데 카드의 장소를 지도에서 보여줌
let carouselTimer;
$('#carousel').addEventListener('scroll', () => {
  clearTimeout(carouselTimer);
  carouselTimer = setTimeout(() => {
    const el = $('#carousel'), mid = el.scrollLeft + el.clientWidth / 2;
    let best = null, bestDist = Infinity;
    el.querySelectorAll('.c-card').forEach(c => {
      const dd = Math.abs(c.offsetLeft + c.offsetWidth / 2 - mid);
      if (dd < bestDist) { bestDist = dd; best = +c.dataset.i; }
    });
    if (best != null && best !== S.focus) focusMapItem(best, false);
  }, 140);
}, { passive: true });

// 지도 위쪽 한 줄 실시간 안내
function renderMapStatus() {
  const el = $('#mapStatus'), d = curDay();
  const ph = d?.items.length && isLive() ? phase(d) : null;
  let html = '';
  if (ph?.type === 'move') {
    const it = d.items[ph.i];
    if (S.pos && hasPos(it)) {
      const { dist, est, eta } = liveEta(it);
      html = `<div class="muted small">이동 중 · 파란 선을 따라가세요</div><b>${esc(it.place)}</b> · ${fmtDist(dist)} · 약 ${fmtDur(est)} · ${clockOf(eta)} 도착`;
    } else html = `<div class="muted small">다음 목적지</div><b>${esc(it.place)}</b>`;
  } else if (ph?.type === 'stay' || ph?.type === 'before') {
    const i = ph.i, next = d.items[i + 1];
    if (next) {
      const dep = atMs(d.date, S.cur.sched[i].depart);
      html = `<div class="muted small">${esc(d.items[i].place)}</div><b>출발까지 <span data-cd="${dep}">${fmtCountdown(dep - Date.now())}</span></b> · 다음 ${esc(next.place)}`;
    }
  }
  el.innerHTML = html;
  el.hidden = !html;
}

// ---------- 화면 쌓기 (시간표 → 상세 → 지도). 아이폰처럼 밀려 들어오고 나감 ----------
const LAYERS = ['list', 'detail', 'map'];
const topLayer = () => S.stack[S.stack.length - 1];

function applyLayers() {
  const top = topLayer();
  if (top !== 'map' && S.poi) { S.poi = null; renderMap(false); } // 지도를 닫으면 추천 장소 표시도 지움
  for (const name of LAYERS) {
    const el = $(`#${name}View`), inStack = S.stack.includes(name);
    el.classList.toggle('active', name === top);
    el.classList.toggle('under', inStack && name !== top);
    el.setAttribute('aria-hidden', String(name !== top));
  }
  S.view = top === 'map' ? 'map' : 'list';
  document.body.classList.toggle('show-map', top === 'map');
  $('#btnBack').hidden = S.stack.length < 2;
  $('#iconMap').toggleAttribute('hidden', top === 'map');
  $('#iconList').toggleAttribute('hidden', top !== 'map');
  $('#btnView').setAttribute('aria-label', top === 'map' ? '시간표 보기' : '하루 전체 지도');
  if (top === 'map') {
    requestAnimationFrame(() => {
      S.map?.resize();
      renderMap(false);
      renderCarousel();
      renderMapStatus();
      if (S.focus != null) panToFocus(true); else fitDay();
    });
  }
}

function pushLayer(name, enter = 'right') {
  const el = $(`#${name}View`);
  if (!S.stack.includes(name)) {
    el.dataset.enter = enter;
    el.classList.remove('active', 'under');
    void el.offsetWidth; // 시작 위치를 먼저 잡아야 미끄러지듯 들어옴
  }
  S.stack = S.stack.filter(x => x !== name);
  S.stack.push(name);
  applyLayers();
}

function popLayer() {
  if (S.stack.length > 1) { S.stack.pop(); applyLayers(); }
}

function openMap(focus, enter = 'right') {
  S.focus = focus ?? null;
  pushLayer('map', enter);
}
function closeMap() {
  if (topLayer() === 'map') popLayer();
}

function openDetail(i, swap) {
  S.detail = i;
  renderDetail();
  if (swap) { // 상세에서 이전/다음 장소로: 페이지만 바꿔치기
    $('#detailView .dt-scroll')?.animate([{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'cubic-bezier(.32,.72,0,1)' });
    return;
  }
  pushLayer('detail');
  $('#detailView .dt-scroll')?.scrollTo(0, 0);
}

// 지도 카드 → 시간표의 그 일정으로 돌아가 잠깐 강조
function backToList(i) {
  S.stack = ['list'];
  applyLayers();
  const row = document.querySelector(`.row[data-i="${i}"]`);
  if (row) {
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash');
  }
}

// 앱 안에서 돌아갈 화면이 남아 있는지
const canGoBack = () => !$('#alarm').hidden || !!S.viewer || S.pick || !!S.sheet || S.stack.length > 1 || S.dayBack.length > 0;

// 휴대폰 뒤로 가기: 바로 전 화면으로. 첫 화면이면 종료할지 물어봄 (앱에서만)
function goBack() {
  if (!$('#alarm').hidden) { dismissAlarm(); return; }
  if (S.viewer) { closeViewer(); return; }
  if (S.pick) { finishPick(); return; }
  if (S.sheet) { closeSheet(); return; }
  if (S.stack.length > 1) { popLayer(); return; }
  if (S.dayBack.length) { selectDay(S.dayBack.pop(), true, true); return; }
  if (!isNative) return;
  S.sheet = { type: 'exit' };
  renderSheet();
}

// 웹앱(브라우저)에서는 뒤로 가기가 페이지를 벗어나지 않게 기록을 하나 깔아 두고,
// 돌아갈 화면이 없을 때만 실제로 페이지를 떠남
function setupWebBack() {
  if (isNative) return;
  history.replaceState({ tf: 'root' }, '');
  history.pushState({ tf: 'guard' }, '');
  window.addEventListener('popstate', () => {
    if (canGoBack()) { goBack(); history.pushState({ tf: 'guard' }, ''); }
    else history.back();
  });
}

function exitHtml() {
  return `<div class="exit-box"><div class="exit-icon">🧳</div><b>트립플립을 종료할까요?</b>
    <div class="muted small">예약한 출발 알람과 모닝콜은 앱을 닫아도 울려요.</div>
    <div class="st-actions"><button class="primary" data-act="exitApp">종료</button><button data-act="closeSheet">취소</button></div></div>`;
}

function fitDay() {
  const d = curDay();
  S.map?.fit((d?.items || []).filter(hasPos));
}

function panToFocus(scrollCard) {
  const d = curDay(), i = S.focus, it = d?.items[i];
  if (!it) return;
  const prev = d.items[i - 1];
  if (S.poi && S.poi.from === i && hasPos(it)) S.map.fit([it, S.poi]); // 주변 추천 장소와 함께
  else if (hasPos(prev) && hasPos(it)) S.map.fit([prev, it]);
  else if (hasPos(it)) S.map.panTo(it, 16);
  // 카드 줄만 옆으로 움직임 (scrollIntoView는 지도 화면이 아직 들어오는 중일 때 화면 전체를 옆으로 밀어 버림)
  const card = scrollCard && document.querySelector(`.c-card[data-i="${i}"]`), strip = $('#carousel');
  if (card && strip) strip.scrollTo({ left: card.offsetLeft - (strip.clientWidth - card.offsetWidth) / 2, behavior: 'smooth' });
}

function focusMapItem(i, scrollCard = true) {
  S.focus = i;
  S.follow = false;
  renderMap(false);
  document.querySelectorAll('.c-card').forEach(c => c.classList.toggle('on', +c.dataset.i === i));
  panToFocus(scrollCard);
}

let toastTimer;
function toast(msg, ms = 3000) {
  const el = $('#toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

// ---------- 도착/출발 기록 ----------
function changed() {
  saveProgress();
  recompute();
  renderAll(false);
  scheduleAlarms();
  updateLiveRoute(true);
  maybeAdvanceDay();
}

function markArrive(d, i, ts = Date.now()) {
  const prog = progOf(d.date);
  d.items.forEach((it, j) => {
    if (j >= i) return;
    const p = prog[it.id];
    if (p?.arr && !p.dep) p.dep = ts;          // 앞 장소는 출발한 것으로
    else if (!p) prog[it.id] = { skip: true }; // 들르지 않은 장소는 건너뜀
  });
  prog[d.items[i].id] = { arr: ts };
  changed();
}

function markDepart(d, i, ts = Date.now()) {
  const prog = progOf(d.date), id = d.items[i].id;
  prog[id] = { ...prog[id], dep: ts };
  delete prog[id].skip;
  changed();
}

// GPS 위치로 도착·출발 자동 감지
function detect() {
  const d = curDay();
  if (!d || !S.pos || !isLive() || S.pos.acc > 300) return;
  const r = S.settings.radius, prog = progOf(d.date), n = d.items.length;
  let last = -1;
  d.items.forEach((it, i) => { const p = prog[it.id]; if (p && (p.arr || p.dep || p.skip)) last = i; });
  const here = d.items.findIndex(it => prog[it.id]?.arr && !prog[it.id]?.dep);
  for (let i = last + 1; i < n; i++) {
    const it = d.items[i];
    if (hasPos(it) && haversine(S.pos, it) <= r) {
      markArrive(d, i);
      toast(`📍 ${it.place} 도착 (${clockOf(Date.now())})`);
      return;
    }
  }
  if (here >= 0 && here < n - 1) {
    const it = d.items[here];
    if (hasPos(it) && haversine(S.pos, it) > Math.max(r * 1.5, r + 50)) {
      markDepart(d, here);
      toast(`🚶 ${it.place} 출발 (${clockOf(Date.now())})`);
    }
  }
}

// 이동 중이면 내 위치에서 다음 장소까지 실제 길을 받아 파란 선으로. 길에서 벗어나거나 1분 지나면 다시 받음
let liveFetching = false;
async function updateLiveRoute(force) {
  const d = curDay(), ph = d && isLive() ? phase(d) : null;
  const target = ph?.type === 'move' ? d.items[ph.i] : null;
  if (!target || !hasPos(target) || !S.pos) {
    if (S.live) { S.live = null; drawLines(); }
    return;
  }
  if (S.live?.id !== target.id) S.live = { id: target.id, to: target, path: null, at: 0, from: null };
  const L = S.live, key = gkey(), now = Date.now();
  const offRoute = L.path?.length && Math.min(...L.path.map(p => haversine(S.pos, p))) > 80;
  const stale = !L.path || (now - L.at > 60000 && haversine(S.pos, L.from) > 60);
  const canRoute = key || target.mode !== 'TRANSIT'; // 도보·차는 키 없이도 무료 경로로
  if (canRoute && !liveFetching && (force || offRoute || stale) && now - L.at > 15000) {
    liveFetching = true;
    L.at = now; L.from = { ...S.pos };
    try {
      const [r] = await routeFor(key, S.pos, target, target.mode, null);
      if (r && S.live === L) { L.path = decodePolyline(r.poly); L.dur = r.dur; L.dist = r.dist; }
    } catch { /* 실패하면 직선으로 표시 */ }
    liveFetching = false;
  }
  drawLines();
}

function onPos(p) {
  S.pos = p;
  // 다음에 켤 때 바로 쓰도록 마지막 위치 기억 (1분에 한 번만 저장)
  if (!p.saved && Date.now() - (onPos.savedAt || 0) > 60000) { onPos.savedAt = Date.now(); store.set('tg.pos', p); }
  S.map?.setMe(p);
  if (S.follow) S.map?.panTo(p);
  if (isLive()) detect();
  updateDistances();
  updateLiveRoute(false);
  if (topLayer() === 'map') renderMapStatus();
}

// 오늘 일정을 다 마치면 다음 날 시간표로 넘어가기
// (마지막 장소에 도착했고 그곳 체류 시간이 지났으면 끝난 것으로 봄. 숙소처럼 체류 0분이면 도착하자마자)
function maybeAdvanceDay() {
  const d = curDay();
  if (!d || !S.followToday || d.date !== todayStr() || !d.items.length) return;
  const ph = phase(d), last = d.items.length - 1;
  const finished = ph.type === 'done'
    || (ph.type === 'stay' && ph.i === last && Date.now() >= atMs(d.date, S.cur.sched[last].depart));
  if (!finished) return;
  const next = S.plan.days.find(x => x.date > d.date && x.items.length);
  if (!next) return;
  toast(`오늘 일정 끝! ${dayLabel(next.date)} 시간표를 보여드려요`, 5000);
  selectDay(next.date, false);
}

// ---------- 경로 추천 ----------
async function openRouteSheet(i) {
  const d = curDay(), to = d.items[i];
  const ph = isLive() ? phase(d) : null;
  const fromMe = !!(S.pos && ph?.type === 'move' && ph.i === i);
  const from = fromMe ? S.pos : d.items[i - 1];
  if (!hasPos(from) || !hasPos(to)) { toast('위치 정보가 없어 경로를 계산할 수 없어요'); return; }
  if (topLayer() !== 'map') openMap(i, topLayer() === 'detail' ? 'bottom' : 'right'); else focusMapItem(i);
  S.sheet = { type: 'route', i, from, fromMe, fromName: fromMe ? '내 위치' : from.place, results: null, sel: null };
  renderSheet();

  const dist = haversine(from, to);
  const modes = ['TRANSIT', 'WALK', 'DRIVE'];
  if (to.mode === 'BICYCLE') modes.push('BICYCLE');
  const departAt = fromMe ? Date.now() : atMs(d.date, S.cur.sched[i - 1].depart);
  const key = gkey();
  const results = (await Promise.all(modes.map(async mode => {
    if (mode === 'WALK' && dist > 6000 && to.mode !== 'WALK') return null;
    if (!key && mode === 'TRANSIT') return { mode, dur: estimateMin(dist, mode), dist, est: true };
    try {
      // 구글 경로가 없으면(한국 도보·차, 키 없음) 무료 OpenStreetMap 경로로
      const routes = await routeFor(key, from, to, mode, departAt);
      return routes.length ? { mode, routes, dur: routes[0].dur, dist: routes[0].dist, free: !!routes[0].free } : { mode, none: true };
    } catch (e) {
      return { mode, error: e.message, dur: estimateMin(dist, mode), dist, est: true };
    }
  }))).filter(Boolean);
  if (S.sheet?.i !== i) return;

  const ok = results.filter(r => r.dur != null);
  let rec = null;
  const walk = ok.find(r => r.mode === 'WALK');
  if (walk && walk.dur <= 15) rec = 'WALK';
  else if (ok.length) {
    const min = Math.min(...ok.map(r => r.dur));
    const planned = ok.find(r => r.mode === to.mode);
    rec = planned && planned.dur <= min + 5 ? to.mode : ok.find(r => r.dur === min).mode;
  }
  if (!fromMe) {
    for (const r of results) {
      if (r.routes) S.legCache[legKey(from, to, r.mode)] = pickLeg(r.routes[0]);
      else if (r.none) S.legCache[legKey(from, to, r.mode)] = { fail: true };
    }
    saveLegs();
    recompute();
    renderAll(false);
  }
  Object.assign(S.sheet, { results, rec });
  selectRoute(rec || results[0]?.mode, 0);
}

const pickLeg = r => ({ dur: r.dur, dist: r.dist, poly: r.poly, segs: r.segs });

function selectRoute(mode, idx) {
  const sh = S.sheet;
  if (!sh || !mode) { renderSheet(); return; }
  sh.sel = { mode, idx };
  const r = sh.results.find(x => x.mode === mode);
  const route = r?.routes?.[idx];
  const to = curDay().items[sh.i];
  S.routeView = { path: route?.poly ? decodeMemo(route.poly) : [sh.from, to], color: MODES[mode].color };
  renderSheet();
  drawLines();
  S.map?.fit(S.routeView.path);
}

function segHtml(s) {
  if (s.type === 'TRANSIT') {
    const dep = s.depTime ? ` · ${clockOf(Date.parse(s.depTime))} 출발` : '';
    return `<li><span class="seg-icon">${s.icon}</span><div><b>${esc(s.line)}</b>${s.headsign ? ` ${esc(s.headsign)} 방면` : ''}<br>
      <span class="muted">${esc(s.from)} → ${esc(s.to)} · ${s.stops}정거장 · ${fmtDur(s.dur)}${dep}</span></div></li>`;
  }
  const head = s.type === 'WALK' ? `🚶 걷기 ${fmtDur(s.dur)} (${fmtDist(s.dist)})` : `➡️ 이동 ${fmtDur(s.dur)} (${fmtDist(s.dist)})`;
  const steps = s.steps.slice(0, 12).map(t => `<div class="muted small">· ${esc(t)}</div>`).join('');
  return `<li><div>${head}${steps}</div></li>`;
}

function routeSheetHtml(sh) {
  const d = curDay(), to = d.items[sh.i];
  let body;
  if (!sh.results) body = '<div class="muted pad">경로 계산 중…</div>';
  else {
    const cards = sh.results.map(r => {
      const m = MODES[r.mode];
      return `<button class="mode-card ${sh.sel?.mode === r.mode ? 'on' : ''}" data-act="pickMode" data-mode="${r.mode}" ${r.none ? 'disabled' : ''}>
        <span class="mi">${m.icon}</span><span class="ml">${m.label}</span>
        <b>${r.none ? '경로 없음' : fmtDur(r.dur)}</b><span class="muted small">${r.dist ? fmtDist(r.dist) : ''}</span>
        <span>${sh.rec === r.mode ? '<span class="badge ok">추천</span>' : ''}${to.mode === r.mode ? '<span class="badge">계획</span>' : ''}${r.est ? '<span class="est">추정</span>' : ''}${r.free ? '<span class="est">무료지도</span>' : ''}</span>
      </button>`;
    }).join('');
    const r = sh.results.find(x => x.mode === sh.sel?.mode);
    let detail = '';
    if (r?.routes) {
      const alts = r.routes.length > 1
        ? `<div class="alts">${r.routes.map((x, k) => `<button class="${sh.sel.idx === k ? 'on' : ''}" data-act="pickAlt" data-k="${k}">경로 ${k + 1} · ${fmtDur(x.dur)}</button>`).join('')}</div>` : '';
      detail = `${alts}<ul class="segs">${r.routes[sh.sel.idx].segs.map(segHtml).join('')}</ul>`;
      if (r.free) detail += `<div class="muted small pad">${inKorea(to) ? '구글은 한국에서 도보·차 길찾기를 제공하지 않아' : '무료 지도'} OpenStreetMap 경로로 보여드려요. 지도에 그려진 선을 따라가면 돼요.</div>`;
    } else if (r?.error) {
      detail = `<div class="warn">경로를 받지 못했어요: ${esc(r.error)}</div>`;
    }
    if (!gkey() && r?.mode === 'TRANSIT') detail += '<div class="muted small pad">대중교통 노선은 설정에 구글맵 API 키를 넣어야 보여요. 지금은 직선거리로 추정한 시간이에요.</div>';
    const navApp = inKorea(to) ? '카카오맵' : '구글맵';
    body = `<div class="mode-cards">${cards}</div>${detail}
      <div class="st-actions">
        ${sh.sel ? `<button class="primary" data-act="navMode">${navApp} 길안내 시작</button>` : ''}
        ${sh.sel && sh.sel.mode !== to.mode ? `<button data-act="useMode">일정을 ${MODES[sh.sel.mode].label}(으)로 변경</button>` : ''}
      </div>`;
  }
  return `<div class="sheet-head"><div><div class="st-label">경로 추천</div><b>${esc(sh.fromName)} → ${esc(to.place)}</b></div>
    <button class="x" data-act="closeSheet">✕</button></div>${body}`;
}

function renderSheet() {
  const el = $('#sheet'), sh = S.sheet;
  el.classList.toggle('mini', !!S.pick);
  if (!sh) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  if (S.pick) {
    el.innerHTML = `<div class="pick-bar"><b>지도를 눌러 ${S.pickTarget === 'origin' ? '출발지를' : '위치를'} 고르세요</b><button data-act="pickCancel">취소</button></div>`;
    return;
  }
  el.innerHTML = { settings: settingsHtml, route: routeSheetHtml, edit: editHtml, cal: calendarHtml, exit: exitHtml, wake: wakeHtml, poi: poiHtml, suggest: suggestHtml, guide: guideHtml, near: nearHtml, invite: inviteHtml }[sh.type](sh);
}

// ---------- 일정을 넣거나 바꿀 때 미리 계산해서 예약 지각·밀림 알려주기 ----------
// newItems로 바뀌면 원래 있던 일정들이 얼마나 밀리는지, 예약(시간 고정) 일정에 늦게 되는지
function previewChange(d, newItems) {
  const before = dayPlan(d).sched, after = dayPlan({ ...d, items: newItems }).sched;
  const old = new Map(d.items.map((it, i) => [it.id, before[i]]));
  const late = [], shifted = [], shortened = [], tight = [];
  newItems.forEach((it, j) => {
    const b = old.get(it.id), a = after[j];
    if (!b) { if (a.short >= 10) tight.push({ it, mins: Math.round(a.stayEff ?? 0) }); return; } // 새 일정이 들어갈 틈이 모자람
    if (a.late > (b.late || 0)) late.push({ it, mins: a.late });
    const cut = (b.stayEff ?? 0) - (a.stayEff ?? 0);
    if (j < newItems.length - 1 && cut >= 10) shortened.push({ it, mins: Math.round(cut) });
    const moved = (a.arrive ?? a.depart) - (b.arrive ?? b.depart);
    if (moved >= 5) shifted.push({ it, mins: Math.round(moved) });
  });
  return { late, shifted, shortened, tight };
}

// k번 뒤에 시간 없는 일정을 끼우면, 원래는 k번이 남는 시간을 다 빼앗겨 0분 머묾이 됨.
// → k번이 원래 머물던 시간을 지키고, 뒤 예약까지 모자라는 만큼만 k번에서 줄임
function keepStay(d, items, k) {
  const it = items[k], s = dayPlan(d).sched[d.items.findIndex(x => x.id === it?.id)];
  if (!it || k === 0 || it.stay || !(s?.stayEff > 0)) return items;
  const out = [...items];
  out[k] = { ...it, stay: Math.round(s.stayEff) };
  const after = dayPlan({ ...d, items: out }).sched;
  const j = out.findIndex((x, n) => n > k + 1 && x.time != null);
  const over = (after[k + 1]?.short || 0) + (j > 0 ? after[j].late : 0); // 새 일정이 못 머무는 만큼 + 예약에 늦는 만큼
  if (over > 0) out[k] = { ...it, stay: Math.max(0, out[k].stay - over) };
  if (!out[k].stay) out[k] = it;
  return out;
}

// 예약에 늦게 되면 먼저 물어봄. 넣기로 하면 결과를 돌려줌, 취소하면 null
function confirmChange(d, newItems) {
  const imp = previewChange(d, newItems);
  if (imp.late.length) {
    const lines = imp.late.map(x => `· ${x.it.place} (${fmtClock(x.it.time)})에 ${fmtDur(x.mins)} 늦어요`).join('\n');
    if (!confirm(`이렇게 하면 시간을 정해 둔 일정(예약 등)에 늦어요.\n\n${lines}\n\n그래도 진행할까요?`)) return null;
  } else if (imp.tight.length) {
    const x = imp.tight[0];
    if (!confirm(`뒤에 시간을 정해 둔 일정(예약 등)이 있어서 ${x.it.place}에는 ${x.mins > 0 ? `${fmtDur(x.mins)}밖에` : '거의'} 못 머물러요.\n\n그래도 넣을까요?`)) return null;
  }
  return imp;
}

function changeToast(imp, base) {
  const bits = [base];
  if (imp?.late.length) bits.push(`⚠ 정해 둔 시간에 ${imp.late.length}곳 늦어요 (목록에 표시)`);
  else if (imp?.shortened.length) bits.push(`정해 둔 시간을 지키려고 ${imp.shortened.map(x => `${x.it.place} ${fmtDur(x.mins)}`).join(', ')} 덜 머물러요`);
  else if (imp?.shifted.length) bits.push(`뒤 일정 ${imp.shifted.length}곳이 최대 ${fmtDur(Math.max(...imp.shifted.map(x => x.mins)))} 밀렸어요`);
  const big = imp && (imp.late.length || imp.shifted.length || imp.shortened.length);
  toast(bits.filter(Boolean).join(' · '), big ? 6000 : 3000);
}

// ---------- 일정 양식 · AI로 일정 만들기 안내 ----------
const WEB_URL = 'https://taewoong5668.github.io/tripflip/';
const AI_PROMPT = `아래 여행 계획을 엑셀(.xlsx) 파일 하나로 만들어줘. "일정" 시트 하나에 표 하나만.

열(머리글)은 정확히 이 이름으로:
날짜 | 시간 | 장소 | 영문 이름 | 주소 | 체류(분) | 이동수단 | 설명 | 주변 추천 | 메모

가장 중요한 규칙 (앱이 이 칸으로 지도 위치를 찾아요):
- 내가 한글·영어·현지어 중 무엇으로 적었든, 어느 장소인지 정확히 알아내서 실제로 있는 장소로 확정해 줘
- 같은 이름의 가게·지점이 여러 곳이면 그날 동선(숙소·앞뒤 장소)에 맞는 지점을 골라 줘
- 영문 이름: 구글맵에 등록된 공식 영어 이름 (예: Hurricanes Grill & Bar Bondi Beach)
- 주소: 그 장소의 실제 주소를 영어로, "번지 도로명, 동네, 도시 우편번호, 국가" 순서로 쉼표로 나눠서. 장소 이름은 넣지 말기
  (예: 130 Roscoe St, Bondi Beach, Sydney NSW 2026, Australia)
- 웹 검색을 할 수 있으면 검색해서 주소를 확인해 줘. 확실하지 않은 주소는 지어내지 말고 아는 만큼만(동네, 도시, 국가) 적고, 메모에 "주소 확인 필요"라고 적어 줘

나머지 규칙:
- 장소: 내가 부르는 이름 그대로 (한글 가능)
- 한 줄 = 장소 하나, 방문 순서대로
- 날짜: 2026-11-03 형식, 그날 첫 줄에만 적기
- 시간: 그날 첫 줄(숙소)은 출발 시간, 나머지는 예약처럼 꼭 맞춰야 하는 도착 시간만 HH:MM으로 (나머지는 비우기)
- 체류(분): 머무는 시간 숫자
- 이동수단: 그 장소까지 가는 방법, 도보/대중교통/차량/자전거 중 하나
- 주변 추천: "a. 장소  b. 장소  c. 장소" 형식
- 매일 숙소에서 출발해서 숙소로 돌아오는 줄로 끝내기

여행 계획:
(여기에 여행지, 날짜, 숙소, 가고 싶은 곳, 예약한 것을 적어 주세요)`;

function guideHtml() {
  return `<div class="sheet-head"><div><div class="st-label">일정 넣는 방법</div><b>📄 엑셀 양식으로 한 번에 넣기</b></div><button class="x" data-act="closeSheet">✕</button></div>
    <div class="guide-step"><b>1. 양식 받기</b><div class="muted small">날짜·시간·장소 칸이 있는 엑셀 양식이에요. 예시를 지우고 내 일정을 적으면 돼요.</div>
      <button class="chip-btn on" data-act="getTemplate">📄 일정 양식 받기 (.xlsx)</button></div>
    <div class="guide-step"><b>2. AI에게 부탁하기 (더 쉬움)</b><div class="muted small">ChatGPT · Claude · Gemini에 아래 문구를 붙여넣고, 맨 아래에 내 여행 계획을 적어 보내세요. 양식에 맞는 엑셀 파일을 만들어 줘요.</div>
      <pre class="prompt">${esc(AI_PROMPT)}</pre>
      <button class="chip-btn on" data-act="copyPrompt">📋 문구 복사하기</button></div>
    <div class="guide-step"><b>3. 불러오기</b><div class="muted small">받은 엑셀 파일을 ⚙️ 설정 → "📂 엑셀/CSV 일정 불러오기"로 열면 날짜별 시간표와 지도가 만들어져요.</div>
      <button class="chip-btn" data-act="load">📂 지금 불러오기</button></div>`;
}

async function getTemplate() {
  // 앱에서는 웹 주소로 열어 휴대폰 브라우저가 내려받게, 웹앱에서는 바로 내려받기
  if (isNative) { openExternal(`${WEB_URL}tripflip-template.xlsx`); return; }
  const a = document.createElement('a');
  a.href = 'tripflip-template.xlsx'; a.download = '트립플립_일정양식.xlsx';
  document.body.appendChild(a); a.click(); a.remove();
  toast('양식을 내려받았어요');
}

async function copyPrompt() {
  try { await navigator.clipboard.writeText(AI_PROMPT); toast('복사했어요. AI 채팅창에 붙여넣으세요'); } catch {
    // 복사가 막힌 환경: 글을 선택해 두기
    const pre = document.querySelector('.prompt');
    const r = document.createRange(); r.selectNodeContents(pre);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    toast('글을 길게 눌러 복사해 주세요');
  }
}

// ---------- 식사 장소 추천 ----------
// 앞 일정(과 다음 일정의 중간) 근처에서 걸어갈 만한 식당·카페를 찾음
async function openSuggest(type, k) {
  const d = curDay(), m = MEALS.find(x => x.type === type) || extraGaps(d).find(x => x.type === type && x.k === k);
  if (!m) return;
  const prev = d.items[k], next = type === 'night' ? null : d.items[k + 1];
  let center = hasPos(prev) ? prev : next;
  const both = hasPos(prev) && hasPos(next);
  if (both && haversine(prev, next) < 3000) center = { lat: (prev.lat + next.lat) / 2, lng: (prev.lng + next.lng) / 2 };
  if (!hasPos(center)) { toast(`앞뒤 일정의 위치가 없어서 근처 ${m.what || '맛집'}${eul(m.what || '맛집')} 찾을 수 없어요`); return; }
  // 여유 시간: 앞뒤 장소가 멀면 두 곳 근처를 각각 찾음
  const centers = type === 'free' && both && haversine(prev, next) >= 3000 ? [prev, next] : [center];
  S.sheet = { type: 'suggest', slot: m, k, center, near: prev.place + (next ? ` ~ ${next.place}` : ''), results: 'loading' };
  renderSheet();
  let list = [];
  try {
    for (const c of centers) {
      let part = gkey() ? await nearbyPlaces(gkey(), c, type) : [];
      if (!part.length) part = await nearbyPlacesFree(c, type);
      if (!part.length) part = await nearbyPlacesFree(c, type, 1500); // 가까이 없으면 조금 더 넓게
      list.push(...part);
    }
  } catch (e) {
    if (!list.length) toast(`추천 장소 찾기 실패: ${e.message}`, 5000);
  }
  if (S.sheet?.type !== 'suggest' || S.sheet.k !== k) return;
  const wd = (new Date(`${d.date}T12:00`).getDay() + 6) % 7; // 구글 영업시간은 월요일부터
  const seen = new Set();
  list = list.filter(r => !seen.has(r.name) && seen.add(r.name));
  list.forEach(r => {
    r.d = Math.min(...centers.map(c => haversine(c, r)));
    if (r.week?.[wd]) r.hours = r.week[wd].replace(/^[^:]+:\s*/, '');
  });
  // 구글 결과는 평점·리뷰 많은 순, 무료 지도 결과는 종류별로 가까운 순서를 번갈아 (받은 순서 그대로)
  if (list.some(r => r.rating)) list.sort((a, b) => (b.rating || 0) * Math.log10(b.reviews + 10) - (a.rating || 0) * Math.log10(a.reviews + 10));
  S.sheet.results = list.slice(0, 8);
  renderSheet();
}

function suggestHtml(sh) {
  let body;
  const what = sh.slot.what || '맛집';
  if (sh.results === 'loading') body = `<div class="muted pad">근처 ${what}${eul(what)} 찾는 중…</div>`;
  else if (!sh.results.length) body = '<div class="muted pad">근처에서 찾지 못했어요. 지도 앱에서 직접 찾아보세요.</div>';
  else body = sh.results.map((r, j) => `<div class="place-card">
      <div class="place-top"><div class="place-name">${esc(r.name)}</div>${r.rating ? `<div class="place-rate">★ ${r.rating.toFixed(1)} <span class="muted small">(${r.reviews.toLocaleString()})</span></div>` : ''}</div>
      <div class="place-meta">${[r.kind, `🚶 ${fmtDist(r.d)} · 약 ${fmtDur(estimateMin(r.d, 'WALK'))}`, r.hours].filter(Boolean).map(esc).join(' · ')}</div>
      <div class="chips"><button class="chip-btn on" data-act="suggestAdd" data-j="${j}">＋ 일정에 넣기</button><button class="chip-btn" data-act="suggestMap" data-j="${j}">🗺️ 지도</button><button class="chip-btn" data-act="suggestNav" data-j="${j}">길안내</button></div>
    </div>`).join('');
  const web = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${sh.slot.web || (sh.slot.type === 'brunch' ? 'brunch cafe' : 'restaurant')} near ${sh.center.lat},${sh.center.lng}`)}`;
  const when = sh.slot.when || `${fmtClock(sh.slot.center)} 무렵`;
  return `<div class="sheet-head"><div><div class="st-label">${esc(sh.near)} 근처 · ${when}</div><b>${sh.slot.icon || '🍽'} ${sh.slot.icon ? `${what} 추천` : `${sh.slot.label} 추천`}</b></div><button class="x" data-act="closeSheet">✕</button></div>
    ${sh.slot.type === 'night' ? '<div class="muted small pad">영업시간이 보이면 확인하고 가세요. 밤늦게는 문 닫은 곳도 있어요.</div>' : ''}
    ${!gkey() ? '<div class="muted small pad">무료 지도 기준 가까운 순이에요. 설정에 구글 키를 넣으면 평점 높은 순으로 보여줘요.</div>' : ''}
    ${body}
    <div class="st-actions"><button data-act="poiWeb" data-url="${esc(web)}">지도 앱에서 더 찾아보기</button></div>`;
}

// 추천 식당을 그 자리(앞 일정 바로 뒤)에 넣기
function suggestAdd(r) {
  const sh = S.sheet, d = curDay();
  if (sh.slot.type === 'free' || sh.slot.type === 'night') { extraAdd(r); return; }
  // 식사 시각에 맞춰 도착하도록 (앞 장소 도착 뒤 30분은 머물게)
  const prevS = S.cur.sched[sh.k], prevArr = prevS ? (prevS.arrive ?? prevS.depart) : 0;
  const at = Math.max(sh.slot.center, prevArr + 30);
  const item = {
    id: newId(), place: r.name, address: r.address || '', lat: r.lat, lng: r.lng, time: at, stay: sh.slot.stay,
    mode: r.d < 1200 ? 'WALK' : 'TRANSIT', memo: `${sh.slot.label} (추천${r.rating ? ` · ★${r.rating.toFixed(1)}` : ''})`,
    notes: r.kind ? [{ label: '설명', text: r.kind }] : [],
  };
  const items = [...d.items]; items.splice(sh.k + 1, 0, item);
  const imp = confirmChange(d, items);
  if (!imp) return;
  d.items = items;
  savePlan(); recompute(); closeSheet(); renderAll(false); prefetchLegs(); scheduleAlarms();
  changeToast(imp, `${r.name}을(를) ${sh.slot.label} 일정으로 넣었어요`);
}

// ---------- 내 주변 편의점·약국·병원 ----------
async function nearMe(type) {
  const v = NEAR_ME[type];
  S.sheet = { type: 'near', near: type, me: null, results: 'locating' };
  renderSheet();
  // 방금 받은 위치가 없으면 지금 한 번 더 요청 (대략 위치 → 안 되면 GPS) → 그래도 없으면 지난번 위치
  let pos = S.pos && !S.pos.stale && Date.now() - S.pos.ts < 120000 ? S.pos : null;
  if (!pos) pos = (await Geo.once()) || (await Geo.once(true));
  if (pos && !S.settings.sim) onPos(pos);
  pos ||= S.pos;
  if (S.sheet?.type !== 'near' || S.sheet.near !== type) return;
  if (!pos) { S.sheet.results = 'nopos'; renderSheet(); return; }
  const me = { lat: pos.lat, lng: pos.lng };
  Object.assign(S.sheet, { me, stale: !!pos.stale, results: 'loading' });
  renderSheet();
  let list = [];
  try {
    for (const radius of [1500, 5000]) { // 가까이 없으면 더 넓게
      if (gkey()) list = await nearbyPlaces(gkey(), me, type, radius, 'DISTANCE').catch(() => []);
      if (!list.length) list = await nearbyPlacesFree(me, type, radius);
      if (list.length) break;
    }
  } catch (e) {
    toast(`${v.label} 찾기 실패: ${e.message}`, 5000);
  }
  if (S.sheet?.type !== 'near' || S.sheet.near !== type) return;
  const wd = (new Date().getDay() + 6) % 7;
  list.forEach(r => {
    r.d = haversine(me, r);
    if (r.week?.[wd]) r.hours = r.week[wd].replace(/^[^:]+:\s*/, '');
  });
  list.sort((a, b) => a.d - b.d); // 내 위치에서 가까운 순
  S.sheet.results = list.slice(0, 12);
  renderSheet();
}

function nearHtml(sh) {
  const v = NEAR_ME[sh.near];
  let body;
  if (sh.results === 'locating') body = '<div class="muted pad">📍 내 위치를 확인하는 중… (최대 20초)</div>';
  else if (sh.results === 'nopos') body = `<div class="muted pad">내 위치를 알 수 없어요.<br>
    · 휴대폰 설정에서 <b>위치(GPS)</b>가 켜져 있는지<br>
    · 브라우저 주소창 왼쪽 자물쇠(또는 ⓘ) → <b>위치 허용</b>인지 확인해 주세요.<br>
    · 아이폰은 설정 → 개인정보 보호 → 위치 서비스 → Safari 웹사이트 → "사용하는 동안"</div>`;
  else if (sh.results === 'loading') body = `<div class="muted pad">내 주변 ${v.label}${eul(v.label)} 찾는 중…</div>`;
  else if (!sh.results.length) body = `<div class="muted pad">가까운 ${v.label}${eul(v.label)} 찾지 못했어요. 지도 앱에서 찾아보세요.</div>`;
  else body = sh.results.map((r, j) => `<div class="place-card">
      <div class="place-top"><div class="place-name">${esc(r.name)}</div><div class="place-rate">${fmtDist(r.d)}</div></div>
      <div class="place-meta">${[r.kind, `🚶 약 ${fmtDur(estimateMin(r.d, 'WALK'))}`, r.hours].filter(Boolean).map(esc).join(' · ')}</div>
      <div class="chips"><button class="chip-btn on" data-act="nearNav" data-j="${j}">길안내</button></div>
    </div>`).join('');
  const q = { conv: 'convenience store', pharmacy: 'pharmacy', hospital: 'hospital' }[sh.near];
  const web = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(sh.me ? `${q} near ${sh.me.lat},${sh.me.lng}` : q)}`;
  return `<div class="sheet-head"><div><div class="st-label">${sh.stale ? '마지막으로 확인한 내 위치 기준' : '지금 내 위치 기준'} · 가까운 순</div><b>${v.icon} 내 주변 ${v.label}</b></div><button class="x" data-act="closeSheet">✕</button></div>
    ${sh.near === 'hospital' ? '<div class="muted small pad">응급 상황이면 바로 현지 응급번호로 전화하세요.</div>' : ''}
    ${body}
    <div class="st-actions"><button data-act="poiWeb" data-url="${esc(web)}">지도 앱에서 더 찾아보기</button></div>`;
}

// 여유 시간·밤 추천 장소 넣기
function extraAdd(r) {
  const sh = S.sheet, d = curDay(), k = sh.k, prev = d.items[k], ps = S.cur.sched[k];
  const base = {
    id: newId(), place: r.name, address: r.address || '', lat: r.lat, lng: r.lng, stay: sh.slot.stay,
    mode: r.d < 1200 ? 'WALK' : 'TRANSIT', memo: `${sh.slot.label} (추천${r.rating ? ` · ★${r.rating.toFixed(1)}` : ''})`,
    notes: [r.kind && { label: '설명', text: r.kind }, r.hours && { label: '영업시간', text: r.hours }].filter(Boolean),
  };
  const items = [...d.items];
  if (sh.slot.type === 'night') {
    // 숙소에서 쉬다가 나갔다가 다시 숙소로
    const arr = ps.arrive ?? ps.depart;
    const out = Math.ceil(Math.max(NIGHT_BEFORE, arr + 60) / 10) * 10;
    items.splice(k + 1, 0, { ...base, time: out, mode: base.mode },
      { ...prev, id: newId(), time: null, stay: 0, mode: base.mode, memo: '숙소 복귀', notes: [], files: [] });
  } else {
    // 앞 장소는 최소 45분 머문 뒤, 남는 여유 시간을 추천 장소에서
    if (!prev.stay) items[k] = { ...prev, stay: Math.min(45, Math.round(ps.stayEff / 3)) };
    items.splice(k + 1, 0, { ...base, time: null });
  }
  const imp = confirmChange(d, items);
  if (!imp) return;
  d.items = items;
  savePlan(); recompute(); closeSheet(); renderAll(false); prefetchLegs(); scheduleAlarms();
  changeToast({ ...imp, shortened: [] }, `${r.name}을(를) 일정에 넣었어요`);
}

// ---------- 주변 추천 장소 ----------
// 추천 이름(예: "world square")을 그 일정 장소 근처에서 찾아 위치·거리·바로가기를 보여줌
async function openPoi(i, name) {
  const d = curDay(), it = d.items[i];
  S.sheet = { type: 'poi', i, name, results: 'loading' };
  renderSheet();
  const near = hasPos(it) ? it : null;
  let list = [];
  try {
    if (gkey()) list = await searchPlaces(gkey(), `${name} ${it.address || it.place}`, near);
    if (!list.length) list = await searchPlacesFree(name, near);
  } catch { /* 아래에서 결과 없음으로 안내 */ }
  if (S.sheet?.type !== 'poi' || S.sheet.name !== name) return;
  // 그 장소에서 가까운 순, 5km 넘는 건 제외
  if (near) list = list.map(r => ({ ...r, d: haversine(near, r) })).filter(r => r.d < 5000).sort((a, b) => a.d - b.d);
  S.sheet.results = list.slice(0, 3);
  renderSheet();
}

function poiHtml(sh) {
  const it = curDay().items[sh.i];
  const web = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${sh.name} ${it.address || it.place}`)}`;
  let body;
  if (sh.results === 'loading') body = '<div class="muted pad">근처에서 찾는 중…</div>';
  else if (!sh.results.length) body = `<div class="muted pad">근처에서 정확한 위치를 찾지 못했어요. 지도 앱에서 직접 찾아보세요.</div>`;
  else body = sh.results.map((r, k) => {
    const walk = r.d != null ? `${esc(it.place)}에서 ${fmtDist(r.d)} · 🚶 약 ${fmtDur(estimateMin(r.d, 'WALK'))}` : '';
    const me = S.pos ? ` · 내 위치에서 ${fmtDist(haversine(S.pos, r))}` : '';
    return `<div class="poi-card">
      <div class="poi-name">${esc(r.name)}</div>
      ${r.address ? `<div class="muted small">${esc(r.address)}</div>` : ''}
      <div class="small poi-dist">${walk}${me}</div>
      <div class="chips"><button class="chip-btn on" data-act="poiMap" data-k="${k}">🗺️ 지도에서 보기</button><button class="chip-btn" data-act="poiNav" data-k="${k}">길안내</button><button class="chip-btn" data-act="poiAdd" data-k="${k}">＋ 일정에 넣기</button></div>
    </div>`;
  }).join('');
  return `<div class="sheet-head"><div><div class="st-label">주변 추천 · ${esc(it.place)} 근처</div><b>${esc(sh.name)}</b></div><button class="x" data-act="closeSheet">✕</button></div>
    ${body}
    <div class="st-actions"><button data-act="poiWeb" data-url="${esc(web)}">${inKorea(it) ? '지도 앱에서 찾아보기' : '구글맵에서 찾아보기'}</button></div>`;
}

// 추천 장소를 그 일정 바로 뒤에 넣기 (걸어서, 30분 머묾)
function poiAdd(r, i) {
  const d = curDay();
  let items = [...d.items];
  items.splice(i + 1, 0, { id: newId(), place: r.name, address: r.address || '', lat: r.lat, lng: r.lng, time: null, stay: 30, mode: 'WALK', memo: `${d.items[i].place} 주변 추천`, notes: [] });
  items = keepStay(d, items, i);
  const imp = confirmChange(d, items);
  if (!imp) return;
  d.items = items;
  savePlan(); recompute(); closeSheet(); renderAll(false); prefetchLegs(); scheduleAlarms();
  changeToast(imp, `${r.name}을(를) ${d.items[i].place} 다음 일정으로 넣었어요`);
}

function closeSheet() {
  // 저장하지 않고 닫은 수정 창에서 새로 첨부한 파일은 지움
  if (S.sheet?.type === 'edit' && !S.sheet.saved) (S.sheet.added || []).forEach(id => deleteFile(id).catch(() => {}));
  S.sheet = null; S.routeView = null; S.pick = false; S.tp = null;
  renderSheet(); renderMap(false);
}

// ---------- 달력 ----------
function calendarHtml() {
  const t = todayStr();
  const base = S.selected || t;
  S.calMonth ||= { y: +base.slice(0, 4), m: +base.slice(5, 7) };
  const { y, m } = S.calMonth;
  const first = new Date(y, m - 1, 1), daysIn = new Date(y, m, 0).getDate();
  const counts = Object.fromEntries(S.plan.days.map(d => [d.date, d.items.length]));
  const cells = [];
  for (let k = 0; k < first.getDay(); k++) cells.push('<div></div>');
  for (let day = 1; day <= daysIn; day++) {
    const date = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const cls = [date === t ? 'today' : '', date === S.selected ? 'sel' : '', counts[date] ? 'has' : ''].join(' ');
    cells.push(`<button class="cal-day ${cls}" data-act="pickDate" data-date="${date}"><span>${day}</span>${counts[date] ? `<small>${counts[date]}곳</small>` : ''}</button>`);
  }
  const trip = S.plan.days.filter(d => d.items.length);
  return `<div class="sheet-head"><b>달력</b><button class="x" data-act="closeSheet">✕</button></div>
    <div class="cal-nav"><button data-act="calPrev">‹</button><b>${y}년 ${m}월</b><button data-act="calNext">›</button></div>
    <div class="cal-grid">${'일월화수목금토'.split('').map(w => `<div class="cal-w">${w}</div>`).join('')}${cells.join('')}</div>
    <div class="muted small pad">날짜를 누르면 그날 시간표가 열려요. 일정이 있는 날은 장소 수가 표시돼요.</div>
    ${trip.length ? `<div class="cal-list">${trip.map(d => `<button data-act="pickDate" data-date="${d.date}"><b>${dayLabel(d.date)}</b> ${esc(d.title || '')} <span class="muted">${d.items.length}곳</span></button>`).join('')}</div>` : ''}`;
}

// ---------- 장소 추가/수정 ----------
const toHHMM = min => (min == null ? '' : `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`);
const fromHHMM = s => { const m = /^(\d{1,2}):(\d{2})$/.exec(s || ''); return m ? +m[1] * 60 + +m[2] : null; };

const HOTEL_RE = /호텔|숙소|리조트|게스트하우스|에어비앤비|메리턴|풀러턴|hotel|suites|resort|hostel|airbnb/i;
const blankPlace = () => ({ place: '', address: '', lat: null, lng: null });

// 그날 전에 묵은 숙소(가장 가까운 이전 날의 마지막 숙소)
function prevHotel(date) {
  const days = S.plan.days.filter(d => d.date < date && d.items.length);
  const d = days[days.length - 1];
  if (!d) return null;
  return [...d.items].reverse().find(it => HOTEL_RE.test(it.place) && hasPos(it)) || null;
}

const roundUp10 = min => Math.ceil(min / 10) * 10;
const nowMin = () => { const t = new Date(); return t.getHours() * 60 + t.getMinutes(); };

function openEditor(index, id) {
  const d = curDay(), date = S.selected;
  const it = id ? d.items.find(x => x.id === id) : null;
  const prevMode = d?.items[index - 1]?.mode;
  // 빈 날에 처음 넣는 일정: 도착지와 출발지를 한 화면에서 같이 정함
  const trip = !it && !(d?.items.length);
  const sh = {
    type: 'edit', date, index, id: it?.id || null, results: null, query: '', trip,
    draft: it ? { ...it, files: [...(it.files || [])] } : { ...blankPlace(), time: null, stay: trip ? 60 : 60, mode: prevMode || 'TRANSIT', memo: '', notes: [] },
  };
  if (trip) {
    sh.origin = null; // 비워 두면 현재 위치에서 출발
    sh.oQuery = ''; sh.oResults = null;
    sh.timeMode = date === todayStr() ? 'now' : 'dep'; // 오늘이면 기본은 "즉시 떠나기"
    sh.tval = date === todayStr() ? Math.min(roundUp10(nowMin() + 10), 23 * 60 + 50) : 9 * 60;
  }
  S.sheet = sh;
  S.routeView = null;
  S.tp = null;
  renderSheet();
  renderMap(false);
}

// 입력칸 값을 draft에 반영 (화면을 다시 그려도 입력한 값이 사라지지 않게)
function syncDraft() {
  const sh = S.sheet;
  if (sh?.type !== 'edit' || S.pick) return;
  const dr = sh.draft, v = id => $(id)?.value;
  if ($('#edQuery')) sh.query = v('#edQuery');
  if ($('#orQuery')) sh.oQuery = v('#orQuery');
  if ($('#edName')) dr.place = v('#edName').trim();
  if ($('#edTime')) dr.time = fromHHMM(v('#edTime'));
  if ($('#trTime')) sh.tval = fromHHMM(v('#trTime'));
  if ($('#edStay')) dr.stay = Math.max(0, parseInt(v('#edStay'), 10) || 0);
  if ($('#edMemo')) dr.memo = v('#edMemo');
}

const resultsHtml = (list, act) => list == null ? ''
  : list === 'loading' ? '<div class="muted pad">검색 중…</div>'
    : list.length ? `<div class="results">${list.map((r, k) => {
      // 그날 다른 장소에서 얼마나 먼지 같이 보여줘서 엉뚱한 결과를 피하기 쉽게
      const ref = curDay()?.items.find(hasPos) || S.pos;
      const far = ref ? ` · ${fmtDist(haversine(ref, r))}` : '';
      return `<button data-act="${act}" data-k="${k}"><b>${esc(r.name)}<span class="muted small">${far}</span></b><span class="muted small">${esc(r.address)}</span></button>`;
    }).join('')}</div>`
      : `<div class="muted pad">검색 결과가 없어요.${gkey() ? ' 다른 이름으로 검색해 보세요.' : '<br>무료 지도는 해외 가게의 한글 이름을 잘 몰라요. <b>영어 이름 + 도시</b>(예: Hurricanes Grill Sydney)로 검색하거나 🗺️ 지도로 보기에서 직접 골라 주세요.'}</div>`;

function placeBox(p, empty) {
  if (!hasPos(p)) return `<div class="muted">${empty}</div>`;
  const me = S.pos && p.from !== 'here' ? `<div class="small">내 위치에서 ${fmtDist(haversine(S.pos, p))}</div>` : '';
  return `<div>📍 <b>${esc(p.place || '선택한 위치')}</b></div>${p.address ? `<div class="muted small">${esc(p.address)}</div>` : ''}${me}`;
}

// ---------- 손가락으로 고르는 시간 선택기 (키보드 없이 오전/오후 → 시 → 분) ----------
const fmtAmPm = min => {
  if (min == null) return '';
  const h = Math.floor(min / 60) % 24, m = min % 60;
  return `${h < 12 ? '오전' : '오후'} ${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')}`;
};

// 시간 칸: 지금 값을 크게 보여주는 버튼 + (열려 있으면) 고르는 판. 값은 숨은 칸(id)에도 넣어 둠
function timeField(id, min, { placeholder = '시간 고르기', clearable = false } = {}) {
  const open = S.tp?.id === id;
  let panel = '';
  if (open) {
    const { ampm, h, m } = S.tp;
    panel = `<div class="tp-panel">
      <div class="seg tp-ampm"><button class="${ampm === 'am' ? 'on' : ''}" data-act="tpAmpm" data-v="am">오전</button><button class="${ampm === 'pm' ? 'on' : ''}" data-act="tpAmpm" data-v="pm">오후</button></div>
      <div class="tp-label">시</div>
      <div class="tp-grid">${[12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(x => `<button class="${h === x ? 'on' : ''}" data-act="tpH" data-v="${x}">${x}</button>`).join('')}</div>
      <div class="tp-label">분</div>
      <div class="tp-grid">${[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map(x => `<button class="${m === x ? 'on' : ''}" data-act="tpM" data-v="${x}">${String(x).padStart(2, '0')}</button>`).join('')}</div>
      <button class="tp-done" data-act="tpDone">확인</button>
    </div>`;
  }
  return `<input type="hidden" id="${id}" value="${toHHMM(min)}">
    <div class="tp-row">
      <button class="time-pick ${open ? 'open' : ''}" data-act="tpOpen" data-id="${id}">
        <span class="tp-ico">🕐</span><span class="tp-val ${min == null ? 'empty' : ''}">${min == null ? placeholder : fmtAmPm(min)}</span>
      </button>
      ${clearable && min != null ? `<button class="tp-clear" data-act="tpClear" data-id="${id}">지우기</button>` : ''}
    </div>${panel}`;
}

// 시간 칸 id → 실제로 저장되는 곳
function getTime(id) {
  const sh = S.sheet;
  return id === 'edTime' ? sh.draft.time : id === 'trTime' ? sh.tval : id === 'wkTime' ? sh.time : null;
}
function setTime(id, min) {
  const sh = S.sheet;
  if (id === 'edTime') sh.draft.time = min;
  else if (id === 'trTime') sh.tval = min;
  else if (id === 'wkTime') sh.time = min;
}

function tpAct(name, el) {
  if (S.sheet?.type === 'edit') syncDraft(); else syncWake();
  if (name === 'tpOpen') {
    const id = el.dataset.id;
    if (S.tp?.id === id) { S.tp = null; renderSheet(); return; }
    const cur = getTime(id) ?? (S.sheet.date === todayStr() ? Math.min(roundUp10(nowMin() + 10), 23 * 60 + 55) : 9 * 60);
    const h24 = Math.floor(cur / 60) % 24;
    S.tp = { id, ampm: h24 < 12 ? 'am' : 'pm', h: h24 % 12 === 0 ? 12 : h24 % 12, m: Math.round((cur % 60) / 5) * 5 % 60 };
  } else if (name === 'tpClear') {
    setTime(el.dataset.id, null); S.tp = null;
  } else if (name === 'tpDone') {
    S.tp = null;
  } else {
    if (name === 'tpAmpm') S.tp.ampm = el.dataset.v;
    if (name === 'tpH') S.tp.h = +el.dataset.v;
    if (name === 'tpM') S.tp.m = +el.dataset.v;
  }
  if (S.tp) { // 고를 때마다 바로 결과에 반영
    const { ampm, h, m } = S.tp;
    setTime(S.tp.id, ((h % 12) + (ampm === 'pm' ? 12 : 0)) * 60 + m);
  }
  renderSheet();
}

// 실제로 쓸 출발지: 고른 곳이 없으면 현재 위치
const originOf = sh => sh.origin || (S.pos ? { place: '현재 위치', address: '', lat: S.pos.lat, lng: S.pos.lng, from: 'here' } : null);

// 제목 옆에 "지도로 보기" 버튼 (누르면 지도가 열리고, 지도를 눌러 위치를 고름)
const headWithMap = (text, target) =>
  `<div class="q-head"><b>${text}</b><button class="chip-btn" data-act="edPick" data-target="${target}">🗺️ 지도로 보기</button></div>`;

function editHtml(sh) {
  const dr = sh.draft, d = curDay(), isStart = !sh.trip && sh.index === 0;
  const from = sh.trip ? originOf(sh) : d?.items[sh.index - 1];
  const stayChips = [0, 30, 60, 90, 120, 180].map(m => `<button class="chip-btn ${dr.stay === m ? 'on' : ''}" data-act="edStayQuick" data-m="${m}">${m ? fmtDur(m) : '없음'}</button>`).join('');
  const modes = Object.entries(MODES).map(([k, m]) => `<button class="chip-btn ${dr.mode === k ? 'on' : ''}" data-act="edMode" data-mode="${k}">${m.icon} ${m.label}</button>`).join('');
  const legInfo = hasPos(from) && hasPos(dr)
    ? `<div class="leg-preview">${MODES[dr.mode].icon} ${esc(from.place)} → ${esc(dr.place || '도착지')} · ${fmtDist(haversine(from, dr))} · 약 ${fmtDur(estimateMin(haversine(from, dr), dr.mode))}</div>` : '';
  const title = sh.id ? (isStart ? '출발지 수정' : '장소 수정') : sh.trip ? '새 일정' : `${sh.index + 1}번째 장소 추가`;

  // 1) 도착지 (출발지 수정일 때는 출발지)
  let html = `<div class="sheet-head"><div class="st-label">${dayLabel(sh.date)} · ${title}</div><button class="x" data-act="closeSheet">✕</button></div>
    ${headWithMap(isStart ? '출발지' : '도착지', 'dest')}
    ${!sh.trip && !isStart && from ? `<div class="from-line">출발: <b>${esc(from.place)}</b>에서 <span class="muted small">(바로 앞 장소)</span></div>` : ''}
    <div class="search-row"><input id="edQuery" placeholder="${isStart ? '출발지 검색 (예: 숙소 이름)' : '도착지 이름이나 주소 (예: 시드니 오페라하우스)'}" value="${esc(sh.query)}" enterkeyhint="search"><button class="primary" data-act="edSearch">검색</button></div>
    ${resultsHtml(sh.results, 'edChoose')}
    ${isStart ? '<div class="chips pick-row"><button class="chip-btn" data-act="edHere">📍 현위치 출발</button></div>' : ''}
    <div class="picked">${placeBox(dr, isStart ? '아직 출발지를 고르지 않았어요' : '아직 도착지를 고르지 않았어요')}</div>`;

  if (sh.trip) {
    // 2) 출발지 (빈 날 첫 일정: 같은 화면에서)
    const h = prevHotel(sh.date), today = sh.date === todayStr();
    // 출발지: 도착지와 같은 순서(제목 → 검색 → 고른 위치). 비워 두면 현재 위치
    const auto = S.pos
      ? '<div>📍 <b>현재 위치</b></div><div class="muted small">검색하지 않으면 지금 있는 곳에서 출발해요</div>'
      : '<div>📍 <b>현재 위치</b></div><div class="muted small">내 위치를 찾는 중이에요. 못 찾으면 출발지를 검색해 주세요</div>';
    html += `<div class="section">
      ${headWithMap('출발지', 'origin')}
      <div class="search-row"><input id="orQuery" placeholder="비워 두면 현재 위치에서 출발 (숙소, 역 등 검색)" value="${esc(sh.oQuery)}" enterkeyhint="search"><button class="primary" data-act="orSearch">검색</button></div>
      ${resultsHtml(sh.oResults, 'orChoose')}
      <div class="picked origin">${sh.origin ? `${placeBox(sh.origin, '')}<button class="link" data-act="orReset">✕ 현재 위치에서 출발로 되돌리기</button>` : auto}</div>
      ${h && !sh.origin ? `<div class="chips pick-row"><button class="chip-btn" data-act="orHotel">🏨 ${esc(h.place)}에서 출발</button></div>` : ''}
    </div>
    ${legInfo}
    <div class="field">시간
      <div class="seg">
        ${today ? `<button class="${sh.timeMode === 'now' ? 'on' : ''}" data-act="trMode" data-m="now">즉시 떠나기</button>` : ''}
        <button class="${sh.timeMode === 'dep' ? 'on' : ''}" data-act="trMode" data-m="dep">출발 시간 정하기</button>
        <button class="${sh.timeMode === 'arr' ? 'on' : ''}" data-act="trMode" data-m="arr">도착 시간 정하기</button>
      </div>
      ${sh.timeMode === 'now'
        ? `<span class="muted small">지금 바로(${fmtClock(nowMin())}) 출발해요. 도착 시간은 자동 계산돼요.</span>`
        : `${timeField('trTime', sh.tval)}
      <span class="muted small">${sh.timeMode === 'dep' ? '이 시간에 출발지에서 떠나요. 도착 시간은 자동 계산돼요.' : '이 시간까지 도착하도록 출발 시간을 거꾸로 계산해요 (예약 등).'}</span>`}
    </div>
    <div class="field">이동 방법<div class="chips">${modes}</div></div>`;
  } else {
    html += legInfo + `<div class="field">${isStart ? '출발 시간' : '도착 시간 <span class="muted small">(예약처럼 정해진 경우만. 비우면 자동 계산)</span>'}
      ${timeField('edTime', dr.time, { placeholder: isStart ? '출발 시간 고르기' : '정해진 시간 없음 (자동)', clearable: !isStart })}</div>
    ${sh.id ? `<div class="field">${isStart ? '출발 전 머무는 시간' : '머무는 시간'}<div class="chips">${stayChips}<span class="stay-input"><input id="edStay" type="number" min="0" step="5" value="${dr.stay || 0}">분</span></div></div>` : ''}
    ${isStart ? '' : `<div class="field">이동 방법<div class="chips">${modes}</div></div>`}`;
  }

  // 3) 장소 이름 · 메모
  html += `<label class="field">장소 이름<input id="edName" value="${esc(dr.place)}" placeholder="예: 숙소, 오페라하우스"></label>
    <label class="field">메모<textarea id="edMemo" rows="2" placeholder="예약 번호, 할 일 등">${esc(dr.memo)}</textarea></label>
    <div class="att-edit">
      ${(dr.files || []).map((f, k) => `<span class="att-chip">${isPdf(f) ? '📄' : '🖼️'} ${esc(f.name)}<button data-act="edFileDel" data-k="${k}" aria-label="첨부 빼기">✕</button></span>`).join('')}
      <button class="chip-btn" data-act="attach" data-target="draft">📎 사진·파일 첨부</button>
    </div>
    <div class="st-actions"><button class="primary" data-act="edSave">저장</button>${sh.id ? '<button data-act="delPlace" data-id="' + sh.id + '" class="danger">삭제</button>' : ''}<button data-act="closeSheet">취소</button></div>`;
  return html;
}

async function edSearch(target = 'dest') {
  syncDraft();
  const sh = S.sheet, origin = target === 'origin';
  const q = ((origin ? sh.oQuery : sh.query) || '').trim();
  if (!q) { toast('검색할 장소를 적어 주세요'); return; }
  if (origin) sh.oResults = 'loading'; else sh.results = 'loading';
  renderSheet();
  const d = curDay();
  const near = d?.items.find(hasPos) || (hasPos(sh.origin) ? sh.origin : null) || S.pos || null;
  let res;
  try {
    if (gkey()) res = await searchPlaces(gkey(), q, near);
    else {
      // 무료 검색: 그날 장소 근처에서 먼저, 없으면 전체에서
      res = near ? await searchPlacesFree(q, near) : [];
      if (!res.length) res = await searchPlacesFree(q);
    }
    if (near) res.sort((a, b) => haversine(near, a) - haversine(near, b)); // 가까운 곳부터
  } catch (e) {
    res = [];
    toast(`검색 실패: ${e.message}`, 5000);
  }
  if (S.sheet !== sh) return;
  if (origin) sh.oResults = res; else sh.results = res;
  renderSheet();
}

function edChoose(k) {
  syncDraft();
  const sh = S.sheet, r = sh.results[k];
  Object.assign(sh.draft, { lat: r.lat, lng: r.lng, address: r.address });
  if (!sh.draft.place || sh.draft.place === '선택한 위치' || sh.draft.place === '현재 위치') sh.draft.place = r.name;
  sh.results = null;
  renderSheet();
  renderMap(false);
  S.map?.panTo(r, 16);
}

function setOrigin(p) {
  syncDraft();
  const sh = S.sheet;
  sh.origin = p;
  sh.oResults = null;
  renderSheet();
  renderMap(false);
}

function hereOrToast() {
  if (S.pos) return { lat: S.pos.lat, lng: S.pos.lng };
  toast('아직 내 위치를 찾는 중이에요. 위치 권한을 확인해 주세요', 4000);
  return null;
}

function edSave() {
  syncDraft();
  const sh = S.sheet, dr = sh.draft;
  if (!dr.place) { toast(sh.trip ? '도착지를 골라 주세요' : '장소 이름을 적어 주세요'); return; }
  if (sh.trip && !originOf(sh)) { toast('내 위치를 아직 못 찾았어요. 출발지를 검색해서 골라 주세요', 4000); return; }
  if (!hasPos(dr) && !confirm('위치를 고르지 않았어요. 위치 없이 저장할까요? (지도와 거리 계산에서 빠져요)')) return;
  const d = ensureDay(sh.date);
  const item = {
    id: sh.id || newId(), place: dr.place, address: dr.address || '', lat: dr.lat ?? null, lng: dr.lng ?? null,
    time: dr.time, stay: dr.stay || 0, mode: dr.mode, memo: dr.memo || '', notes: dr.notes || [], files: dr.files || [],
  };
  if (dr.auto) item.auto = true;
  let imp = null;
  if (!sh.trip) {
    // 끼워 넣거나 고쳐서 뒤 예약에 늦게 되면 먼저 물어봄
    const items = [...d.items];
    if (sh.id) items[items.findIndex(x => x.id === sh.id)] = item; else items.splice(sh.index, 0, item);
    const fitted = !sh.id && item.time == null && sh.index > 0 ? keepStay(d, items, sh.index - 1) : items;
    imp = confirmChange(d, fitted);
    if (!imp) return;
    if (fitted !== items) d.items[sh.index - 1] = fitted[sh.index - 1];
  }
  sh.saved = true;
  (sh.removed || []).forEach(id => deleteFile(id).catch(() => {})); // 수정 창에서 뺀 첨부는 실제로 지움
  if (sh.trip) {
    // 출발지 + 도착지를 한 번에 만듦
    const o = originOf(sh);
    const start = { id: newId(), place: o.place, address: o.address || '', lat: o.lat, lng: o.lng, time: null, stay: 0, mode: 'TRANSIT', memo: '', notes: [] };
    if (sh.timeMode === 'now') { start.time = nowMin(); item.time = null; }        // 지금 바로 출발
    else if (sh.timeMode === 'dep') { start.time = sh.tval; item.time = null; }  // 정한 시간에 출발
    else { item.time = sh.tval; }                                                // 정한 시간까지 도착
    d.items.splice(0, 0, start, item);
  } else if (sh.id) d.items[d.items.findIndex(x => x.id === sh.id)] = item;
  else d.items.splice(sh.index, 0, item);
  savePlan();
  recompute();
  closeSheet();
  renderAll(true);
  prefetchLegs();
  scheduleAlarms();
  changeToast(imp, sh.id ? '수정했어요' : sh.trip ? `${originOf(sh).place} → ${item.place} 일정을 만들었어요` : `${item.place} 저장했어요. 지도에 표시했어요`);
}

function deletePlace(d, idx) {
  const it = d.items[idx];
  if (!confirm(`"${it.place}"을(를) 시간표에서 지울까요?`)) return;
  d.items.splice(idx, 1);
  delete progOf(d.date)[it.id];
  (it.files || []).forEach(f => deleteFile(f.id).catch(() => {}));
  if (!d.items.length) S.plan.days = S.plan.days.filter(x => x !== d);
  savePlan(); saveProgress();
  recompute();
  if (S.sheet?.type === 'edit') closeSheet();
  renderAll(false); prefetchLegs(); scheduleAlarms();
}

function movePlace(d, idx, dir) {
  const j = idx + dir;
  if (j < 0 || j >= d.items.length) return;
  [d.items[idx], d.items[j]] = [d.items[j], d.items[idx]];
  savePlan(); recompute(); renderAll(false); prefetchLegs(); scheduleAlarms();
}

// ---------- 초대 코드 (지인 전용 구글 검색) ----------
function openInvite() {
  S.sheet = { type: 'invite', err: '', busy: false };
  renderSheet();
  setTimeout(() => $('#inviteCode')?.focus(), 300);
}

function inviteHtml(sh) {
  return `<div class="sheet-head"><div><div class="st-label">트립플립</div><b>🔑 초대 코드</b></div><button class="x" data-act="closeSheet">✕</button></div>
    <p class="muted">지인에게 받은 초대 코드를 넣으면 구글 장소 검색·맛집 추천·대중교통 경로를 쓸 수 있어요. 코드가 없어도 무료 지도로 쓸 수 있어요.</p>
    <label class="field">초대 코드<input id="inviteCode" inputmode="numeric" autocomplete="off" value="${esc(S.settings.invite)}" placeholder="예: 1234"></label>
    ${sh.err ? `<div class="dt-warn">⚠ ${esc(sh.err)}</div>` : ''}
    <div class="st-actions"><button class="primary" data-act="inviteOk" ${sh.busy ? 'disabled' : ''}>${sh.busy ? '확인 중…' : '확인'}</button><button data-act="inviteSkip">코드 없이 쓰기</button></div>`;
}

async function inviteOk() {
  const sh = S.sheet, code = $('#inviteCode').value.trim();
  if (!code) { sh.err = '코드를 입력해 주세요'; renderSheet(); return; }
  sh.busy = true; sh.err = ''; renderSheet();
  let ok;
  try { ok = await checkInvite(code); } catch { ok = null; }
  if (S.sheet !== sh) return;
  sh.busy = false;
  if (ok === true) {
    Object.assign(S.settings, { invite: code, inviteAsked: true });
    store.set('tg.settings', S.settings);
    setInvite(code);
    closeSheet();
    toast('확인됐어요! 이제 구글 검색·추천·경로를 쓸 수 있어요', 4000);
    recompute(); renderAll(false); geocodeMissing(); prefetchLegs();
    return;
  }
  sh.err = ok === 'wait' ? '너무 많이 틀렸어요. 1분 뒤 다시 해 주세요' : ok === false ? '코드가 맞지 않아요' : '인터넷 연결을 확인해 주세요';
  renderSheet();
}

// 서버의 초대 코드가 바뀌어 거절됨 → 저장된 코드 지우고 다시 물어봄
function inviteRejected() {
  if (!S.settings.invite) return;
  S.settings.invite = '';
  store.set('tg.settings', S.settings);
  setInvite('');
  toast('초대 코드가 바뀌었어요. 새 코드를 넣어 주세요', 5000);
  if (!S.sheet) openInvite();
}

// ---------- 설정 ----------
function settingsHtml() {
  const s = S.settings;
  return `<div class="sheet-head"><b>설정</b><button class="x" data-act="closeSheet">✕</button></div>
    <label class="field">구글맵 API 키<input id="setKey" type="password" autocomplete="off" value="${esc(s.apiKey)}" placeholder="AIza…"></label>
    <div class="muted small">${PROXY_URL
      ? '비워 두어도 트립플립 서버를 통해 구글 장소 검색·추천·경로를 쓸 수 있어요. 내 키를 넣으면 지도 화면도 구글맵으로 바뀌어요.'
      : '키는 이 기기에만 저장돼요. 비워 두면 무료 지도와 추정 시간으로 동작해요.'}</div>
    ${PROXY_URL ? `<div class="field">초대 코드 <span class="muted small">(지인 전용 구글 검색)</span>
      <div class="st-actions"><span class="muted small">${s.invite ? '✅ 입력됨' : '아직 없음 · 무료 지도로 동작 중'}</span><button data-act="invite">${s.invite ? '코드 바꾸기' : '코드 입력'}</button></div></div>` : ''}
    <label class="field">도착으로 인정할 거리 (m)<input id="setRadius" type="number" min="20" max="1000" value="${s.radius}"></label>
    <label class="field">출발 몇 분 전에 미리 알림 (0이면 끔)<input id="setLead" type="number" min="0" max="120" value="${s.lead}"></label>
    <label class="field">예약 시간 전 여유 (분)<input id="setBuffer" type="number" min="0" max="60" value="${s.buffer}"></label>
    <label class="check"><input id="setSim" type="checkbox" ${s.sim ? 'checked' : ''}> 테스트 모드: 선택한 날을 오늘로 보고, 지도를 누른 곳을 내 위치로 사용</label>
    <div class="st-actions"><button class="primary" data-act="saveSettings">저장</button></div>
    <hr>
    <div class="st-actions wrap">
      <button data-act="askNotify">알림 권한 허용</button>
      <button data-act="testAlarm">10초 뒤 테스트 알람</button>
      <button data-act="load">📂 엑셀/CSV 일정 불러오기</button>
      <button data-act="guide">📄 일정 양식 · AI로 만들기</button>
      <button data-act="rename">여행 이름 바꾸기</button>
      ${curDay() ? '<button data-act="resetProgress">이 날 도착 기록 지우기</button><button data-act="clearRoutes">경로 다시 계산</button>' : ''}
      ${S.plan.days.length ? '<button data-act="deletePlan" class="danger">모든 일정 삭제</button>' : ''}
    </div>`;
}

function saveSettings() {
  const num = (id, def) => { const v = parseInt($(id).value, 10); return isFinite(v) ? v : def; };
  const old = S.settings;
  S.settings = {
    ...old,
    apiKey: $('#setKey').value.trim(),
    radius: Math.min(1000, Math.max(20, num('#setRadius', 100))),
    lead: Math.min(120, Math.max(0, num('#setLead', 10))),
    buffer: Math.min(60, Math.max(0, num('#setBuffer', 5))),
    sim: $('#setSim').checked,
  };
  store.set('tg.settings', S.settings);
  if (old.apiKey !== S.settings.apiKey) { location.reload(); return; }
  closeSheet();
  recompute(); renderAll(false); scheduleAlarms(true);
  toast('저장했어요');
}

// ---------- 알람 ----------
function buildAlarms() {
  const list = [], lead = S.settings.lead;
  for (const d of S.plan.days) {
    const { legs, sched } = dayPlan(d);
    const dn = Number(d.date.replace(/-/g, '').slice(2)); // yymmdd
    const prog = S.progress[d.date] || {};
    d.items.forEach((it, i) => {
      const next = d.items[i + 1];
      if (!next || prog[it.id]?.dep || prog[it.id]?.skip) return;
      const dep = atMs(d.date, sched[i].depart), m = MODES[next.mode];
      const body = `${it.place} → ${next.place} (${m.icon} ${m.label} ${fmtDur(legs[i + 1].dur)})`;
      const id = dn * 100 + i * 2;
      if (lead > 0) list.push({ id, at: dep - lead * 60000, title: `⏰ ${lead}분 뒤 출발 (${clockOf(dep)})`, body });
      list.push({ id: id + 1, at: dep, title: '🚶 지금 출발하세요', body });
    });
    // 모닝콜 (번호 97~99: 장소 알람과 겹치지 않게)
    const w = d.wake;
    if (w?.on && d.items.length) {
      const at = atMs(d.date, w.time);
      const body = `첫 출발 ${fmtClock(sched[0].depart)} · ${d.items[0].place}${d.title ? ` · ${d.title}` : ''}`;
      list.push({ id: dn * 100 + 97, at, title: `☀️ 모닝콜 ${fmtClock(w.time)}`, body, wake: true });
      if (w.snooze && !w.ack) {
        list.push({ id: dn * 100 + 98, at: at + 5 * 60000, title: '☀️ 일어나세요! (5분 지남)', body, wake: true });
        list.push({ id: dn * 100 + 99, at: at + 10 * 60000, title: '☀️ 일어나세요! (10분 지남)', body, wake: true });
      }
    }
  }
  return list;
}

let alarmTimer, alarmSig = '';
function scheduleAlarms(force, extra = []) {
  clearTimeout(alarmTimer);
  alarmTimer = setTimeout(async () => {
    const list = [...buildAlarms(), ...extra];
    const sig = JSON.stringify(list.map(a => [a.id, a.at, a.body]));
    if (!force && sig === alarmSig) return;
    alarmSig = sig;
    try { await Alarms.set(list); } catch (e) { toast(`알람 예약 실패: ${e.message}`, 5000); }
  }, 500);
}

function showAlarm(a) {
  const el = $('#alarm');
  el.innerHTML = `<div class="alarm-title">${esc(a.title)}</div><div>${esc(a.body)}</div><button data-act="dismissAlarm">확인</button>`;
  el.hidden = false;
  beep();
  webNotify(a);
}

// ---------- 일정 불러오기 / 경로·위치 자동 계산 ----------
// 앱을 켜면 항상 오늘 날짜 (오늘 일정을 다 마쳤으면 다음 일정 날)
function pickInitialDay() {
  const t = todayStr(), today = S.plan.days.find(d => d.date === t && d.items.length);
  if (today && phase(today).type === 'done') return S.plan.days.find(d => d.date > t && d.items.length)?.date || t;
  return t;
}

// 지금 시각의 일정이 화면 가운데 오게
function scrollToNow() {
  const row = document.querySelector('.row.here, .row.next') || document.querySelector('.row:not(.done):not(.skip)');
  if (row) row.scrollIntoView({ block: 'center' });
}

// 엑셀을 다시 불러와도, 같은 날 같은 장소의 첨부 파일과 그날 모닝콜은 이어받음
function carryOver(oldPlan, plan) {
  const files = new Map(), wakes = new Map();
  for (const d of oldPlan?.days || []) {
    if (d.wake?.on) wakes.set(d.date, d.wake);
    for (const it of d.items) if (it.files?.length) files.set(`${d.date}|${it.place}`, (files.get(`${d.date}|${it.place}`) || []).concat(it.files));
  }
  let kept = 0, wk = 0;
  for (const d of plan.days) {
    if (wakes.has(d.date)) { d.wake = { ...wakes.get(d.date), ack: null }; wk++; }
    for (const it of d.items) {
      const key = `${d.date}|${it.place}`;
      if (files.has(key)) { it.files = files.get(key); files.delete(key); kept += it.files.length; }
    }
  }
  // 새 일정에 없는 장소의 첨부는 정리
  for (const list of files.values()) list.forEach(f => deleteFile(f.id).catch(() => {}));
  return [kept && `첨부 파일 ${kept}개`, wk && `모닝콜 ${wk}개`].filter(Boolean).join('와 ');
}

function loadPlan(plan) {
  const kept = carryOver(S.plan, plan);
  if (kept) setTimeout(() => toast(`${kept}는 그대로 이어졌어요`, 4000), 3200);
  S.plan = plan; savePlan();
  S.progress = {}; saveProgress();
  const places = plan.days.reduce((n, d) => n + d.items.length, 0);
  toast(`${plan.days.length}일, ${places}곳을 불러왔어요`);
  closeSheet();
  selectDay(pickInitialDay(), false);
  geocodeMissing();
  scheduleAlarms(true);
}

// manual: 사용자가 직접 고른 날짜(뒤로 가기 기록에 남김), fromBack: 뒤로 가기로 돌아온 경우
function selectDay(date, manual, fromBack) {
  if (manual && !fromBack && S.selected && date !== S.selected) {
    S.dayBack.push(S.selected);
    if (S.dayBack.length > 30) S.dayBack.shift();
  }
  S.selected = date;
  S.followToday = !manual || date === todayStr();
  S.open = null;
  S.live = null;
  S.focus = null;
  S.detail = null;
  if (S.stack.length > 1) { S.stack = ['list']; applyLayers(); }
  if (S.sheet && S.sheet.type !== 'cal') closeSheet();
  recompute();
  renderAll(true);
  prefetchLegs();
  updateLiveRoute(true);
}

const FAR_KM = 300; // 같은 날 다른 장소들에서 이보다 멀면 잘못 찾은 위치로 봄

// 이 장소 근처의 기준점: 같은 날, 순서상 가장 가까운 위치 있는 장소 (다른 날은 다른 도시일 수 있어 안 씀)
function anchorFor(d, it) {
  const i = d.items.indexOf(it);
  const byDist = d.items.map((x, k) => [x, Math.abs(k - i)]).filter(([x]) => x !== it && hasPos(x)).sort((a, b) => a[1] - b[1]);
  return byDist.length ? byDist[0][0] : null;
}

// 하루 장소들의 가운데(위도·경도 각각의 중앙값)
function dayCenter(d) {
  const ps = d.items.filter(hasPos);
  if (ps.length < 3) return null;
  const med = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  return { lat: med(ps.map(p => p.lat)), lng: med(ps.map(p => p.lng)) };
}

// 같은 날 다른 장소들과 수백 km 떨어진 위치(다른 도시의 같은 이름 장소)는 지우고 다시 찾게 함
function dropFarPlaces() {
  let n = 0;
  for (const d of S.plan.days) {
    const c = dayCenter(d);
    if (!c) continue;
    for (const it of d.items) {
      if (hasPos(it) && haversine(c, it) > FAR_KM * 1000) {
        delete S.geoCache[it.address || it.place];
        it.lat = null; it.lng = null;
        n++;
      }
    }
  }
  if (n) { savePlan(); store.set('tg.geo', S.geoCache); }
  return n;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 장소 하나의 위치 찾기: 같은 날 다른 장소가 있으면 그 근처에서, 너무 먼 결과는 버림
async function findPlace(q, anchor) {
  const key = gkey();
  const near = r => !anchor || haversine(anchor, r) < FAR_KM * 1000;
  if (key) return (await searchPlaces(key, q, anchor)).find(near) || null;
  await sleep(1100); // 무료 검색은 1초에 한 번까지
  let g = (await searchPlacesFree(q, anchor)).find(near);
  if (!g && anchor) { await sleep(1100); g = (await searchPlacesFree(q)).find(near); }
  return g || null;
}

// 엑셀의 정확한 주소 + 영문 이름으로 위치 찾기 (무료 지도는 "이름, 주소"를 한꺼번에 넣으면 못 찾음)
// ① 주소 그대로 → ② 주소의 동네를 찾고 그 근처에서 영문 이름/장소 이름 → ③ 동네 위치(대략) → ④ 이름으로(예전 방식)
async function locate(it, anchor) {
  const addr = (it.address || '').trim(), names = [...new Set([it.nameEn, it.place].filter(Boolean))];
  const parts = addr.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const g = await findPlace(addr, anchor);
    if (g) return g;
    // 번지(첫 칸)를 하나씩 떼면서 동네·도시 위치 찾기
    let area = null;
    for (let k = 1; k <= parts.length - 2 && !area; k++) area = await findPlace(parts.slice(k).join(', '), anchor);
    if (area) {
      for (const n of names) {
        const g2 = await findPlace(n, area); // 동네 근처부터 찾고, 없으면 같은 지역(수백 km) 안에서
        if (g2) return g2;
      }
      return area;
    }
  }
  for (const q of [...new Set([parts.length >= 2 ? '' : addr, ...names])].filter(Boolean)) {
    const g = await findPlace(q, anchor);
    if (g) return g;
  }
  // "Meriton Suites Kent Street Sydney"처럼 이름+도시 한 줄이면 끝 단어(도시)를 떼고 그날 다른 장소 근처에서 한 번 더
  const words = addr.split(/\s+/);
  if (parts.length < 2 && words.length >= 3 && anchor) return findPlace(words.slice(0, -1).join(' '), anchor);
  return null;
}

let geocoding = false, geocodeAgain = false;
async function geocodeMissing() {
  // 찾는 중에 새 일정을 불러오면, 지금 것이 끝난 뒤 새 일정으로 한 번 더
  if (geocoding) { geocodeAgain = true; return; }
  geocoding = true;
  const plan = S.plan;
  try {
    let fixed = dropFarPlaces(), found = 0, failed = 0;
    // 두 번까지: 처음 찾은 결과가 그날 다른 장소들과 동떨어지면 지우고 한 번 더
    for (let pass = 0; pass < 2; pass++) {
      const todo = S.plan.days.flatMap(d => d.items.filter(it => !hasPos(it)).map(it => [d, it]));
      if (!todo.length) break;
      failed = 0;
      let errors = 0, lastErr = null;
      for (const [k, [d, it]] of todo.entries()) {
        if (S.plan !== plan) return; // 다른 일정을 불러왔으면 그만
        const q = it.address || it.place;
        let g = S.geoCache[q];
        if (!g) {
          if (!gkey()) toast(`📍 장소 위치 찾는 중… ${k + 1}/${todo.length}`, 8000);
          try {
            g = await locate(it, anchorFor(d, it));
            errors = 0;
          } catch (e) {
            // 한 곳이 실패해도 멈추지 않고 다음 장소로. 연속으로 계속 실패하면(인터넷 끊김 등) 잠시 멈춤
            lastErr = e; failed++;
            if (++errors >= 4) { toast(`장소 검색이 계속 실패해요 (${e.message}). 잠시 뒤 앱을 다시 열면 이어서 찾아요`, 7000); break; }
            await sleep(3000);
            continue;
          }
        }
        if (!g) { failed++; continue; }
        S.geoCache[q] = g;
        it.lat = g.lat; it.lng = g.lng;
        found++;
        // 찾는 대로 바로 화면에 표시하고 저장 (다 끝날 때까지 기다리지 않게)
        if (d === curDay()) { recompute(); renderAll(false); }
        if (found % 3 === 0) { savePlan(); store.set('tg.geo', S.geoCache); }
      }
      if (lastErr && errors >= 4) break;
      const more = dropFarPlaces();
      fixed += more;
      if (!more) break;
    }
    store.set('tg.geo', S.geoCache);
    savePlan();
    if (found) {
      toast(fixed ? `잘못 찾았던 장소 ${fixed}곳을 다시 찾았어요` : `장소 ${found}곳의 위치를 찾았어요`, 4000);
      recompute(); renderAll(true); prefetchLegs();
    }
    if (failed) {
      // 무료 지도로 찾다가 실패: 초대 코드가 있으면 구글로 정확히 찾을 수 있다고 알려 주고 바로 입력 창
      if (PROXY_URL && !gkey()) { toast(`위치를 찾지 못한 장소 ${failed}곳: 초대 코드를 넣으면 구글로 다시 찾아요`, 6000); if (!S.sheet) openInvite(); }
      else toast(`위치를 찾지 못한 장소 ${failed}곳: 목록의 "위치 없음"을 누르면 바로 고를 수 있어요`, 6000);
    }
  } finally {
    geocoding = false;
    if (geocodeAgain) { geocodeAgain = false; geocodeMissing(); }
  }
}

let prefetchRun = 0;
async function prefetchLegs() {
  const key = gkey(), d = curDay();
  if (!d) return;
  const run = ++prefetchRun;
  for (let i = 1; i < d.items.length; i++) {
    const a = d.items[i - 1], b = d.items[i];
    if (!hasPos(a) || !hasPos(b) || S.legCache[legKey(a, b, b.mode)]) continue;
    if (!key && b.mode === 'TRANSIT') continue; // 대중교통은 구글 키가 있어야
    try {
      const departAt = atMs(d.date, S.cur.sched[i - 1].depart);
      const routes = await routeFor(key, a, b, b.mode, departAt);
      S.legCache[legKey(a, b, b.mode)] = routes.length ? pickLeg(routes[0]) : { fail: true };
    } catch (e) {
      toast(`경로 계산 실패: ${e.message}`, 5000);
      return;
    }
    saveLegs();
    if (run !== prefetchRun || curDay() !== d) return;
    recompute(); renderAll(false);
  }
  scheduleAlarms();
}

// ---------- 버튼 처리 ----------
async function act(name, el) {
  const d = curDay(), i = +el.dataset.i;
  switch (name) {
    case 'load': $('#fileInput').click(); break;
    case 'sample': {
      const text = await (await fetch('sample.csv')).text();
      loadPlan(parsePlanText(text, '도쿄 여행 (샘플)'));
      break;
    }
    case 'rename': {
      const t = prompt('여행 이름', S.plan.title || '');
      if (t != null && t.trim()) { S.plan.title = t.trim(); savePlan(); renderAll(false); }
      break;
    }
    case 'calendar': S.calMonth = null; S.sheet = { type: 'cal' }; S.routeView = null; renderSheet(); break;
    case 'settings': S.sheet = { type: 'settings' }; S.routeView = null; renderSheet(); break;
    case 'toggleView': if (topLayer() === 'map') popLayer(); else openMap(null); break;
    case 'toList': popLayer(); break;
    case 'openMap': openMap(i); break;
    case 'focusMap': focusMapItem(i); break;
    case 'openDetail': openDetail(i, !!el.dataset.swap); break;
    case 'detailMap': openMap(S.detail, 'bottom'); break;
    case 'cardToList': backToList(i); break;
    case 'guide': S.sheet = { type: 'guide' }; S.routeView = null; renderSheet(); break;
    case 'getTemplate': getTemplate(); break;
    case 'copyPrompt': copyPrompt(); break;
    case 'suggest': openSuggest(el.dataset.type, +el.dataset.k); break;
    case 'nearMe': nearMe(el.dataset.type); break;
    case 'nearNav': { const r = S.sheet.results[+el.dataset.j]; openExternal(navUrl(null, r, 'WALK', r.name)); break; }
    case 'suggestSkip': {
      (d.skipMeals ||= {})[el.dataset.type] = true;
      savePlan(); renderTimeline();
      toast('이 추천을 숨겼어요');
      break;
    }
    case 'suggestAdd': suggestAdd(S.sheet.results[+el.dataset.j]); break;
    case 'suggestMap': {
      const sh = S.sheet, r = sh.results[+el.dataset.j];
      S.poi = { lat: r.lat, lng: r.lng, name: r.name, from: sh.k };
      closeSheet();
      openMap(sh.k, 'bottom');
      break;
    }
    case 'suggestNav': { const r = S.sheet.results[+el.dataset.j]; openExternal(navUrl(null, r, 'WALK', r.name)); break; }
    case 'fixPlace': {
      // 위치 없는 장소: 수정 창을 열고 장소 이름으로 바로 검색해 둠 → 결과에서 고르기만
      const it = d.items[i];
      openEditor(i, it.id);
      S.sheet.query = it.place || it.address;
      renderSheet(); // 검색칸에 이름을 먼저 채운 뒤 검색
      edSearch('dest');
      break;
    }
    case 'tpOpen': case 'tpAmpm': case 'tpH': case 'tpM': case 'tpDone': case 'tpClear': tpAct(name, el); break;
    case 'files': openViewer(i, 0); break;
    case 'viewFile': openViewer(i, +el.dataset.k); break;
    case 'closeViewer': closeViewer(); break;
    case 'vwPrev': openViewer(S.viewer.i, S.viewer.k - 1); break;
    case 'vwNext': openViewer(S.viewer.i, S.viewer.k + 1); break;
    case 'delFile': deleteAttachment(); break;
    case 'attach':
      if (el.dataset.target === 'draft') { syncDraft(); S.attachTo = { draft: true }; } else S.attachTo = { i };
      $('#attachInput').click();
      break;
    case 'edFileDel': {
      syncDraft();
      const sh = S.sheet, [f] = sh.draft.files.splice(+el.dataset.k, 1);
      (sh.removed ||= []).push(f.id);
      renderSheet();
      break;
    }
    case 'poi': openPoi(i, el.dataset.name); break;
    case 'poiMap': {
      const sh = S.sheet, r = sh.results[+el.dataset.k];
      S.poi = { lat: r.lat, lng: r.lng, name: r.name, from: sh.i };
      closeSheet();
      openMap(sh.i, 'bottom');
      break;
    }
    case 'poiNav': { const r = S.sheet.results[+el.dataset.k]; openExternal(navUrl(null, r, 'WALK', r.name)); break; }
    case 'poiAdd': poiAdd(S.sheet.results[+el.dataset.k], S.sheet.i); break;
    case 'poiWeb': openExternal(el.dataset.url); break;
    case 'toggleMore': {
      const id = d.items[i].id;
      S.open = S.open === id ? null : id;
      document.querySelectorAll('.tl-row').forEach(r => r.classList.toggle('open', S.open === d.items[+r.dataset.i]?.id));
      break;
    }
    case 'noop': break;
    case 'calPrev': case 'calNext': {
      const c = S.calMonth, m = c.m + (name === 'calNext' ? 1 : -1);
      S.calMonth = m < 1 ? { y: c.y - 1, m: 12 } : m > 12 ? { y: c.y + 1, m: 1 } : { y: c.y, m };
      renderSheet();
      break;
    }
    case 'pickDate': closeSheet(); selectDay(el.dataset.date, true); break;
    case 'goDay': selectDay(el.dataset.date, true); break;
    case 'addPlace': openEditor(i); break;
    case 'editPlace': openEditor(i, d.items[i].id); break;
    case 'delPlace': deletePlace(d, el.dataset.id ? d.items.findIndex(x => x.id === el.dataset.id) : i); break;
    case 'moveUp': movePlace(d, i, -1); break;
    case 'moveDown': movePlace(d, i, 1); break;
    case 'edSearch': edSearch('dest'); break;
    case 'edChoose': edChoose(+el.dataset.k); break;
    case 'orSearch': edSearch('origin'); break;
    case 'orChoose': { const r = S.sheet.oResults[+el.dataset.k]; setOrigin({ place: r.name, address: r.address, lat: r.lat, lng: r.lng, from: 'search' }); break; }
    case 'orHere': { const p = hereOrToast(); if (p) setOrigin({ place: '현재 위치', address: '', ...p, from: 'here' }); break; }
    case 'orReset': setOrigin(null); break;
    case 'orHotel': { const h = prevHotel(S.sheet.date); if (h) setOrigin({ place: h.place, address: h.address, lat: h.lat, lng: h.lng, from: 'hotel' }); break; }
    case 'edHere': {
      const p = hereOrToast();
      if (!p) break;
      syncDraft();
      const dr = S.sheet.draft;
      Object.assign(dr, { ...p, address: '' });
      if (!dr.place) dr.place = '현재 위치';
      renderSheet(); renderMap(false);
      break;
    }
    case 'trMode': syncDraft(); S.sheet.timeMode = el.dataset.m; renderSheet(); break;
    case 'edPick':
      syncDraft();
      S.pick = true; S.pickReturn = topLayer();
      S.pickTarget = el.dataset.target === 'origin' ? 'origin' : 'dest'; // 출발지 / 도착지 중 어느 쪽을 고르는지
      if (topLayer() !== 'map') openMap(S.focus);
      renderSheet();
      toast('지도에서 원하는 곳을 누르세요');
      break;
    case 'pickCancel': finishPick(); break;
    case 'edStayQuick': syncDraft(); S.sheet.draft.stay = +el.dataset.m; renderSheet(); break;
    case 'edMode': syncDraft(); S.sheet.draft.mode = el.dataset.mode; renderSheet(); renderMap(false); break;
    case 'edSave': edSave(); break;
    case 'nav': {
      const live = isLive() && S.pos;
      openExternal(navUrl(live ? null : d.items[i - 1], d.items[i], d.items[i].mode, d.items[i].place));
      break;
    }
    case 'route': openRouteSheet(i); break;
    case 'arrive': markArrive(d, i); break;
    case 'depart': markDepart(d, i); break;
    case 'clear': delete progOf(d.date)[d.items[i].id]; changed(); break;
    case 'gmap': openExternal(placeUrl(d.items[i])); break;
    case 'closeSheet': closeSheet(); break;
    case 'pickMode': selectRoute(el.dataset.mode, 0); break;
    case 'pickAlt': selectRoute(S.sheet.sel.mode, +el.dataset.k); break;
    case 'navMode': {
      const sh = S.sheet;
      openExternal(navUrl(sh.fromMe ? null : sh.from, d.items[sh.i], sh.sel.mode, d.items[sh.i].place));
      break;
    }
    case 'useMode': {
      const sh = S.sheet;
      d.items[sh.i].mode = sh.sel.mode;
      savePlan(); recompute(); renderAll(false); renderSheet(); scheduleAlarms();
      toast(`이동수단을 ${MODES[sh.sel.mode].label}(으)로 바꿨어요`);
      break;
    }
    case 'saveSettings': saveSettings(); break;
    case 'invite': openInvite(); break;
    case 'inviteOk': inviteOk(); break;
    case 'inviteSkip': S.settings.inviteAsked = true; store.set('tg.settings', S.settings); closeSheet(); toast('무료 지도로 쓸게요. 코드는 ⚙️ 설정에서 언제든 넣을 수 있어요', 5000); break;
    case 'askNotify': toast((await Alarms.requestPermission()) ? '알림이 허용됐어요' : '알림이 허용되지 않았어요'); break;
    case 'testAlarm':
      await Alarms.requestPermission();
      scheduleAlarms(true, [{ id: 999999, at: Date.now() + 10000, title: '🔔 테스트 알람', body: '알람이 잘 울려요' }]);
      toast('10초 뒤에 알람이 울려요. 앱을 닫거나 화면을 꺼도 돼요');
      break;
    case 'resetProgress': S.progress[d.date] = {}; changed(); toast('이 날의 도착 기록을 지웠어요'); break;
    case 'clearRoutes': S.legCache = {}; saveLegs(); recompute(); renderAll(false); prefetchLegs(); toast('경로를 다시 계산해요'); break;
    case 'deletePlan':
      if (!confirm('모든 일정과 기록을 지울까요?')) break;
      S.plan = emptyPlan(); S.progress = {};
      savePlan(); saveProgress(); closeSheet(); selectDay(todayStr(), false); scheduleAlarms(true);
      break;
    case 'dismissAlarm': dismissAlarm(); break;
    case 'exitApp': exitApp(); break;
    case 'wake': openWake(el.dataset.date || S.selected); break;
    case 'wkQuick': syncWake(); S.sheet.time = S.sheet.firstDep - +el.dataset.m; renderSheet(); break;
    case 'wkSave': saveWake(true); break;
    case 'wkOff': saveWake(false); break;
  }
}

// ---------- 모닝콜 ----------
function openWake(date) {
  const d = S.plan.days.find(x => x.date === date);
  if (!d?.items.length) { toast('먼저 그날 일정을 추가해 주세요'); return; }
  const firstDep = schedOf(d)[0].depart;
  const w = d.wake || {};
  S.sheet = { type: 'wake', date, firstDep, time: w.time ?? Math.max(0, firstDep - 90), snooze: w.snooze ?? true, on: !!w.on };
  S.tp = null;
  renderSheet();
}

function syncWake() {
  const sh = S.sheet;
  if (sh?.type !== 'wake') return;
  const t = fromHHMM($('#wkTime')?.value);
  if (t != null) sh.time = t;
  if ($('#wkSnooze')) sh.snooze = $('#wkSnooze').checked;
}

function wakeHtml(sh) {
  const d = S.plan.days.find(x => x.date === sh.date), first = d.items[0];
  const quick = [60, 90, 120].map(m => `<button class="chip-btn ${sh.firstDep - sh.time === m ? 'on' : ''}" data-act="wkQuick" data-m="${m}">출발 ${fmtDur(m)} 전</button>`).join('');
  return `<div class="sheet-head"><div><div class="st-label">${dayLabel(sh.date)} 모닝콜</div><b>몇 시에 깨워 드릴까요?</b></div><button class="x" data-act="closeSheet">✕</button></div>
    <div class="picked">첫 출발 <b>${fmtClock(sh.firstDep)}</b> · ${esc(first.place)}</div>
    <div class="field">깨울 시간${timeField('wkTime', sh.time)}</div>
    <div class="chips">${quick}</div>
    <label class="check"><input id="wkSnooze" type="checkbox" ${sh.snooze ? 'checked' : ''}> 일어날 때까지 5분 간격으로 2번 더 울리기 <span class="muted small">(앱을 열면 멈춰요)</span></label>
    <div class="st-actions"><button class="primary" data-act="wkSave">⏰ 모닝콜 켜기</button>${sh.on ? '<button data-act="wkOff" class="danger">모닝콜 끄기</button>' : ''}<button data-act="closeSheet">취소</button></div>`;
}

async function saveWake(on) {
  syncWake();
  const sh = S.sheet, d = S.plan.days.find(x => x.date === sh.date);
  d.wake = { on, time: sh.time, snooze: sh.snooze, ack: null };
  savePlan();
  closeSheet();
  renderStatus();
  renderTimeline();
  if (on) await Alarms.requestPermission();
  scheduleAlarms(true);
  toast(on ? `${dayLabel(sh.date)} ${fmtClock(sh.time)}에 깨워 드릴게요` : '모닝콜을 껐어요');
}

// 모닝콜이 울린 뒤 앱을 열거나 확인을 누르면 남은 "다시 울리기"를 취소
function ackWake() {
  const d = S.plan.days.find(x => x.date === todayStr());
  if (!d?.wake?.on || d.wake.ack) return;
  if (Date.now() < atMs(d.date, d.wake.time)) return;
  d.wake.ack = Date.now();
  savePlan();
  scheduleAlarms(true);
}

function dismissAlarm() {
  $('#alarm').hidden = true;
  ackWake();
}

// 지도에서 위치 고르기를 마치면 원래 보던 화면으로
function finishPick() {
  S.pick = false;
  if (S.pickReturn && S.pickReturn !== 'map') closeMap();
  S.pickReturn = null;
  renderSheet();
  renderMap(false);
}

document.addEventListener('click', e => {
  if (Date.now() - swipedAt < 400) return;
  const b = e.target.closest('[data-act]');
  if (b) { e.stopPropagation(); act(b.dataset.act, b); return; }
  const tab = e.target.closest('.tab');
  if (tab) selectDay(tab.dataset.date, true);
});
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.id === 'edQuery') { e.preventDefault(); edSearch('dest'); }
  if (e.key === 'Enter' && e.target.id === 'orQuery') { e.preventDefault(); edSearch('origin'); }
});

// ---------- 손가락을 따라 움직이는 화면 넘기기 ----------
const EASE = 'cubic-bezier(.32,.72,0,1)'; // 아이폰 화면 전환과 비슷한 감속 곡선
let swipedAt = 0;

// 드래그 공통: 가로/세로 방향을 먼저 정하고, 정해진 방향일 때만 처리
function dragTracker(el, { onMove, onEnd, axis: want, holdY }) {
  let st = null;
  const begin = (x, y) => { st = { x, y, t: Date.now(), axis: null, dx: 0, dy: 0 }; };
  const move = (x, y, e) => {
    if (!st) return;
    st.dx = x - st.x; st.dy = y - st.y;
    if (!st.axis && Math.hypot(st.dx, st.dy) > 10) st.axis = Math.abs(st.dx) > Math.abs(st.dy) * 1.2 ? 'x' : 'y';
    if (st.axis === want) {
      // 가로 끌기, 또는 holdY가 허락한 세로 끌기(예: 창 맨 위에서 아래로)는 화면 스크롤 대신 끌기로
      if (e?.cancelable && (want === 'x' || holdY?.(st))) e.preventDefault();
      onMove?.(st);
    }
  };
  const finish = () => {
    if (!st) return;
    const s = st; st = null;
    if (s.axis === want) onEnd(s, (Date.now() - s.t) || 1);
  };
  el.addEventListener('touchstart', e => begin(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
  el.addEventListener('touchmove', e => move(e.touches[0].clientX, e.touches[0].clientY, e), { passive: false });
  el.addEventListener('touchend', finish);
  el.addEventListener('touchcancel', () => (st = null));
  el.addEventListener('mousedown', e => { if (e.button === 0) begin(e.clientX, e.clientY); });
  window.addEventListener('mousemove', e => { if (st && e.buttons === 1) move(e.clientX, e.clientY, e); });
  window.addEventListener('mouseup', finish);
}

// 시간표: 좌우로 끌면 페이지가 손가락을 따라오고, 놓으면 전날/다음날로 넘어감
dragTracker($('#listView'), {
  axis: 'x',
  onMove(s) {
    if (S.sheet || topLayer() !== 'list') return;
    const page = $('#dayPage');
    page.style.transition = 'none';
    page.style.transform = `translateX(${s.dx}px)`;
    page.style.opacity = String(1 - Math.min(Math.abs(s.dx) / 700, 0.4));
  },
  onEnd(s, ms) {
    if (S.sheet || topLayer() !== 'list') return;
    const page = $('#dayPage'), w = page.offsetWidth, fast = Math.abs(s.dx) / ms > 0.5;
    if (Math.abs(s.dx) > w * 0.28 || (fast && Math.abs(s.dx) > 40)) swipeDay(s.dx < 0 ? 1 : -1);
    else {
      page.style.transition = `transform .4s ${EASE}, opacity .4s ${EASE}`;
      page.style.transform = '';
      page.style.opacity = '';
    }
  },
});

function swipeDay(dir) {
  const page = $('#dayPage'), w = page.offsetWidth || 375;
  swipedAt = Date.now(); // 밀기 직후의 클릭(상세 열림)은 무시
  // 1) 현재 날짜가 밀려 나감
  page.style.transition = `transform .26s ${EASE}, opacity .26s ${EASE}`;
  page.style.transform = `translateX(${-dir * w}px)`;
  page.style.opacity = '0';
  setTimeout(() => {
    // 2) 새 날짜를 반대편에 두고 미끄러져 들어옴
    selectDay(addDays(S.selected, dir), true);
    $('#listView').scrollTop = 0;
    page.style.transition = 'none';
    page.style.transform = `translateX(${dir * w * 0.6}px)`;
    void page.offsetWidth;
    page.style.transition = `transform .45s ${EASE}, opacity .3s ${EASE}`;
    page.style.transform = '';
    page.style.opacity = '';
  }, 230);
}

// 아래에서 올라온 창: 맨 위에서 아래로 쓸어내리면 닫힘 (손가락을 따라 내려감)
dragTracker($('#sheet'), {
  axis: 'y',
  holdY: s => s.dy > 0 && $('#sheet').scrollTop <= 0,
  onMove(s) {
    const el = $('#sheet');
    if (S.pick || el.scrollTop > 0 || s.dy <= 0) return;
    el.style.transition = 'none';
    el.style.transform = `translateY(${s.dy}px)`;
  },
  onEnd(s, ms) {
    const el = $('#sheet');
    if (S.pick || el.scrollTop > 0) { el.style.transform = ''; return; }
    if (s.dy > 110 || (s.dy > 40 && s.dy / ms > 0.6)) {
      el.style.transition = `transform .28s ${EASE}`;
      el.style.transform = 'translateY(110%)';
      setTimeout(() => { closeSheet(); el.style.transition = ''; el.style.transform = ''; }, 260);
    } else {
      el.style.transition = `transform .35s ${EASE}`;
      el.style.transform = '';
    }
  },
});

// 상세 페이지: 맨 아래에서 위로 쓸어올리면 그 일정의 지도
dragTracker($('#detailView'), {
  axis: 'y',
  onEnd(s) {
    const sc = $('#detailView .dt-scroll');
    if (!sc || topLayer() !== 'detail') return;
    const atBottom = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 6;
    if (atBottom && s.dy < -70) openMap(S.detail, 'bottom');
  },
});


$('#attachInput').addEventListener('change', async e => {
  const files = [...e.target.files];
  e.target.value = '';
  await attachFiles(files);
});

// 첨부 크게 보기에서 좌우로 밀어 다음/이전 파일
dragTracker($('#viewer'), {
  axis: 'x',
  onEnd(s) {
    if (!S.viewer || Math.abs(s.dx) < 60) return;
    const n = curDay()?.items[S.viewer.i]?.files?.length || 0, k = S.viewer.k + (s.dx < 0 ? 1 : -1);
    if (k >= 0 && k < n) openViewer(S.viewer.i, k);
  },
});

$('#fileInput').addEventListener('change', async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try { loadPlan(await readPlanFile(f)); } catch (err) { toast(`파일을 읽지 못했어요: ${err.message}`, 6000); }
});
$('#btnLocate').addEventListener('click', () => {
  if (!S.pos) { toast(S.settings.sim ? '테스트 모드: 지도를 눌러 내 위치를 정하세요' : '내 위치를 확인하는 중이에요'); return; }
  S.follow = true;
  S.map?.panTo(S.pos, 16);
});

// 해외에 도착해 휴대폰 시간대가 바뀌면(예: 한국 → 시드니 +2시간) 일정 시각을 현지 시간으로 다시 계산하고 알람 재예약
let tzOffset = new Date().getTimezoneOffset();
function checkTimeZone() {
  const tz = new Date().getTimezoneOffset();
  if (tz === tzOffset) return;
  tzOffset = tz;
  recompute();
  renderAll(false);
  scheduleAlarms(true);
  toast('시간대가 바뀌어 알람을 현지 시간으로 다시 맞췄어요', 5000);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) { checkTimeZone(); ackWake(); } });

// 1초마다 카운트다운 갱신, 날짜가 바뀌면 그날 일정으로 전환
let ticks = 0;
setInterval(() => {
  const now = Date.now();
  document.querySelectorAll('[data-cd]').forEach(el => {
    const ms = +el.dataset.cd - now;
    el.textContent = fmtCountdown(ms);
    if (el.parentElement.classList.contains('st-big')) el.parentElement.className = `st-big ${urgency(ms)}`;
  });
  document.querySelectorAll('[data-el]').forEach(el => (el.textContent = fmtDur((now - +el.dataset.el) / 60000)));
  if (++ticks % 20 === 0) { renderStatus(); renderMapStatus(); }
  if (ticks % 30 === 0) maybeAdvanceDay();
  // 1분마다 시간이 지난 일정을 회색(완료)으로
  if (ticks % 60 === 0 && !S.sheet) { renderTimeline(); renderCarousel(); renderMap(false); if (topLayer() === 'detail') renderDetail(); }
  checkTimeZone();
  const t = todayStr();
  if (t !== S.lastToday) {
    S.lastToday = t;
    if (S.followToday) selectDay(pickInitialDay(), false);
    else renderAll(false);
  }
}, 1000);

async function init() {
  S.lastToday = todayStr();
  onBackButton(goBack);
  setupWebBack();
  // 화면 층(목록·상세·지도)을 담는 무대는 절대 스크롤되면 안 됨: 브라우저가 밀어 버리면 바로 되돌림 (지도가 검게 비는 문제 방지)
  const stage = $('.stage');
  stage?.addEventListener('scroll', () => { if (stage.scrollLeft || stage.scrollTop) stage.scrollTo(0, 0); });
  Alarms.onFire = showAlarm;
  await Alarms.init();
  S.selected = pickInitialDay();
  recompute();
  renderAll(false);
  scrollToNow();

  S.map = await createMap($('#map'), S.settings.apiKey, msg => toast(msg || '구글맵 API 키를 확인해 주세요', 6000));
  S.map.onClick(ll => {
    if (S.pick && S.sheet?.type === 'edit' && S.pickTarget === 'origin') {
      S.sheet.origin = { place: '지도에서 고른 위치', address: '', lat: ll.lat, lng: ll.lng, from: 'map' };
      S.sheet.oResults = null;
      finishPick();
      return;
    }
    if (S.pick && S.sheet?.type === 'edit') {
      const dr = S.sheet.draft;
      Object.assign(dr, { lat: ll.lat, lng: ll.lng, address: '' });
      if (!dr.place) dr.place = '선택한 위치';
      finishPick();
      return;
    }
    if (!S.settings.sim) return;
    onPos({ ...ll, acc: 15, ts: Date.now() });
    renderStatus();
  });
  S.map.onDrag(() => (S.follow = false));
  renderMap(true);

  // 지난번 위치(3시간 안)를 먼저 써 둠: 새 위치를 받기 전에도 내 주변 찾기 등이 바로 되게.
  // 오래된 위치라 도착 판정에는 쓰지 않음 (stale)
  const last = store.get('tg.pos', null);
  if (last && Date.now() - last.ts < 3 * 3600000 && !S.pos) S.pos = { ...last, saved: true, stale: true };
  Geo.watch(
    p => { if (!S.settings.sim) onPos(p); },
    err => { if (err?.code === 1 || /denied|permission/i.test(err?.message || '')) toast('위치 권한이 꺼져 있어요. 설정에서 위치를 허용해 주세요', 6000); },
  );

  ackWake();
  setInvite(S.settings.invite);
  proxyHooks.onInviteRejected = inviteRejected;
  if (S.plan.days.length) { geocodeMissing(); prefetchLegs(); scheduleAlarms(true); }
  if (isNative) Alarms.requestPermission();
  // 지인 전용 구글 검색: 처음 한 번 초대 코드를 물어봄 (건너뛰면 무료 지도)
  if (PROXY_URL && !S.settings.apiKey && !S.settings.invite && !S.settings.inviteAsked) setTimeout(openInvite, 600);
}

init();
