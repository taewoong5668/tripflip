import { readPlanFile, isHotel, isFlight } from './parser.js?v=202610291839';
import { arrivalGuide } from './guides.js?v=202610291839';
import {
  MODES, computeSchedule, estimateMin, haversine, fmtClock, clockOf, fmtDur, fmtDist, fmtCountdown, todayStr, dayStart, dayLabel,
} from './schedule.js?v=202610291839';
import { createMap } from './map.js?v=202610291839';
import { routeFor, inKorea, searchPlaces, searchPlacesFree, reverseFree, navUrl, placeUrl, nearbyPlaces, nearbyPlacesFree, VIA_PROXY, setInvite, checkInvite, proxyHooks } from './google.js?v=202610291839';
import { PROXY_URL } from './config.js?v=202610291839';
import { isNative, Geo, Alarms, webNotify, beep, openExternal, onBackButton, exitApp, saveOrShare } from './device.js?v=202610291839';
import { saveFile, getFile, putFile, deleteFile, isPdf, renderPdf } from './files.js?v=202610291839';
import { FAV_CATS, catOf, guessCat, findFav, collectVisits, memList, mergeBackup, splitWishes } from './keep.js?v=202610291839';
import { tzOf } from './tz.js?v=202610291839';
import { tripRange, tripStage, fmtRange, fmtNights, monthCells, daysBetween } from './home.js?v=202610291839';
import { findCodes, codeName } from './codes.js?v=202610291839';

const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 저장 공간 부족 */ } },
};
const newId = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const emptyPlan = () => ({ title: '내 여행', days: [] });

const DEFAULTS = { apiKey: '', radius: 50, lead: 10, buffer: 5, sim: false, invite: '', inviteAsked: false, detailList: false };
// 구글 검색·경로에 쓸 키: 내가 넣은 키가 있으면 그것, 없으면 트립플립 중간 서버(초대 코드가 있을 때), 둘 다 없으면 '' (무료 지도)
const boardMode = () => !S.settings.detailList; // 기본: 버블 보드 (순서 중심, 시간·알람·제한 없음)
const gkey = () => S.settings.apiKey || (PROXY_URL && S.settings.invite ? VIA_PROXY : '');
const S = {
  settings: (s => (s.radius === 100 ? { ...s, radius: 50 } : s))({ ...DEFAULTS, ...store.get('tg.settings', {}) }), // 예전 기본값 100m → 50m
  plan: store.get('tg.plan', null) || emptyPlan(),
  progress: store.get('tg.progress', {}), // 날짜 → 장소id → {arr, dep, skip} (ms)
  legCache: store.get('tg.legs', {}),      // 구간별 실제 경로
  geoCache: store.get('tg.geo', {}),
  selected: null, followToday: true, lastToday: null,
  cur: { legs: [], sched: [] },
  pos: null, follow: false, map: null,
  sheet: null,
  pick: false,      // 지도에서 위치 고르는 중
  live: null,       // 내 위치 → 다음 장소 실시간 경로 {id, path, at, from}
  calMonth: null,   // 달력에 보이는 달 {y, m}
  view: 'list',     // 'list' 시간표 / 'map' 지도
  focus: null,      // 지도에서 강조할 장소 번호 (null이면 하루 전체)
  pickReturn: null, // 지도에서 위치 고른 뒤 돌아갈 화면
  dayBack: [],      // 뒤로 가기로 돌아갈 이전 날짜들
  stack: ['list'],  // 쌓인 화면: list(시간표) → detail(상세) → map(지도)
  detail: null,     // 상세 페이지로 보고 있는 장소 번호
  home: null,       // 처음 화면 {step: kind|dates|plan|done, kind, start, end, month}
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
// 그 날의 현지 시간대: 그날 첫 장소 위치로 판단 (서울 일정은 서울 시각, 시드니 일정은 시드니 시각)
const tzCache = new Map();
function dayTz(date) {
  const p = S.plan.days.find(x => x.date === date)?.items.find(hasPos);
  if (!p) return null;
  const k = `${p.lat},${p.lng}`;
  if (!tzCache.has(k)) tzCache.set(k, tzOf(p));
  return tzCache.get(k);
}
// 시간은 언제나 지금 휴대폰 시각 기준 (여행지에 가면 휴대폰이 알아서 현지 시각으로 바뀜).
// 그 날 시간대(dayTz)는 입국 안내·택시비처럼 "어느 나라인지"에만 씀
const dayStartTz = date => dayStart(date);
const atMs = (date, min) => dayStartTz(date) + min * 60000;
// 실제 시각(ms)을 휴대폰 시각 "HH:MM"으로
const clockAt = ms => clockOf(ms);
// 휴대폰 시각으로 지금이 그 날 몇 분째인지
const nowMinOf = date => Math.floor((Date.now() - dayStartTz(date)) / 60000);
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

// 비행기에서 내린 공항인지: 공항 이름 + 바로 앞(같은 날 앞 줄, 또는 전날 마지막 줄)이 비행기
// → 입국심사·짐 찾기 시간(분). 나라(시간대)가 바뀌면 국제선(기본 75분), 아니면 국내선(30분)
const AIRPORT_RE = /공항|airport|국제선|international terminal|terminal\s*\d/i;
function landingOf(d, i) {
  const it = d.items[i];
  if (!it || !AIRPORT_RE.test(it.place)) return 0;
  let prev = d.items[i - 1];
  if (!prev && i === 0) prev = S.plan.days.filter(x => x.date < d.date && x.items.length).at(-1)?.items.at(-1);
  if (!prev || !isFlight(prev.place)) return 0;
  const intl = hasPos(prev) && hasPos(it) && tzOf(prev) !== tzOf(it);
  return intl ? (S.settings.landing || 75) : 30;
}

// 건너뛴 장소를 빼고 바로 앞에 실제로 들르는 장소 (경로는 거기서부터)
function prevStop(d, i) {
  const prog = S.progress[d.date] || {};
  for (let j = i - 1; j >= 0; j--) if (!prog[d.items[j].id]?.skip) return d.items[j];
  return d.items[i - 1];
}

function dayPlan(d) {
  const prog = S.progress[d.date] || {}, base = dayStartTz(d.date);
  const legs = d.items.map((it, i) => (i ? legInfo(prevStop(d, i), it, it.mode) : null));
  const toMin = ts => (ts == null ? null : (ts - base) / 60000);
  const actual = d.items.map(it => ({ arr: toMin(prog[it.id]?.arr), dep: toMin(prog[it.id]?.dep), hold: toMin(prog[it.id]?.hold) }));
  const items = d.items.map((it, i) => {
    const l = landingOf(d, i), sk = !!prog[it.id]?.skip;
    return l || sk ? { ...it, ...(l ? { landing: l } : {}), ...(sk ? { skipped: true } : {}) } : it;
  });
  return { legs, sched: computeSchedule(items, legs, actual, S.settings.buffer) };
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
// ---------- 예약 중심: 시간이 정해진 일정만 시각, 나머지는 순서만 ----------
// 예약·공연·식당·조식처럼 시간을 적어 둔 일정 (첫 장소의 출발 시간은 "대략"이라 제외, 비행기 착륙은 포함)
const isFixedItem = (d, i) => d.items[i]?.time != null && (i > 0 || !!landingOf(d, i));
// from번부터 찾은 첫 예약 (건너뛴 곳 제외)
function nextFixedIdx(d, from) {
  const prog = S.progress[d.date] || {};
  for (let j = Math.max(0, from); j < d.items.length; j++) if (!prog[d.items[j].id]?.skip && isFixedItem(d, j)) return j;
  return -1;
}
// 예약 j에 맞추려면 늦어도 출발해야 하는 시각 (바로 앞 장소의 출발: 시간표가 예약에 맞춰 거꾸로 계산)
function latestDepMs(d, j) {
  const pi = d.items.indexOf(prevStop(d, j));
  return atMs(d.date, schedOf(d)[pi]?.depart ?? schedOf(d)[j].arrive);
}

function isPast(d, i) {
  const t = todayStr();
  if (d.date < t) return true;
  if (d.date > t) return false;
  if (isFixedItem(d, i) || i === 0) return Date.now() > endMs(d, i);
  // 자유 일정은 시간으로 끝났다고 보지 않음: 뒤에 있는 예약이 이미 시작됐을 때만 지난 것으로
  for (let j = i + 1; j < d.items.length; j++) if (isFixedItem(d, j)) return Date.now() > atMs(d.date, schedOf(d)[j].arrive ?? 0);
  return false;
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
    if (p.arr || p.dep || p.skip || p.pass) last = i;
  });
  if (here >= 0) return { type: 'stay', i: here };
  if (last < 0) return { type: 'before', i: 0 };
  if (last >= d.items.length - 1) return { type: 'done' };
  return { type: 'move', i: last + 1 };
}

// 도착·출발 기록이 없을 때: 시간이 정해진 일정(예약·착륙)만 시각으로 판단하고,
// 자유 일정은 "지금 여기 있겠지"라고 추측하지 않음 → { type: 'flex', i: 다음 들를 곳, until: 다음 예약 }
function phaseByTime(d) {
  const sched = schedOf(d), now = Date.now(), n = d.items.length;
  if (!sched[0] || now < atMs(d.date, sched[0].depart) && !landingOf(d, 0)) return { type: 'before', i: 0 };
  let open = 1; // 아직 안 지난 첫 자유 일정
  for (let k = 0; k < n; k++) {
    if (!isFixedItem(d, k)) continue;
    const arr = atMs(d.date, sched[k].arrive ?? sched[k].depart);
    if (now < arr) { if (k === 0) return { type: 'before', i: 0 }; break; } // 아직 안 온 예약 → 그 전 자유 시간 (착륙 전이면 출발 전)
    if (now < endMs(d, k)) return { type: 'stay', i: k, timed: true }; // 예약 시간 중
    open = k + 1;                                                 // 지난 예약 뒤부터
  }
  if (n === 1 || open >= n) return { type: 'done' };
  return { type: 'flex', i: Math.max(1, open), until: nextFixedIdx(d, open) };
}

function itemState(d, i, ph) {
  const p = (S.progress[d.date] || {})[d.items[i].id] || {};
  if (ph?.type === 'move' && ph.i === i) return 'next';
  if (ph?.type === 'stay' && ph.i === i) return 'here';
  if (ph?.type === 'before' && i === 0) return 'here';
  if (ph?.type === 'flex' && ph.i === i) return 'next';
  if (p.skip) return 'skip';
  if (p.dep || p.pass) return 'done';
  if (p.arr) return 'here';
  // 지금 가는 곳·머무는 곳보다 앞 장소는 도착 기록이 없어도 지나온 곳 (앱을 다시 깔거나 감지를 못 했어도 되살아나지 않게)
  if (ph && ph.type !== 'before' && ph.i != null && i < ph.i) return 'done';
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
  // 일정이 있는 날 + 처음 화면에서 정한 여행 기간의 모든 날 (아직 일정이 없어도 탭으로 보이게)
  const tr = S.plan.trip, span = [];
  if (tr?.start) for (let x = tr.start, k = 0; x <= tr.end && k < 60; x = addDays(x, 1), k++) span.push(x);
  const dates = [...new Set([...S.plan.days.map(d => d.date), ...span, S.selected])].filter(Boolean).sort();
  $('#dayTabs').innerHTML = dates.map(date =>
    `<button class="tab ${date === S.selected ? 'on' : ''} ${date < t ? 'past' : ''}" data-date="${date}">${date === t ? '<span class="today-dot"></span>' : ''}${dayLabel(date)}</button>`).join('');
  $('#dayTabs').hidden = dates.length < 2;
  // 버블을 끄는 중엔 그대로 둠: 고른 날을 가운데로 밀면 손가락 밑 날짜가 바뀌어 다음 날, 그다음 날로 계속 넘어감
  if (!S.bd) $('#dayTabs .tab.on')?.scrollIntoView({ inline: 'center', block: 'nearest' });
}

const urgency = ms => (ms < 0 ? 'danger' : ms < S.settings.lead * 60000 ? 'warn' : '');

// 길찾기는 지도 앱에서 (내 위치 → 목적지, 경로는 거기서 고르기)
const legButtons = i => `<button data-act="nav" data-i="${i}" class="primary">🗺️ 길찾기</button>`;

// 남은 거리·시간 (실시간 경로를 받았으면 그 값, 아니면 직선거리로 추정)
function liveEta(it) {
  const useLive = S.live?.id === it.id;
  const dist = useLive && S.live.dist != null ? S.live.dist : haversine(S.pos, it);
  const est = useLive && S.live.dur != null ? S.live.dur : estimateMin(dist, it.mode);
  return { dist, est, eta: Date.now() + est * 60000 };
}

// ---------- 이동 중: 진행 막대 · 작은 지도 · 대중교통 단계 ----------
// 이전 장소에서 출발한 시각(실제 기록이 있으면 그것)과 지금까지 지난 분
function moveTimes(d, i) {
  const prev = prevStop(d, i), p = progOf(d.date)[prev.id] || {}, pi = d.items.indexOf(prev);
  const dep = p.dep ?? atMs(d.date, S.cur.sched[pi].depart);
  return { dep, elapsed: Math.max(0, (Date.now() - dep) / 60000) };
}

function moveVisual(d, i, step = liveStep(d, i)) {
  const prev = prevStop(d, i), it = d.items[i];
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
  return bar + miniMapSvg(d, i) + transitSteps(leg, it, step);
}

// 지도 화면에 가지 않아도 보이는 작은 동선 그림: 이전 장소(■) → 내 위치(●) → 다음 장소(◎)
function miniMapSvg(d, i) {
  const prev = prevStop(d, i), it = d.items[i], leg = S.cur.legs[i] || {};
  const planned = [prev, it];
  const live = S.live?.id === it.id && S.pos ? [S.pos, it] : null;
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

// 대중교통: 🚶 3분 › 🚇 T8 3정거장 › 🚶 6분, 지금 단계 강조 (지금 단계는 liveStep이 GPS 또는 시간으로 판단)
function transitSteps(leg, it, step) {
  if (it.mode !== 'TRANSIT' || !leg.segs?.length) return '';
  const cur = step?.idx ?? 0;
  const chip = (s, j) => {
    const txt = s.type === 'TRANSIT'
      ? `${s.icon} ${esc(s.line || '')}${s.stops ? ` ${s.stops}정거장` : ''}`
      : `${s.type === 'WALK' ? '🚶' : '🚗'} ${fmtDur(s.dur)}`;
    return `<span class="ts-step ${j < cur ? 'done' : j === cur ? 'now' : ''}">${txt}</span>`;
  };
  return `<div class="transit-steps">${leg.segs.map(chip).join('<span class="ts-arrow">›</span>')}</div>`;
}

// 지금 이동의 어느 단계인지 + "지금 할 일" 한 문장
// GPS가 되면 내릴 역까지 거리로, 안 되면 출발 뒤 지난 시간으로 판단. 내릴 역이 가까워지면 진동·알림 한 번
const stepState = {};
function liveStep(d, i) {
  const it = d.items[i], leg = S.cur.legs[i] || {}, segs = leg.segs || [];
  const gps = S.pos && !S.pos.stale && Date.now() - S.pos.ts < 120000 ? S.pos : null;
  if (!segs.length || it.mode !== 'TRANSIT') {
    const m = MODES[it.mode];
    return { idx: 0, text: `${m.icon} <b>${esc(it.place)}</b>까지 ${gps && hasPos(it) ? fmtDist(haversine(gps, it)) : fmtDur(leg.dur)}` };
  }
  const st = (stepState[it.id] ||= { done: -1, alerted: {} });
  let idx;
  if (gps) {
    // 이미 지나간 단계 표시: 걷기 → 다음 정류장 근처(200m)에 오면 끝, 타는 중 → 내릴 역 근처(250m)면 끝
    for (let j = st.done + 1; j < segs.length; j++) {
      const sg = segs[j], nx = segs[j + 1];
      if (sg.type === 'TRANSIT' && sg.toLoc && haversine(gps, sg.toLoc) < 250) { st.done = j; continue; }
      if (sg.type !== 'TRANSIT' && nx?.type === 'TRANSIT' && nx.fromLoc) {
        const dFrom = haversine(gps, nx.fromLoc), span = nx.toLoc ? haversine(nx.fromLoc, nx.toLoc) : 0;
        const onBoard = span && dFrom > 300 && haversine(gps, nx.toLoc) < span * 0.9; // 앱을 늦게 켰는데 이미 타고 있는 경우
        if (dFrom < 200 || onBoard) { st.done = j; continue; }
      }
      break;
    }
    idx = Math.min(st.done + 1, segs.length - 1);
  } else {
    const { elapsed } = moveTimes(d, i);
    let acc = 0; idx = segs.length - 1;
    for (let j = 0; j < segs.length; j++) { acc += segs[j].dur || 0; if (elapsed < acc) { idx = j; break; } }
  }
  const sg = segs[idx], nx = segs[idx + 1];
  let text;
  if (sg.type === 'TRANSIT') {
    let left = sg.stops || 0;
    if (gps && sg.fromLoc && sg.toLoc) {
      const span = haversine(sg.fromLoc, sg.toLoc) || 1, rest = haversine(gps, sg.toLoc);
      left = Math.max(0, Math.min(sg.stops || 0, Math.round((sg.stops || 0) * rest / span)));
      // 내릴 역이 가까워짐 → 한 번만 진동 + 알림
      if ((left <= 1 || rest < 1500) && !st.alerted[idx]) {
        st.alerted[idx] = true;
        toast(`🚉 곧 ${sg.to}에서 내리세요`, 8000); // 소리·휴대폰 알림 없이 화면에만
      }
    }
    text = `${sg.icon} ${esc(sg.line || '')}${sg.headsign ? ` <span class="muted-in">${esc(sg.headsign)} 방면</span>` : ''} · <b>${esc(sg.to)}</b>에서 내리세요${left ? ` · ${left}정거장 남음` : ' · 이번 역!'}`;
  } else if (nx?.type === 'TRANSIT') {
    text = `🚶 <b>${esc(nx.from)}</b>까지 걸어가서 ${nx.icon} ${esc(nx.line || '')} 타기 · 약 ${fmtDur(sg.dur)}`;
  } else {
    text = `🚶 <b>${esc(it.place)}</b>까지 걸어가세요 · 약 ${fmtDur(sg.dur)}`;
  }
  return { idx, text };
}

// 다음 이동을 한 줄로: "🚇 T8 → Town Hall 하차 → 🚶 6분 · 약 40분" (저장된 경로라 인터넷 없이도 보임)
function legSummary(d, j) {
  const it = d.items[j], leg = S.cur.legs[j];
  if (!it || !leg?.segs?.length || it.mode !== 'TRANSIT') return '';
  const parts = leg.segs.map(s => s.type === 'TRANSIT'
    ? `${s.icon} ${esc(s.line || '')} <b>${esc(s.from)}</b> 승차 → <b>${esc(s.to)}</b> 하차${s.stops ? ` (${s.stops}정거장)` : ''}`
    : `🚶 ${fmtDur(s.dur)}`);
  return `<div class="leg-sum"><div class="ls-head">${esc(it.place)}까지 · 약 ${fmtDur(leg.dur)}${leg.fare ? ` · ${leg.fare}` : ''}</div><ol>${parts.map(p => `<li>${p}</li>`).join('')}</ol></div>`;
}

// 대중교통 가능한 노선 모두: "① 🚌 333 (North Bondi 방면) · 🚏 Elizabeth St → 🚏 Campbell Pde · 14정거장"
function rideOptionsHtml(l, date) {
  const opts = l?.alts?.length ? l.alts : l?.segs?.length ? [{ dur: l.dur, rides: ridesOf(l.segs) }] : [];
  if (!opts.length || !opts[0].rides.length) {
    return `<div class="muted small">${gkey() ? '노선 정보를 아직 못 받았어요. 인터넷이 되면 자동으로 받아요.' : '버스·지하철 노선 정보는 ⚙️ 설정에서 초대 코드를 넣으면 보여요.'}</div>`;
  }
  const lineName = r => `${r.icon} <b>${esc(r.line || '노선')}</b>`;
  // 같은 노선·같은 정류장이면 하나로 묶고 출발 시각만 모음 ("11:58 · 12:04 · 12:10 출발")
  const groups = new Map();
  for (const o of opts) {
    const k = o.rides.map(r => `${r.line}|${r.from}|${r.to}`).join('>');
    const g = groups.get(k) || { ...o, times: [] };
    if (o.dur < g.dur) g.dur = o.dur;
    if (o.rides[0]?.dep) g.times.push(o.rides[0].dep);
    groups.set(k, g);
  }
  const list = [...groups.values()];
  const all = list.map(o => o.rides.map(r => `${r.icon} ${r.line || ''}`).join(' + '));
  return `<div class="ride-all">가능한 노선: ${all.map(x => `<span class="ride-chip">${esc(x)}</span>`).join('')}</div>
    <ol class="ride-opts">${list.map(o => `<li>
      <div class="ro-head">약 ${fmtDur(o.dur)}${o.walk ? ` · 걷기 ${fmtDur(o.walk)}` : ''}${o.rides.length > 1 ? ` · 환승 ${o.rides.length - 1}번` : ''}${o.times.length ? ` · <span class="ro-time">${[...new Set(o.times.sort())].slice(0, 4).map(t => clockAt(Date.parse(t), date)).join(' · ')} 출발</span>` : ''}</div>
      ${o.rides.map(r => `<div class="ro-ride">${lineName(r)}${r.headsign ? ` <span class="muted small">${esc(r.headsign)} 방면</span>` : ''}
        <div class="ro-stops">🚏 ${esc(r.from)} <b>승차</b> → 🚏 ${esc(r.to)} <b>하차</b>${r.stops ? ` · ${r.stops}정거장` : ''}</div></div>`).join('')}
    </li>`).join('')}</ol>`;
}

// 공항 입국 절차 (펼치면 단계별)
function landingGuide(d, i) {
  const g = arrivalGuide(dayTz(d.date));
  return `<details class="guide-steps"><summary>📋 입국 절차 ${g.steps.length}단계 보기${g.specific ? '' : ' (공통)'}</summary><ol>${g.steps.map(s => `<li><b>${s.icon} ${esc(s.title)}</b><span>${esc(s.text)}</span></li>`).join('')}</ol>
    <div class="muted-in small">규정은 바뀔 수 있어요. 공항 안내 표지를 먼저 따르세요.</div></details>`;
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
  if (boardMode() || !d || !d.items.length) { el.innerHTML = ''; el.hidden = true; return; }
  el.hidden = false;
  if (S.cur.sched.length !== d.items.length) recompute(); // 일정이 바뀐 직후면 다시 계산
  const { sched } = S.cur, items = d.items, now = Date.now();
  el.classList.toggle('calm', !isLive());

  if (!isLive()) {
    const t = todayStr(), last = sched[items.length - 1];
    const firstDep = atMs(d.date, sched[0].depart);
    const when = d.date < t ? '지난 일정 · 모두 완료' : d.date === addDays(t, 1) ? '내일 일정' : '예정된 일정';
    setStatusHtml(el, `${quickNear()}<div class="st-label">${when}</div>
      <div class="st-title">${esc(d.title || `장소 ${items.length}곳`)}</div>
      <div class="st-row">${fmtClock(sched[0].depart)} 출발 → ${fmtClock(last.arrive ?? last.depart)} 마침 · ${items.length}곳</div>
      ${d.date > t ? `<div class="st-big"><small>첫 출발까지</small><span data-cd="${firstDep}">${fmtCountdown(firstDep - now)}</span></div>` : ''}
      ${d.date >= t ? `<div class="st-actions">${wakeButton(d)}<button data-act="toggleView">하루 동선 지도</button></div>` : ''}`);
    return;
  }

  const ph = phase(d);
  const rest = resting(d), stuck = !rest && stuckInfo(d, ph);
  // 카드 구성은 어느 단계든 같게: 위 한 줄 · 장소 · 큰 숫자 · "지금 할 일" 한 줄 · (펼치면) 자세히 · 버튼
  const big = (label, ms) => `<div class="st-big ${urgency(ms - now)}"><small>${label}</small><span data-cd="${ms}">${fmtCountdown(ms - now)}</span></div>`;
  const todo = t => `<div class="st-do">${t}</div>`;
  const more = h => (h ? `<div class="st-more">${h}</div>` : '');
  const offline = navigator.onLine === false ? '<span class="st-off">📴 오프라인 · 저장된 안내</span>' : '';
  let html;
  if (rest) {
    // 😴 쉬는 중: 출발 알람·안내를 멈춤 (예약 일정 알람은 그대로)
    html = `<div class="st-label" data-nofold>😴 쉬는 중</div>
      ${rest.day ? '<div class="st-title">오늘은 쉬는 날이에요</div>' : big('쉬기 끝까지', rest.until)}
      ${todo(rest.day ? '다시 움직일 때 [이제 출발]을 눌러 주세요' : `${clockAt(rest.until)}까지 쉬어요. 다시 움직일 때 [이제 출발]을 눌러 주세요`)}
      <div class="st-actions"><button class="primary" data-act="restEnd">⏩ 이제 출발</button>${rest.day ? '' : '<button data-act="rest" data-m="30">+30분 더</button>'}</div>`;
  } else if (stuck) {
    // 🛏️ 위치로 보면 아직 그대로인데 시간표는 지나감 → 한 번 눌러서 고르기
    const at = d.items[stuck.at], nx = d.items[stuck.next];
    html = `<div class="st-label" data-nofold>📍 아직 ${esc(at.place)}에 계시네요</div>
      <div class="st-big bad-big"><small>${esc(d.items[stuck.fixed].place)} ${fmtClock(d.items[stuck.fixed].time)} 예약 · 출발 시간이</small>${stuck.behind < 1 ? '지금' : `${fmtDur(stuck.behind)} 지남`}</div>
      ${todo(`다음: <b>${esc(nx.place)}</b>${nx.time != null ? ` (${fmtClock(nx.time)} 예약)` : ''}${stuck.missed ? ` · 그 전 ${stuck.missed}곳은 건너뛰어요` : ''}`)}
      <div class="st-actions"><button class="primary" data-act="replan" data-m="0">⏩ 지금 출발로 다시 맞추기</button><button data-act="replan" data-m="15">15분 뒤</button><button data-act="replan" data-m="30">30분 뒤</button></div>
      <div class="st-actions"><button data-act="skipNext" data-i="${stuck.next}">⏭ ${esc(nx.place)} 건너뛰기</button></div>
      <div class="st-actions rest-row"><span>😴 더 쉬기</span><button data-act="rest" data-m="30">30분</button><button data-act="rest" data-m="60">1시간</button><button data-act="rest" data-m="day">오늘은 쉬기</button></div>`;
  } else if (ph.type === 'done') {
    el.classList.add('calm');
    const next = S.plan.days.find(x => x.date > d.date && x.items.length);
    html = `<div class="st-label">오늘 일정</div><div class="st-title">🎉 오늘 일정을 모두 마쳤어요</div>
      ${next ? `<div class="st-actions"><button class="primary" data-act="goDay" data-date="${next.date}">${dayLabel(next.date)} 일정 보기</button></div>` : ''}`;
  } else if (ph.type === 'move') {
    const i = ph.i, it = items[i], s = sched[i], m = MODES[it.mode];
    const arrMs = atMs(d.date, s.arrive), step = liveStep(d, i), fixed = isFixedItem(d, i);
    // 예약 장소로 가는 중이면 예약 시각 기준, 자유 일정이면 시각 없이 순서만 (다음 예약이 있으면 그 기준)
    const jf = fixed ? i : nextFixedIdx(d, i + 1), dl = !fixed && jf >= 0 ? latestDepMs(d, jf) : null;
    let num = fixed ? big('예약까지', arrMs) : dl ? big(`${esc(items[jf].place)} 예약 전 출발까지`, dl) : '';
    let sub = fixed ? `🕒 ${fmtClock(it.time)} 예약` : '순서대로 · 도착하면 자동으로 다음으로 넘어가요';
    if (S.pos && !S.pos.stale && hasPos(it)) {
      const { dist, est, eta } = liveEta(it);
      const diff = Math.round((eta - arrMs) / 60000);
      num = `<div class="st-big"><small>남은 거리</small>${fmtDist(dist)}</div>`;
      sub = `약 ${fmtDur(est)} · ${clockAt(eta, d.date)} 도착 예상${fixed ? ` · ${diff > 2 ? `<b class="bad">예약 ${diff}분 늦음</b>` : diff < -2 ? `${-diff}분 여유` : '제시간'}` : ''}`;
    }
    html = `${askHtml(d, ph)}<div class="st-label">이동 중 → ${labelOf(d, i)}번 · ${m.icon} ${m.label} ${offline}</div>
      <div class="st-title">${esc(it.place)}</div>${num}${todo(step.text)}
      ${more(`<div class="st-row small">${sub}</div>${moveVisual(d, i, step)}`)}
      <div class="st-actions"><button class="primary" data-act="nav" data-i="${i}">🗺️ 길찾기</button><button data-act="openMap" data-i="${i}">지도</button><button data-act="arrive" data-i="${i}">도착 처리</button></div>`;
  } else if (ph.type === 'flex') {
    // 🗺️ 자유 일정 중 (기록이 없어서 지금 어디인지는 모름): 다음 들를 곳 + 다음 예약까지 남은 시간
    const i = ph.i, it = items[i], j = ph.until, lg = S.cur.legs[i] || {}, m = MODES[it.mode];
    const cnt = (j >= 0 ? j : items.length) - i;
    html = `${askHtml(d, ph)}<div class="st-label">🗺️ 자유 일정 · ${j >= 0 ? `${esc(items[j].place)} ${fmtClock(items[j].time)} 예약 전까지` : '순서대로'} ${offline}</div>
      <div class="st-title">${esc(it.place)}</div>
      ${j >= 0 ? big('늦어도 출발까지', latestDepMs(d, j)) : ''}
      ${todo(`다음 들를 곳${cnt > 1 ? ` (남은 ${cnt}곳)` : ''} · ${m.icon} ${fmtDur(lg.dur)} · 도착하면 자동으로 다음으로 넘어가요`)}
      <div class="st-actions"><button class="primary" data-act="nav" data-i="${i}">🗺️ 길찾기</button><button data-act="arrive" data-i="${i}">도착 처리</button><button data-act="skipNext" data-i="${i}">⏭ 건너뛰기</button></div>`;
  } else {
    // 출발 전(첫 장소) · 머무는 중: 다음 장소로 떠날 때까지
    const i = ph.type === 'before' ? 0 : ph.i, it = items[i], s = sched[i], next = items[i + 1];
    const dep = atMs(d.date, s.depart);
    const lead = ph.type === 'before' ? `일정 시작 전 · ${esc(it.place)}` : `지금 여기 · ${labelOf(d, i)}번`;
    if (!next) {
      html = `<div class="st-label">${lead}</div><div class="st-title">${esc(it.place)}</div><div class="st-row">마지막 장소예요. 오늘 일정 끝!</div>`;
    } else if (s.proc && ph.type === 'stay' && now < atMs(d.date, s.arrive + s.proc)) {
      // ✈️ 비행기에서 내린 공항: 입국 절차 안내 (앱 안에 있어서 인터넷 없이도 보임)
      html = `<div class="st-label">✈️ 도착 · 입국 절차 중 ${offline}</div>
        <div class="st-title">${esc(it.place)}</div>${big('출발 예정까지', dep)}
        ${todo(`🛂 입국심사 → 🧳 짐 찾기 → 🛃 세관 · 약 ${fmtDur(s.proc)}`)}
        ${more(`${legSummary(d, i + 1)}${altsHtml(d, i + 1)}${landingGuide(d, i)}`)}
        <div class="st-actions"><button class="primary" data-act="depart" data-i="${i}">🚪 나왔어요</button>${legButtons(i + 1).replace('class="primary"', '')}</div>`;
    } else {
      const lg = S.cur.legs[i + 1] || {}, nm = MODES[next.mode];
      // 출발 시각이 의미 있는 건 예약에 맞춰야 할 때뿐: 바로 다음이 예약이거나 지금이 예약 장소면 정확히, 아니면 다음 예약 기준
      const jf = nextFixedIdx(d, i + 1), direct = jf >= 0 && d.items.indexOf(prevStop(d, jf)) === i;
      const exact = isFixedItem(d, i) || direct, dl = jf >= 0 ? latestDepMs(d, jf) : null;
      const num = exact ? big('출발까지', dep) : dl ? big(`${esc(items[jf].place)} 예약 전 출발까지`, dl) : '';
      const what = exact
        ? `${fmtClock(s.depart)}에 출발 → ${esc(next.place)} · ${nm.icon} ${fmtDur(lg.dur)}${lg.est ? '(추정)' : ''}`
        : `다음: <b>${esc(next.place)}</b> · ${nm.icon} ${fmtDur(lg.dur)} · ${dl ? `늦어도 ${clockAt(dl, d.date)} 출발` : '순서대로 자유롭게'}`;
      html = `<div class="st-label">${lead} ${offline}</div>
        <div class="st-title">${esc(ph.type === 'before' ? next.place : it.place)}</div>${num}
        ${todo(what)}
        ${more(`${legSummary(d, i + 1)}${altsHtml(d, i + 1)}`)}
        <div class="st-actions">${legButtons(i + 1)}<button data-act="depart" data-i="${i}">출발 처리</button>${ph.type === 'before' ? wakeButton(d) : ''}${S.undo?.date === d.date && now - S.undo.at < 10 * 60000 ? '<button data-act="undoReplan">↩ 되돌리기</button>' : ''}</div>`;
    }
  }
  setStatusHtml(el, quickNear() + html);
}

// ---------- 길게 눌러 끌어서 순서 바꾸기 · 위 날짜 탭에 놓으면 그 날로 옮기기 ----------
function setupRowDrag() {
  const tl = $('#timeline');
  let press = null; // { i, row, x, y, timer }
  const cancelPress = () => { if (press) clearTimeout(press.timer); press = null; };
  const tabAt = (x, y) => document.elementsFromPoint(x, y).find(e => e.matches?.('#dayTabs [data-date], #dayTabs .tab'));
  const clearMarks = () => document.querySelectorAll('.row.drop-before, .row.drop-after, #dayTabs .drop-tab').forEach(e => e.classList.remove('drop-before', 'drop-after', 'drop-tab'));
  // 들려 있을 때만 화면 아래에 나오는 휴지통: 여기에 놓으면 삭제
  const trash = document.createElement('div');
  trash.id = 'dragTrash'; trash.innerHTML = '<span class="dt-icon">🗑</span><span>여기에 놓으면 삭제</span>';
  document.body.append(trash);
  const overTrash = (x, y) => { const b = trash.getBoundingClientRect(); return x >= b.left - 20 && x <= b.right + 20 && y >= b.top - 20; };

  const startDrag = p => {
    closePeek();
    S.drag = { i: p.i, row: p.row, y0: p.y, target: p.i, tab: null, id: p.id };
    p.row.classList.add('dragging');
    trash.classList.add('show');
    navigator.vibrate?.(30);
    toast('끌어서 순서 바꾸기 · 위 날짜에 놓으면 그 날로 · 아래 🗑에 놓으면 삭제', 2500);
  };
  tl.addEventListener('pointerdown', e => {
    const row = e.target.closest('.row[data-i]');
    if (!row || e.target.closest('button') || S.drag) return;
    const i = +row.dataset.i;
    press = { i, row, x: e.clientX, y: e.clientY, id: e.pointerId, timer: setTimeout(() => {
      // 0.45초 길게 누르면 간략 정보 창. 손가락을 떼지 않고 움직이면 끌기로
      press.peek = true;
      try { row.setPointerCapture(e.pointerId); } catch { /* 일부 브라우저 */ }
      openPeek(i, row);
    }, 450) };
  });
  tl.addEventListener('pointermove', e => {
    if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) {
      if (press.peek) { const p = press; press = null; startDrag(p); }
      else cancelPress(); // 그냥 스크롤
    }
    const g = S.drag;
    if (!g) return;
    g.row.style.transform = `translateY(${e.clientY - g.y0}px)`;
    clearMarks();
    g.trash = overTrash(e.clientX, e.clientY);
    trash.classList.toggle('hot', g.trash);
    if (g.trash) { g.tab = null; return; }
    const tab = tabAt(e.clientX, e.clientY);
    g.tab = tab?.dataset.date && tab.dataset.date !== S.selected ? tab.dataset.date : null;
    if (g.tab) { tab.classList.add('drop-tab'); return; }
    // 손가락 위치로 들어갈 자리 찾기
    const rows = [...tl.querySelectorAll('.row[data-i]')].filter(r => r !== g.row);
    let t = rows.length;
    for (let k = 0; k < rows.length; k++) { const b = rows[k].getBoundingClientRect(); if (e.clientY < b.top + b.height / 2) { t = k; break; } }
    g.target = t;
    if (rows[t]) rows[t].classList.add('drop-before'); else rows.at(-1)?.classList.add('drop-after');
  });
  const end = () => {
    if (press?.peek) { // 길게 눌렀다 뗌: 창은 그대로 두고(읽을 수 있게), 다음 톡으로 닫기/자세히
      S.dragJustEnded = Date.now();
      S.peek?.el.classList.add('ready');
    }
    cancelPress();
    const g = S.drag;
    if (!g) return;
    S.drag = null;
    g.row.classList.remove('dragging'); g.row.style.transform = '';
    trash.classList.remove('show', 'hot');
    clearMarks();
    S.dragJustEnded = Date.now(); // 끌고 놓은 직후의 "누르기"로 상세가 열리지 않게
    const d = curDay(), it = d.items[g.i];
    if (g.trash) { trashItem(d, g.i); return; }
    if (g.tab) { moveItemToDay(d.date, it.id, g.tab); return; }
    if (g.target === g.i) return;
    const items = d.items.filter((_, k) => k !== g.i);
    items.splice(g.target, 0, it);
    const imp = confirmChange(d, items);
    if (!imp) { renderTimeline(); return; }
    d.items = items;
    savePlan(); recompute(); renderAll(false); prefetchLegs(); scheduleAlarms();
    changeToast(imp, `${it.place} 순서를 ${g.target + 1}번째로 바꿨어요`);
  };
  tl.addEventListener('pointerup', end);
  tl.addEventListener('pointercancel', end);
  // 끄는 중엔 화면 스크롤 막기
  tl.addEventListener('touchmove', e => { if ((S.drag || press?.peek) && e.cancelable) e.preventDefault(); }, { passive: false });
  tl.addEventListener('contextmenu', e => { if (S.drag || press) e.preventDefault(); });
}

// ==================== ⭐ 즐겨찾기 · 📸 추억 ====================
S.favs = store.get('tg.favs', []);   // [{ id, place, address, lat, lng, cat, added }]
S.mems = store.get('tg.mems', {});   // "날짜|장소" → { place, lat, lng, date, arr, dep, note, heart, photos[] } (일정과 따로 보관)
const saveFavs = () => store.set('tg.favs', S.favs);
const saveMems = () => store.set('tg.mems', S.mems);

// 진행 기록에서 다녀온 곳을 추억으로 옮겨 담음 (도착할 때마다, 앱 켤 때)
function syncMemories() {
  const before = JSON.stringify(S.mems);
  S.mems = collectVisits(S.plan, S.progress, S.mems).mems;
  if (JSON.stringify(S.mems) !== before) saveMems();
}

// 오늘 일정이 있는 곳(없으면 내 위치) 기준으로 가까운 순
function areaCenter() {
  const it = curDay()?.items.find(hasPos);
  return it || (S.pos ? { lat: S.pos.lat, lng: S.pos.lng } : null);
}

function toggleFav(p, hint = '') {
  const place = p.place || p.name, ex = findFav(S.favs, { ...p, place });
  if (ex) {
    S.favs = S.favs.filter(f => f !== ex); saveFavs();
    toast(`🫧 ${ex.place} 버블을 뺐어요`, 5000, { label: '되돌리기', fn: () => { S.favs.push(ex); saveFavs(); rerenderKeep(); } });
  } else {
    if (!hasPos(p)) { toast('위치를 모르는 곳은 버블로 만들 수 없어요'); return; }
    const f = { id: newId(), place, address: p.address || '', lat: p.lat, lng: p.lng, cat: guessCat(place, hint), added: Date.now() };
    S.favs.push(f); saveFavs();
    const c = catOf(f.cat);
    toast(`🫧 ${place} 버블을 만들었어요 · ${c.icon} ${c.label}`);
  }
  rerenderKeep();
}
// 즐겨찾기를 바꾼 뒤 보이는 화면(시트·상세·서랍)을 다시 그림
function rerenderKeep() {
  if (S.sheet) renderSheet();
  if (topLayer() === 'detail') renderDetail();
  if (S.tray) renderTray();
}
const isFav = p => !!findFav(S.favs, { ...p, place: p.place || p.name });
const favStar = p => (isFav(p) ? '🫧✓' : '🫧＋'); // 버블로 만들었는지 (작은 버튼용)

function keepHtml(sh) {
  const mems = memList(S.mems);
  const tabs = `<div class="seg"><button class="${sh.tab === 'fav' ? 'on' : ''}" data-act="keepTab" data-tab="fav">🫧 버블 ${S.favs.length || ''}</button><button class="${sh.tab === 'mem' ? 'on' : ''}" data-act="keepTab" data-tab="mem">📸 추억 ${mems.length || ''}</button></div>`;
  return `<div class="sheet-head"><div><div class="st-label">보관함</div><b>${sh.tab === 'fav' ? '🫧 내 버블' : '📸 다녀온 곳'}</b></div><button class="x" data-act="closeSheet">✕</button></div>
    ${tabs}${sh.tab === 'fav' ? favBody(sh) : memBody(mems)}`;
}

function favBody(sh) {
  const c0 = areaCenter();
  const counts = {};
  S.favs.forEach(f => (counts[f.cat] = (counts[f.cat] || 0) + 1));
  const cats = `<div class="chips fav-cats"><button class="chip-btn ${sh.cat === 'all' ? 'on' : ''}" data-act="favCat" data-cat="all">전체 ${S.favs.length}</button>${FAV_CATS.filter(c => counts[c.id]).map(c =>
    `<button class="chip-btn ${sh.cat === c.id ? 'on' : ''}" data-act="favCat" data-cat="${c.id}">${c.icon} ${c.label} ${counts[c.id]}</button>`).join('')}</div>`;
  const list = S.favs.filter(f => sh.cat === 'all' || f.cat === sh.cat)
    .map(f => ({ f, d: c0 && hasPos(f) ? haversine(c0, f) : null })).sort((a, b) => (a.d ?? 1e12) - (b.d ?? 1e12));
  const card = ({ f, d }) => {
    const c = catOf(f.cat), open = sh.open === f.id;
    return `<div class="fav-bub ${open ? 'open' : ''}">
      <button class="bub cat-${f.cat}" data-act="favOpen" data-id="${f.id}"><span class="bub-ic">${c.icon}</span><b>${esc(f.place)}</b>${d != null ? `<small>${fmtDist(d)}</small>` : ''}</button>
      ${open ? `<div class="fav-acts">${f.address ? `<div class="muted small">📍 ${esc(f.address)}</div>` : ''}
        ${sh.catEdit === f.id ? `<div class="chips">${FAV_CATS.map(x => `<button class="chip-btn ${x.id === f.cat ? 'on' : ''}" data-act="favSetCat" data-id="${f.id}" data-cat="${x.id}">${x.icon} ${x.label}</button>`).join('')}</div>` : ''}
        <div class="chips"><button class="chip-btn on" data-act="favAdd" data-id="${f.id}">＋ 일정에 넣기</button>${hasPos(f) ? `<button class="chip-btn" data-act="favMap" data-id="${f.id}">🗺️ 지도</button>` : ''}<button class="chip-btn" data-act="favCatEdit" data-id="${f.id}">🏷 ${c.label}</button><button class="chip-btn" data-act="favDel" data-id="${f.id}" aria-label="버블 빼기">🗑</button></div>
      </div>` : ''}
    </div>`;
  };
  // 가까운 곳(50km 안)과 다른 도시를 나눠서
  const isHere = x => x.d != null && x.d < 50000;
  const here = list.filter(isHere), far = list.filter(x => !isHere(x) && hasPos(x.f)), noPos = list.filter(x => !hasPos(x.f));
  const res = Array.isArray(sh.res)
    ? sh.res.map((r, j) => `<div class="fav-res"><div><b>${esc(r.name)}</b><div class="muted small">${esc(r.address || r.kind || '')}</div></div><button class="chip-btn ${isFav(r) ? 'on' : ''}" data-act="favResAdd" data-j="${j}">${isFav(r) ? '🫧 있음' : '🫧 만들기'}</button></div>`).join('') || '<div class="muted small pad">찾지 못했어요. 영어 이름으로도 찾아보세요.</div>'
    : sh.res === 'loading' ? '<div class="muted small pad">찾는 중…</div>' : '';
  return `<div class="fav-search"><input id="favQ" placeholder="가고 싶은 곳 검색해서 버블 만들기" value="${esc(sh.q || '')}"><button class="chip-btn on" data-act="favSearch">찾기</button></div>${res}
    ${S.favs.length ? `${cats}
      <button class="tray-btn" data-act="favTray">🫧 가볼 곳 버블 창 열기 <span class="muted small">· 꾹 눌러 날짜·시간표에 끌어 놓기</span></button>
      ${here.length ? `<div class="fav-group">📍 이 근처</div><div class="fav-bubs">${here.map(card).join('')}</div>` : ''}
      ${far.length ? `${here.length ? '<div class="fav-group">🌏 다른 곳</div>' : ''}<div class="fav-bubs">${far.map(card).join('')}</div>` : ''}
      ${noPos.length ? `<div class="fav-group">📝 이름만 적어 둔 곳 <span class="muted small">· 일정에 넣으면 위치를 찾아요</span></div><div class="fav-bubs">${noPos.map(card).join('')}</div>` : ''}`
    : '<div class="muted pad">아직 버블이 없어요.<br><b>지도를 꾹 누르거나</b>, 장소 상세·추천 결과의 <b>🫧</b>를 누르거나, 위에서 검색해서 만들어 보세요.</div>'}`;
}

async function favSearch() {
  const sh = S.sheet, q = $('#favQ')?.value.trim();
  if (!q) return;
  sh.q = q; sh.res = 'loading'; renderSheet();
  let list = [];
  const c0 = areaCenter();
  try {
    if (gkey()) list = await searchPlaces(gkey(), q, c0);
    if (!list.length) list = await searchPlacesFree(q, c0);
  } catch { /* 결과 없음으로 안내 */ }
  if (S.sheet !== sh) return;
  sh.res = list.slice(0, 5); renderSheet();
}

function memBody(mems) {
  const days = [...new Set(mems.map(m => m.date))], hearts = mems.filter(m => m.heart).length;
  const tools = `<div class="chips mem-tools"><button class="chip-btn on" data-act="memMap">🗺️ 추억 지도</button><button class="chip-btn" data-act="memExport">⬇ 백업 저장</button><button class="chip-btn" data-act="memImport">⬆ 백업 불러오기</button></div>`;
  if (!mems.length) return `<div class="muted pad">아직 다녀온 곳이 없어요.<br>일정 장소에 <b>도착</b>하면 날짜·시간과 함께 자동으로 여기 모여요. 일정을 지우거나 초기화해도 추억은 남아요.</div>${tools}`;
  const row = m => {
    const t = m.arr ? `${clockAt(m.arr, m.date)} 도착${m.dep ? ` · ${fmtDur((m.dep - m.arr) / 60000)} 머묾` : ''}` : '다녀옴';
    const k = esc(m.key);
    return `<div class="mem-card">
      <div class="mem-top"><button class="mem-heart" data-act="memHeart" data-key="${k}" aria-label="하트">${m.heart ? '❤️' : '🤍'}</button>
        <div class="mem-name"><b>${esc(m.place)}</b><div class="muted small">${t}</div></div></div>
      ${m.note ? `<div class="mem-note">${esc(m.note)}</div>` : ''}
      ${m.photos?.length ? `<div class="mem-photos" data-mph="${k}">${m.photos.map((id, n) => `<button class="mem-ph" data-act="memView" data-key="${k}" data-k="${n}"></button>`).join('')}</div>` : ''}
      <div class="chips"><button class="chip-btn" data-act="memNote" data-key="${k}">✏️ ${m.note ? '메모 고치기' : '한 줄 메모'}</button><button class="chip-btn" data-act="memPhoto" data-key="${k}">📷 사진</button><button class="chip-btn" data-act="memFocus" data-key="${k}">🗺️ 지도</button><button class="chip-btn" data-act="memDel" data-key="${k}" aria-label="추억에서 빼기">🗑</button></div>
    </div>`;
  };
  return `<div class="mem-sum">${mems.length}곳 · ${days.length}일${hearts ? ` · ❤️ ${hearts}` : ''}</div>${tools}
    ${days.map(dt => `<div class="fav-group">${dayLabel(dt)}</div>${mems.filter(m => m.date === dt).map(row).join('')}`).join('')}
    <div class="muted small pad">추억은 이 휴대폰에만 저장돼요. 가끔 <b>백업 저장</b>으로 파일을 남겨 두세요 (사진 포함).</div>`;
}

// 추억 사진 작은 그림 채우기
async function fillMemPhotos() {
  for (const box of document.querySelectorAll('[data-mph]')) {
    const m = S.mems[box.dataset.mph];
    for (const [k, id] of (m?.photos || []).entries()) {
      const rec = await getFile(id).catch(() => null), el = box.querySelector(`[data-k="${k}"]`);
      if (rec && el) el.style.backgroundImage = `url(${blobUrl(rec.blob)})`;
    }
  }
}

async function openMemPhoto(key, k) {
  const m = S.mems[key], id = m?.photos?.[k];
  if (!id) return;
  S.viewer = { mem: key, k };
  const el = $('#viewer'), n = m.photos.length, ek = esc(key);
  el.hidden = false;
  el.innerHTML = `<div class="vw-top"><button class="vw-btn" data-act="closeViewer" aria-label="닫기">✕</button>
      <div class="vw-title"><b>${esc(m.place)}</b><span>${dayLabel(m.date)}${n > 1 ? ` · ${k + 1}/${n}` : ''}</span></div>
      <button class="vw-btn" data-act="memPhotoDel" aria-label="사진 삭제">🗑</button></div>
    <div class="vw-body"><div class="muted pad">불러오는 중…</div></div>${vwTools()}
    ${n > 1 ? `<button class="vw-nav prev" data-act="memView" data-key="${ek}" data-k="${k - 1}" ${k === 0 ? 'disabled' : ''}>‹</button><button class="vw-nav next" data-act="memView" data-key="${ek}" data-k="${k + 1}" ${k === n - 1 ? 'disabled' : ''}>›</button>` : ''}`;
  const rec = await getFile(id).catch(() => null);
  const body = el.querySelector('.vw-body');
  if (S.viewer?.mem !== key || S.viewer.k !== k || !body) return;
  body.innerHTML = rec ? `<img src="${blobUrl(rec.blob)}" alt="">` : '<div class="muted pad">사진을 찾을 수 없어요</div>';
}

function hiddenInput(accept, multiple, onFiles) {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = accept; inp.multiple = multiple; inp.hidden = true;
  inp.addEventListener('change', () => { const files = [...inp.files]; inp.value = ''; if (files.length) onFiles(files); });
  document.body.append(inp);
  return inp;
}
const memInput = hiddenInput('image/*', true, async files => {
  const m = S.mems[S.memPhotoFor];
  if (!m) return;
  for (const f of files) { try { m.photos = [...(m.photos || []), (await saveFile(f)).id]; } catch (e) { toast(`사진 저장 실패: ${e.message}`, 4000); } }
  saveMems(); rerenderKeep(); toast(`📷 ${m.place}에 사진을 넣었어요`);
});

// ---------- 백업: 추억(사진 포함)·즐겨찾기를 파일 하나로 ----------
const toDataUrl = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
async function exportKeep() {
  toast('백업 파일을 만드는 중…');
  const photos = {};
  for (const m of Object.values(S.mems)) for (const id of m.photos || []) {
    const rec = await getFile(id).catch(() => null);
    if (rec) photos[id] = { name: rec.name, type: rec.type, data: await toDataUrl(rec.blob) };
  }
  const text = JSON.stringify({ app: 'tripflip', kind: 'keep', v: 1, at: Date.now(), mems: S.mems, favs: S.favs, photos });
  const how = await saveOrShare(`트립플립_추억_${todayStr()}.json`, text).catch(e => { toast(`저장하지 못했어요: ${e.message}`, 5000); return null; });
  if (how === 'saved') toast('📁 휴대폰 "문서" 폴더에 저장했어요. 카톡·드라이브로도 보내 두세요', 5000);
  else if (how === 'downloaded') toast('⬇ 다운로드 폴더에 저장했어요', 4000);
  else if (how === 'shared') toast('백업 파일을 보냈어요');
}
const importInput = hiddenInput('.json,application/json', false, async ([f]) => {
  try {
    const data = JSON.parse(await f.text());
    if (data.app !== 'tripflip' || data.kind !== 'keep') throw new Error('트립플립 추억 백업 파일이 아니에요');
    for (const [id, p] of Object.entries(data.photos || {})) {
      if (await getFile(id).catch(() => null)) continue;
      await putFile({ id, name: p.name, type: p.type }, await (await fetch(p.data)).blob());
    }
    const nm = memList(data.mems).length, nf = (data.favs || []).length;
    ({ mems: S.mems, favs: S.favs } = mergeBackup({ mems: S.mems, favs: S.favs }, data));
    saveMems(); saveFavs(); rerenderKeep();
    toast(`⬆ 추억 ${nm}곳, 버블 ${nf}곳을 불러왔어요`, 4000);
  } catch (e) { toast(`불러오지 못했어요: ${e.message}`, 5000); }
});

// ---------- 🗺️ 추억 지도: 다녀온 곳을 날짜별 색과 동선으로 ----------
function openMemMap(focusKey) {
  const list = memList(S.mems).filter(hasPos);
  if (!list.length) { toast('아직 다녀온 곳이 없어요'); return; }
  closeMemMap();
  const days = [...new Set(list.map(m => m.date))];
  const color = dt => PALETTE[days.indexOf(dt) % PALETTE.length];
  const el = document.createElement('div');
  el.id = 'memMap'; el.className = 'memmap';
  el.innerHTML = `<div class="mm-top"><button class="vw-btn" data-act="memMapClose" aria-label="닫기">✕</button>
      <div class="vw-title"><b>📸 추억 지도</b><span>${list.length}곳 · ${days.length}일</span></div><button class="vw-btn" data-act="memMapDay" data-date="" aria-label="전체 보기">⤢</button></div>
    <div class="mm-days">${days.map(dt => `<button class="chip-btn" data-act="memMapDay" data-date="${dt}"><i style="background:${color(dt)}"></i>${dayLabel(dt)}</button>`).join('')}</div>
    <div class="mm-map"></div>`;
  document.body.append(el);
  const map = L.map(el.querySelector('.mm-map'), { zoomControl: false });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
  for (const dt of days) {
    const pts = list.filter(m => m.date === dt);
    if (pts.length > 1) L.polyline(pts.map(m => [m.lat, m.lng]), { color: color(dt), weight: 3, opacity: 0.55, dashArray: '4 7' }).addTo(map);
  }
  const markers = {};
  for (const m of list) {
    const icon = L.divIcon({ className: '', html: `<div class="mm-pin" style="background:${color(m.date)}">${m.heart ? '❤' : ''}</div>`, iconSize: [22, 22], iconAnchor: [11, 11] });
    const t = m.arr ? clockAt(m.arr, m.date) : '';
    markers[m.key] = L.marker([m.lat, m.lng], { icon, zIndexOffset: m.heart ? 500 : 0 }).addTo(map).bindPopup(
      `<div class="mm-pop"><b>${esc(m.place)}</b><div class="muted small">${dayLabel(m.date)}${t ? ` · ${t}` : ''}</div>${m.note ? `<div>${esc(m.note)}</div>` : ''}${m.photos?.length ? `<div class="mm-ph" data-ph="${esc(m.photos[0])}"></div>` : ''}</div>`);
  }
  map.on('popupopen', async e => {
    const ph = e.popup.getElement()?.querySelector('[data-ph]');
    const rec = ph && await getFile(ph.dataset.ph).catch(() => null);
    if (rec) { ph.style.backgroundImage = `url(${blobUrl(rec.blob)})`; ph.classList.add('on'); }
  });
  S.memMap = { map, el, list, markers };
  const focus = focusKey && markers[focusKey];
  if (focus) { map.setView(focus.getLatLng(), 16); focus.openPopup(); }
  else memMapFit('');
}
function memMapFit(date) {
  const mm = S.memMap;
  if (!mm) return;
  const pts = mm.list.filter(m => !date || m.date === date).map(m => [m.lat, m.lng]);
  if (pts.length === 1) mm.map.setView(pts[0], 15);
  else if (pts.length) mm.map.fitBounds(pts, { padding: [40, 40] });
  mm.el.querySelectorAll('.mm-days .chip-btn').forEach(b => b.classList.toggle('on', b.dataset.date === date));
}
function closeMemMap() {
  if (!S.memMap) return;
  S.memMap.map.remove(); S.memMap.el.remove(); S.memMap = null;
}

// ---------- 📝 가볼 곳 서랍: 가고 싶은 곳을 마구 적으면 버블 버튼이 생김 → 꾹 눌러 날짜에 대면 그 날로, 시간표 자리에 놓으면 끝 ----------
S.tray = null; // { cat }
function toggleTray(on = !S.tray) {
  S.tray = on ? { cat: 'all' } : null;
  document.body.classList.toggle('tray-open', !!S.tray);
  renderTray();
  if (on && !S.favs.length) setTimeout(() => $('#wishIn')?.focus(), 250);
}
const shortDate = date => `${+date.slice(5, 7)}/${+date.slice(8, 10)}`;
function renderTray() {
  let el = $('#favTray');
  if (!S.tray) { el?.remove(); return; }
  if (!el) { el = document.createElement('div'); el.id = 'favTray'; document.body.append(el); setupTrayDrag(el); }
  const typed = $('#wishIn')?.value || '';
  // 이미 시간표에 넣은 곳은 흐리게 + 그 날짜 (뒤로 보냄)
  const usedOn = {};
  for (const d of [...S.plan.days].sort((a, b) => (a.date < b.date ? -1 : 1))) for (const it of d.items) usedOn[it.place.trim().toLowerCase()] ??= d.date;
  const list = S.favs.filter(f => S.tray.cat === 'all' || f.cat === S.tray.cat)
    .map(f => ({ f, on: usedOn[f.place.trim().toLowerCase()] }))
    .sort((a, b) => (a.on ? 1 : 0) - (b.on ? 1 : 0));
  const used = new Set(S.favs.map(f => f.cat));
  el.innerHTML = `<div class="ft-head"><b>🫧 가볼 곳 버블 <span class="muted">${S.favs.length || ''}</span></b>
      <span class="ft-tools"><button data-act="keep">🔎 찾기·추억</button><button class="x" data-act="favTray" aria-label="닫기">✕</button></span></div>
    <div class="ft-add"><textarea id="wishIn" rows="1" placeholder="가고 싶은 곳을 마구 적으면 버블이 돼요 (여러 곳은 줄바꿈·쉼표로)">${esc(typed)}</textarea><button data-act="wishAdd">만들기</button></div>
    ${used.size > 1 ? `<div class="ft-cats"><button class="${S.tray.cat === 'all' ? 'on' : ''}" data-act="trayCat" data-cat="all">전체</button>${FAV_CATS.filter(c => used.has(c.id)).map(c => `<button class="${S.tray.cat === c.id ? 'on' : ''}" data-act="trayCat" data-cat="${c.id}">${c.icon} ${c.label}</button>`).join('')}</div>` : ''}
    <div class="ft-list">${list.map(({ f, on }) => `<div class="bub cat-${f.cat} ${on ? 'used' : ''}" data-fid="${f.id}"><span class="bub-ic">${catOf(f.cat).icon}</span><b>${esc(f.place)}</b>${on ? `<small>✓ ${shortDate(on)}</small>` : ''}</div>`).join('')
      || '<div class="muted small ft-empty">위에 가고 싶은 곳을 적고 <b>만들기</b>를 누르거나, <b>지도를 꾹 누르면</b> 버블이 생겨요</div>'}</div>
    ${list.length ? '<div class="ft-tip">버블을 <b>꾹 눌러</b> 위 날짜에 대면 그 날로 넘어가요 → 원하는 자리에 놓으면 끝</div>' : ''}`;
  fitWishBox();
}
// 적는 칸은 글이 늘면 4줄까지 커짐, 서랍 높이만큼 시간표 아래 여백
function fitWishBox() {
  const t = $('#wishIn'), el = $('#favTray');
  if (t) { t.style.height = 'auto'; t.style.height = `${Math.min(t.scrollHeight, 100)}px`; }
  if (el) document.body.style.setProperty('--tray-h', `${el.offsetHeight}px`);
}
function wishAdd() {
  const t = $('#wishIn'), names = splitWishes(t?.value);
  if (!names.length) { t?.focus(); toast('가고 싶은 곳 이름을 적어 주세요'); return; }
  let added = 0;
  for (const place of names) {
    if (findFav(S.favs, { place })) continue; // 이미 있는 곳
    S.favs.push({ id: newId(), place, address: '', lat: null, lng: null, cat: guessCat(place), added: Date.now() });
    added++;
  }
  saveFavs();
  t.value = '';
  renderTray();
  $('#wishIn')?.focus();
  toast(added ? `📝 ${added}곳 추가 · 꾹 눌러 날짜에 끌어 놓으세요` : '이미 가볼 곳에 있어요');
}

// 새 일정 하나 넣기 (가볼 곳 끌어 놓기·장소만 적어 추가). index가 없으면 시간 순서에 맞는 자리(마지막이 숙소면 그 앞)
// 위치를 모르면 이름으로 찾아 둠. 시간·메모 같은 자세한 건 나중에 눌러서
function placeNew(date, index, base, quiet) {
  const d = ensureDay(date);
  const at = Math.min(index ?? insertIndexFor(d, { time: null }), d.items.length);
  const item = { ...favDraft(base), id: newId(), mode: base.mode || d.items[at - 1]?.mode || 'TRANSIT', files: [] };
  const items = [...d.items];
  items.splice(at, 0, item);
  const fitted = at > 0 ? keepStay(d, items, at - 1) : items;
  const imp = d.items.length ? confirmChange(d, fitted) : null;
  if (d.items.length && !imp) return null;
  d.items = fitted;
  savePlan();
  if (date !== S.selected) selectDay(date, true);
  recompute(); renderAll(false); prefetchLegs(); scheduleAlarms();
  if (!hasPos(item)) geocodeMissing();
  if (S.tray) renderTray();
  const row = $(`#timeline .row[data-i="${at}"]`);
  if (row) { row.classList.add('flash'); row.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  if (!quiet) {
    if (imp && (imp.late.length || imp.shifted.length || imp.shortened.length)) changeToast(imp, `✓ ${item.place} 넣었어요`);
    else toast(`✓ ${item.place} 넣었어요 · 눌러서 시간·메모 정하기`, 4000, { label: '되돌리기', fn: () => undoPlace(date, item.id) });
  }
  return item;
}
function undoPlace(date, id) {
  const d = S.plan.days.find(x => x.date === date);
  if (!d) return;
  d.items = d.items.filter(x => x.id !== id);
  if (!d.items.length) S.plan.days = S.plan.days.filter(x => x !== d);
  savePlan(); recompute(); renderAll(false); scheduleAlarms();
  if (S.tray) renderTray();
}

function setupTrayDrag(tray) {
  let press = null, g = null, raf = 0;
  const trash = $('#dragTrash');
  const clearMarks = () => document.querySelectorAll('.row.drop-before, .row.drop-after, #dayTabs .drop-tab, .empty.drop-in').forEach(e => e.classList.remove('drop-before', 'drop-after', 'drop-tab', 'drop-in'));
  const scroller = $('#listView');
  // 위·아래 끝으로 끌면 시간표가 따라 스크롤
  const autoScroll = () => {
    if (!g) return;
    const top = scroller.getBoundingClientRect().top, bottom = tray.getBoundingClientRect().top;
    if (g.y > top && g.y < top + 60) scroller.scrollBy(0, -10); else if (g.y > bottom - 50 && g.y < bottom) scroller.scrollBy(0, 10);
    raf = requestAnimationFrame(autoScroll);
  };
  const overTrash = (x, y) => { const b = trash?.getBoundingClientRect(); return b && x >= b.left - 20 && x <= b.right + 20 && y >= b.top - 20 && y <= b.bottom + 20; };
  // 놓을 곳: 휴지통, 위 날짜 탭(그 날), 시간표 두 줄 사이(그 자리), 빈 날(첫 일정)
  const findTarget = (x, y) => {
    if (overTrash(x, y)) return { trash: true };
    const tab = document.elementsFromPoint(x, y).find(e => e.matches?.('#dayTabs [data-date]'));
    if (tab) return { date: tab.dataset.date, tab };
    if (y >= tray.getBoundingClientRect().top || topLayer() !== 'list') return null;
    const rows = [...document.querySelectorAll('#timeline .row[data-i]')];
    if (!rows.length) {
      const empty = $('#timeline .empty');
      return empty && y > $('#listView').getBoundingClientRect().top ? { index: 0, empty } : null;
    }
    const tl = $('#timeline').getBoundingClientRect();
    if (y < tl.top || y > tl.bottom + 40) return null; // 시간표 밖(위 상태 카드 등)에 놓으면 취소
    let k = rows.findIndex(r => { const b = r.getBoundingClientRect(); return y < b.top + b.height / 2; });
    if (k === 0) k = 1; // 첫 줄(출발지) 앞에는 넣지 않음
    const after = k < 0 || !rows[k];
    return { index: after ? rows.length : +rows[k].dataset.i, row: after ? rows.at(-1) : rows[k], after };
  };
  // 끄는 버튼 아래에 "어디에·몇 시쯤" 보여 줌
  const hint = t => {
    if (!t) return '여기엔 못 놓아요';
    if (t.trash) return '놓으면 가볼 곳에서 지우기';
    if (t.date) return t.date === S.selected ? `${dayLabel(t.date)} 알맞은 자리에` : `${dayLabel(t.date)}로 넘어가는 중…`;
    if (t.empty) return `${dayLabel(S.selected)} 첫 일정으로`;
    const prev = S.cur.sched[t.index - 1];
    return `${t.index + 1}번째${prev?.depart != null ? ` · ${fmtClock(prev.depart)} 이후` : ''}`;
  };
  const moveGhost = (x, y) => {
    g.x = x; g.y = y;
    g.ghost.style.transform = `translate(${x - g.w / 2}px, ${y - g.h - 34}px)`;
    clearMarks();
    g.target = findTarget(x, y);
    const t = g.target;
    trash?.classList.toggle('hot', !!t?.trash);
    if (t?.tab) t.tab.classList.add('drop-tab');
    else if (t?.empty) t.empty.classList.add('drop-in');
    else if (t?.row) t.row.classList.add(t.after ? 'drop-after' : 'drop-before');
    // 날짜 탭에 잠깐 대고 있으면 그 날 시간표로 넘어감 (손가락은 그대로 끌면서 자리 고르기)
    if (t?.date && t.date !== S.selected) {
      if (g.spring?.date !== t.date) {
        clearTimeout(g.spring?.timer);
        const date = t.date;
        g.spring = { date, timer: setTimeout(() => { if (!g) return; g.spring = null; selectDay(date, true); navigator.vibrate?.(15); moveGhost(g.x, g.y); }, 450) };
      }
    } else if (g.spring) { clearTimeout(g.spring.timer); g.spring = null; }
    g.tip.textContent = hint(t);
  };
  tray.addEventListener('pointerdown', e => {
    const card = e.target.closest('.bub');
    if (!card || g) return;
    const fav = S.favs.find(f => f.id === card.dataset.fid);
    press = { x: e.clientX, y: e.clientY, timer: setTimeout(() => {
      press = null;
      if (boardMode()) {
        try { card.setPointerCapture(e.pointerId); } catch { /* 일부 브라우저 */ }
        bdStart({ kind: 'wish', fav, from: card, card, x: e.clientX, y: e.clientY });
        return;
      }
      const ghost = card.cloneNode(true);
      ghost.classList.add('bub-ghost'); ghost.classList.remove('used');
      const tip = document.createElement('em');
      tip.className = 'gh-tip';
      ghost.append(tip);
      document.body.append(ghost);
      g = { fav, ghost, tip, card, x: e.clientX, y: e.clientY, target: null, w: ghost.offsetWidth, h: card.offsetHeight };
      card.classList.add('lifted');
      tray.classList.add('folded'); // 끄는 동안 서랍은 아래로 접어서 시간표 전체를 놓을 자리로
      trash?.classList.add('show');
      try { card.setPointerCapture(e.pointerId); } catch { /* 일부 브라우저 */ }
      navigator.vibrate?.(30);
      moveGhost(e.clientX, e.clientY);
      raf = requestAnimationFrame(autoScroll);
    }, 350) };
  });
  tray.addEventListener('pointermove', e => {
    if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) { clearTimeout(press.timer); press = null; } // 그냥 목록 넘기기
    if (g) moveGhost(e.clientX, e.clientY);
  });
  const end = () => {
    if (press) { clearTimeout(press.timer); press = null; }
    if (!g) return;
    const { fav, ghost, card, target } = g;
    clearTimeout(g.spring?.timer);
    g = null; cancelAnimationFrame(raf);
    ghost.remove(); card.classList.remove('lifted'); tray.classList.remove('folded'); clearMarks();
    trash?.classList.remove('show', 'hot');
    S.dragJustEnded = Date.now();
    if (!target || !fav) return;
    if (target.trash) {
      S.favs = S.favs.filter(f => f !== fav); saveFavs(); renderTray();
      toast(`🗑 ${fav.place} 가볼 곳에서 뺐어요`, 5000, { label: '되돌리기', fn: () => { S.favs.push(fav); saveFavs(); rerenderKeep(); } });
      return;
    }
    placeNew(target.date || S.selected, target.date ? null : target.index, fav);
  };
  tray.addEventListener('pointerup', end);
  tray.addEventListener('pointercancel', end);
  tray.addEventListener('touchmove', e => { if (g && e.cancelable) e.preventDefault(); }, { passive: false });
  tray.addEventListener('contextmenu', e => { if (g || press) e.preventDefault(); });
  tray.addEventListener('input', e => { if (e.target.id === 'wishIn') fitWishBox(); });
}

// 즐겨찾기 → 새 일정 초안 (시간은 비워 둠: 예약이면 수정 창에서 시간을 정하면 됨)
const favDraft = f => ({ ...blankPlace(), place: f.place, address: f.address || '', lat: f.lat ?? null, lng: f.lng ?? null, time: null, stay: 60, mode: 'TRANSIT', memo: '', notes: [] });

// ---------- 아직 여기 있어요 · 다시 맞추기 · 쉬기 ----------
S.rest = store.get('tg.rest', null); // { date, until(ms) } 또는 { date, day: true }
const saveRest = () => store.set('tg.rest', S.rest);
function resting(d) {
  const r = S.rest;
  return r && r.date === d.date && (r.day || Date.now() < r.until) ? r : null;
}
const gpsNow = () => { const p = S.pos; return p && !p.stale && (p.acc ?? 0) <= 1000 && Date.now() - p.ts < 180000 ? p : null; };
// "그 장소에 있다"고 볼 거리: 설정 반경(최소 150m) 또는 위치 오차만큼 (실내 대비, 최대 250m)
const nearTol = p => Math.max(S.settings.radius, 150, Math.min(p?.acc ?? 0, 250));
const ASK_R = 250; // 이 안인데 자동 도착이 안 되면 물어봄
S.askNo = {};      // "아직" 누른 장소: 10분 동안 다시 안 물어봄
// 이동 중인 목적지 근처(250m)인데 자동 도착 조건(50m·정확)은 아닐 때 → 물어볼 장소 번호
function askArrive(d, ph) {
  const pos = gpsNow();
  if (!pos || (ph.type !== 'move' && ph.type !== 'flex')) return -1;
  const prog = S.progress[d.date] || {};
  const near = it => hasPos(it) && !prog[it.id] && Date.now() - (S.askNo[it.id] || 0) >= 10 * 60000 && haversine(pos, it) <= ASK_R;
  if (near(d.items[ph.i])) return ph.i;
  // 앞 장소 도착을 감지 못 한 채 이미 더 뒤 장소에 와 있을 때 (다음 예약까지 안에서만, 숙소·방금 있던 곳 근처는 제외)
  const from = ph.i > 0 ? prevStop(d, ph.i) : null, stop = nextFixedIdx(d, ph.i + 1);
  for (let k = ph.i + 1; k <= (stop < 0 ? d.items.length - 1 : stop); k++) {
    const it = d.items[k];
    if (isHotel(it.place) || (from && hasPos(from) && hasPos(it) && haversine(from, it) <= ASK_R)) continue;
    if (near(it)) return k;
  }
  return -1;
}
// "○○에 도착하셨나요?" 묻는 줄 (더 뒤 장소면 앞 장소는 끝난 것으로 한다고 알려줌)
function askHtml(d, ph) {
  const k = askArrive(d, ph);
  if (k < 0) return '';
  const skipN = k - ph.i;
  return `<div class="st-ask">📍 <b>${esc(d.items[k].place)}</b>에 도착하셨나요?${skipN > 0 ? `<small>앞의 ${skipN}곳은 다녀온 것으로 할게요</small>` : ''}<span><button class="primary" data-act="arriveYes" data-i="${k}">네, 도착</button><button data-act="arriveNo" data-i="${k}">아직</button></span></div>`;
}
const nextStopIdx = (d, i) => { const prog = S.progress[d.date] || {}; for (let j = i + 1; j < d.items.length; j++) if (!prog[d.items[j].id]?.skip) return j; return -1; };

// GPS로 보면 아직 앞 장소(숙소 등)에 있는데, 시간표는 떠날 시간이 15분 넘게 지난 경우
function stuckInfo(d, ph) {
  const pos = gpsNow();
  if (!pos || !isLive() || ph.type === 'done') return null;
  const R = nearTol(pos), sched = S.cur.sched, now = Date.now();
  const near = k => k >= 0 && hasPos(d.items[k]) && haversine(pos, d.items[k]) <= R;
  let at = -1, next = -1;
  if (ph.type === 'stay' || ph.type === 'before') { at = ph.i; next = nextStopIdx(d, at); if (!near(at)) return null; }
  else if (ph.type === 'move' || ph.type === 'flex') {
    next = ph.i;
    for (let k = next - 1; k >= 0 && at < 0; k--) if (near(k)) at = k; // 앞쪽 장소 중 지금 있는 곳
    if (at < 0) return null;
  }
  if (next < 0) return null;
  // 자유 일정은 재촉하지 않음: 다음 예약에 맞춰 늦어도 떠나야 할 시각이 지났을 때만
  const fixed = nextFixedIdx(d, next);
  if (fixed < 0) return null;
  const behind = (now - latestDepMs(d, fixed)) / 60000;
  if (behind < 0) return null;
  const prog = S.progress[d.date] || {};
  const missed = d.items.slice(at + 1, next).filter(it => !prog[it.id]).length;
  return { at, next, behind, missed, fixed };
}

// 지금(또는 n분 뒤) 출발로 다시 맞추기: 놓친 곳은 건너뛰고, 예약 시각은 그대로 지킴
function replan(d, at, next, mins = 0) {
  const prog = progOf(d.date), now = Date.now();
  S.undo = { date: d.date, at: now, snap: JSON.stringify(prog), rest: S.rest };
  let missed = 0;
  for (let j = at + 1; j < next; j++) {
    const id = d.items[j].id;
    if (!prog[id]?.arr) { prog[id] = { skip: true }; missed++; }
  }
  const p = prog[d.items[at].id] || {};
  prog[d.items[at].id] = { arr: p.arr ?? now, hold: now + mins * 60000 };
  S.rest = null; saveRest();
  changed();
  const lateN = S.cur.sched.filter((s, j) => j > at && !s.skipped && s.late > 0 && d.items[j].time != null).length;
  toast(`${missed ? `놓친 ${missed}곳은 건너뛰었어요 · ` : ''}${mins ? `${mins}분 뒤` : '지금'} 출발로 다시 맞췄어요 · ${lateN ? `⚠ 예약 ${lateN}곳에 늦어요` : '예약은 그대로예요'}`, 7000);
  prefetchLegs(); // 바뀐 출발지에서 가는 길 다시 받기
}

function setRest(d, m) {
  const until = m === 'day' ? null : Math.max(Date.now(), resting(d)?.until || 0) + (+m) * 60000;
  S.rest = m === 'day' ? { date: d.date, day: true } : { date: d.date, until };
  saveRest(); renderStatus(); scheduleAlarms(true);
  toast(m === 'day' ? '오늘은 쉬어요' : `${clockAt(until)}까지 쉬어요`, 5000);
}

// 상태 카드: 평소엔 "출발까지 38:58"처럼 큰 숫자만, 누르면 아래로 펼쳐 자세히, 위로 쓸어 올리면 다시 접힘
function setStatusHtml(el, html) {
  const foldable = html.includes('st-big') && !html.includes('data-nofold');
  el.innerHTML = html + (foldable ? (S.statusOpen
    ? '<button class="st-fold" data-fold="close" aria-label="접기">︿ 위로 밀어 접기</button>'
    : '<div class="st-unfold">▾ 눌러서 자세히</div>') : '');
  el.classList.toggle('compact', foldable && !S.statusOpen);
}

// 높이가 부드럽게 늘어나고 줄어들게
function setStatusOpen(open) {
  const el = $('#status');
  if (!el || !!S.statusOpen === open) return;
  const from = el.offsetHeight;
  S.statusOpen = open;
  renderStatus();
  const to = el.offsetHeight;
  el.style.height = `${from}px`;
  el.offsetHeight; // 높이 고정 반영
  el.classList.add('folding');
  el.style.height = `${to}px`;
  setTimeout(() => { el.classList.remove('folding'); el.style.height = ''; }, 320);
}

function setupStatusFold() {
  const el = $('#status');
  el.addEventListener('click', e => {
    if (e.target.closest('[data-fold]')) { setStatusOpen(false); return; }
    if (e.target.closest('button, a, [data-act]')) return; // 카드 안 버튼은 그대로
    if (el.classList.contains('compact')) setStatusOpen(true);
  });
  let sx = 0, sy = 0;
  el.addEventListener('touchstart', e => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
  el.addEventListener('touchend', e => {
    const t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
    if (S.statusOpen && dy < -50 && Math.abs(dx) < Math.abs(dy)) setStatusOpen(false); // 위로 쓸어 올림 → 접기
    else if (!S.statusOpen && dy > 40 && Math.abs(dx) < Math.abs(dy) && el.classList.contains('compact')) setStatusOpen(true); // 아래로 당김 → 펼치기
  }, { passive: true });
}

const wakeButton = () => ''; // 모닝콜은 알람과 함께 뺌

// "a. 커피  b. 페이스트리" → ['커피', '페이스트리']
const splitChips = t => t.split(/\s+(?=[a-zA-Z]\.\s)/).map(x => x.replace(/^[a-zA-Z]\.\s*/, '').trim()).filter(Boolean);

// 진행 고치기: 어디까지 했는지 한 번에 맞추기 + 이 날 진행 초기화
function progHtml() {
  const d = curDay();
  if (!d) return '';
  const ph = phase(d), prog = S.progress[d.date] || {};
  const label = { done: '완료', skip: '건너뜀', here: '지금', next: '다음' };
  const rows = d.items.map((it, i) => {
    const st = itemState(d, i, ph), p = prog[it.id];
    return `<div class="pg-row ${st}"><span class="pg-num">${st === 'done' || st === 'skip' ? '✓' : labelOf(d, i)}</span>
      <span class="pg-name">${esc(it.place)}${label[st] ? `<small>${label[st]}</small>` : ''}</span>
      ${p ? `<button class="chip-btn" data-act="clear" data-i="${i}">기록 지우기</button>` : ''}
      ${isLive() ? `<button class="chip-btn" data-act="doneUpTo" data-i="${i}">여기까지 끝</button>` : ''}</div>`;
  }).join('');
  return `<div class="sheet-head"><div><div class="st-label">${dayLabel(d.date)}</div><b>✅ 진행 상황 고치기</b></div><button class="x" data-act="closeSheet">✕</button></div>
    <div class="muted small">이미 다녀온 곳이 아직 남아 있으면, 마지막으로 다녀온 곳의 <b>여기까지 끝</b>을 누르세요. 그 앞은 모두 끝난 것으로 하고, 다음 장소는 지금부터 다시 계산해요.</div>
    <div class="pg-list">${rows}</div>
    <div class="st-actions"><button class="danger" data-act="resetProgress">🔄 이 날 진행 초기화 (처음부터)</button></div>`;
}

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
  const wake = '';
  return `<div class="day-head"><div><div class="t">${esc(title)}</div>${d?.subtitle ? `<div class="s">${esc(d.subtitle)}</div>` : ''}</div>
    <div class="head-pills">${wake}${n ? `<button class="progress" data-act="progSheet" aria-label="진행 상황 고치기">${done}/${n} 완료 ›</button>` : ''}</div></div>`;
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
  if (S.bd && !S.bd.switching) return; // 버블을 끄는 중엔 다시 그리지 않음 (끄는 버블이 사라지지 않게)
  if (boardMode()) {
    const qa = $('#qaIn'), keep = qa && { v: qa.value, f: document.activeElement === qa };
    el.innerHTML = boardHtml(d, date);
    if (keep && $('#qaIn')) { $('#qaIn').value = keep.v; if (keep.f) $('#qaIn').focus(); }
    return;
  }
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
  // 추천 칸은 꼭 필요할 때만: 비행기·공항 앞뒤는 빼고, 오늘 이미 지난 시간대도 뺌 (화면이 산만하지 않게)
  const nowM = d.date === todayStr() ? nowMinOf(d.date) : -1;
  const busy = k => [d.items[k], d.items[k + 1]].some(x => x && (isFlight(x.place) || AIRPORT_RE.test(x.place)));
  const passed = g => nowM >= 0 && (g.we != null ? nowM > g.we : nowM > (S.cur.sched[g.k]?.depart ?? 1e9));
  if (d.date >= todayStr()) for (const g of [...mealGaps(d), ...extraGaps(d)]) if (!busy(g.k) && !passed(g)) (gaps[g.k] ||= []).push(g);
  const rows = d.items.map((it, i) => {
    const s = sched[i], state = states[i], done = state === 'done' || state === 'skip', color = placeColor(i, state);
    let leg = '';
    if (i > 0) {
      const l = legs[i], m = MODES[it.mode];
      leg = `<div class="row-leg ${done ? 'done' : ''}"><span>${m.icon} ${fmtDur(l.dur)}${l.dist != null ? ` · ${fmtDist(l.dist)}` : ''}</span></div>`;
    }
    const fixed = isFixedItem(d, i);
    const tag = state === 'here' ? '<span class="row-tag now">지금</span>' : state === 'next' ? '<span class="row-tag next">다음</span>'
      : done ? `<span class="row-tag">${state === 'skip' ? '건너뜀' : '완료'}</span>` : '';
    // 시각은 예약(시간이 정해진 일정)에만. 첫 장소는 "대략 출발", 나머지 자유 일정은 순서만
    const first = i === 0 && n > 1 && !s.proc;
    const sub = first ? `${fmtClock(s.depart)}쯤 출발`
      : s.proc ? `✈️ 착륙 · 🛂 입국 절차 약 ${fmtDur(s.proc)}`
      : fixed ? `🕒 ${fmtClock(it.time)} 예약`
      : i === n - 1 ? '마지막 · 순서대로' : '순서대로 둘러보기';
    const timeCell = fixed || s.proc ? `<div class="row-time">${fmtClock(s.arrive)}</div>`
      : first ? `<div class="row-time soft">${fmtClock(s.depart)}<small>출발</small></div>`
      : '<div class="row-time flex">·</div>';
    // 자유 일정 묶음 머리글: "🕒 허리케인스 그릴 18:30 예약 전까지 · 3곳 · 늦어도 17:55 출발"
    let head = '';
    if (!fixed && !first && !s.proc && !done && (i === 1 || isFixedItem(d, i - 1) || i === 0)) {
      const j = nextFixedIdx(d, i + 1), cnt = (j < 0 ? n : j) - i;
      head = j >= 0
        ? `<div class="flex-head">🕒 <b>${esc(d.items[j].place)} ${fmtClock(d.items[j].time)}</b> 예약 전까지 · ${cnt}곳 자유롭게 · 늦어도 ${clockAt(latestDepMs(d, j), d.date)} 출발</div>`
        : cnt > 1 ? `<div class="flex-head">🗺️ 자유 일정 · ${cnt}곳 순서대로</div>` : '';
    }
    return `${leg}${head}<div class="row ${state} ${fixed ? 'fixed' : ''}" data-act="openDetail" data-i="${i}" style="--c:${color}">
      ${timeCell}
      <div class="row-main">
        <div class="row-name">${esc(it.place)}${tag}${it.files?.length ? `<button class="clip" data-act="files" data-i="${i}" aria-label="첨부 파일 보기">📎${it.files.length > 1 ? `<small>${it.files.length}</small>` : ''}</button>` : ''}</div>
        <div class="row-sub">${sub}${s.late > 0 && !done ? ` <span class="late-tag">⚠ ${fmtDur(s.late)} 늦음</span>` : ''}${hasPos(it) ? '' : ` · <button class="bad" data-act="fixPlace" data-i="${i}">⚠ 위치 없음 · 눌러서 찾기</button>`}</div>
      </div>
      <span class="row-num ${i === 0 ? 'sq' : ''}">${done ? '✓' : labelOf(d, i)}</span>
    </div>${gapsHtml(gaps[i], i)}`;
  }).join('');
  const doneCount = states.filter(s => s === 'done' || s === 'skip').length;
  const qa = $('#qaIn'), qaKeep = qa && { v: qa.value, f: document.activeElement === qa }; // 적는 중에 화면이 새로 그려져도 글자 유지
  el.innerHTML = `${dayHeaderHtml(d, doneCount)}<div class="rows">${rows}</div>
    ${addAreaHtml(n)}
    ${dayNotesHtml(d)}`;
  if (qaKeep && $('#qaIn')) { $('#qaIn').value = qaKeep.v; if (qaKeep.f) $('#qaIn').focus(); }
}
function qaSave() {
  const inp = $('#qaIn'), names = splitWishes(inp?.value);
  if (!names.length) { inp?.focus(); return; }
  inp.value = '';
  const done = names.filter(place => placeNew(S.selected, null, { place }, names.length > 1));
  if (names.length > 1 && done.length) toast(`✓ ${done.length}곳 넣었어요 · 눌러서 시간·메모 정하기`);
  $('#qaIn')?.focus();
}

// 시간표 맨 아래: [＋ 장소 추가] 또는 장소 이름만 적는 칸
const addAreaHtml = n => (S.quickAdd ? `<div class="quick-add"><input id="qaIn" placeholder="장소 이름만 적고 추가" enterkeyhint="done" autocomplete="off"><button data-act="qaSave">추가</button></div>
      <div class="qa-more muted small"><span>자세한 건 추가한 뒤 눌러서 정해요</span><span><button data-act="qaSearch">🔎 검색해서 넣기</button><button data-act="qaClose">닫기</button></span></div>`
  : `<button class="add-btn" data-act="addPlace" data-i="${n}">＋ 장소 추가</button>`);

// ---------- 🫧 버블 보드: 오전·오후만 나눈 판 위에 순서대로 버블. 오늘은 지금·내 위치 기준으로 앞으로 갈 곳만 ----------
// 지금 내 위치에서 그곳까지 곧은 거리 (위치를 아직 모르면 빈칸). GPS가 바뀌면 updateDistances가 숫자만 고침
const bubDist = it => { if (!S.pos || !hasPos(it)) return ''; const m = haversine(S.pos, it); return m < S.settings.radius ? '여기' : fmtDist(m); };
const BOARD_SEC = { am: '오전 AM', pm: '오후 PM', late: '새벽 (다음 날)' };
function boardHtml(d, date) {
  const items = d?.items || [], n = items.length, sched = S.cur.sched;
  const ph = n && isLive() ? phase(d) : null;
  const states = items.map((_, i) => itemState(d, i, ph));
  const today0 = todayStr(), today = date === today0;
  const past = today ? states.flatMap((st, i) => (st === 'done' || st === 'skip' ? [i] : [])) : [];
  const showPast = S.showPast === date;
  let top = '';
  if (today && n) {
    const hi = states.indexOf('here'), ni = states.indexOf('next');
    const nd = ni >= 0 && hasPos(items[ni]) ? ` <span class="nb-dist" data-bd="${ni}">${bubDist(items[ni])}</span>` : ''; // 내 위치를 알면 "· 1.8km"
    const where = hi >= 0 ? `${esc(items[hi].place)}에 있어요` : ni >= 0 ? `다음은 ${esc(items[ni].place)}${nd}` : past.length === n ? '오늘 일정 끝' : '내 위치에서 출발';
    top = `<div class="now-bub">📍 지금 <b class="now-clock">${fmtClock(nowMinOf(date))}</b><span>${where}</span></div>`;
  }
  if (past.length) top += `<button class="past-fold" data-act="showPast">${showPast ? '︿ 지난 곳 접기' : `✓ 지난 곳 ${past.length}곳 보기`}</button>`;
  let sec = '';
  const slots = items.map((it, i) => {
    const st = states[i], done = st === 'done' || st === 'skip';
    if (past.includes(i) && !showPast) return '';
    const s = sched[i], t = s?.arrive ?? s?.depart;
    const sc = t == null ? sec || 'am' : t >= 1440 ? 'late' : t >= 720 ? 'pm' : 'am';
    const label = sc !== sec ? `<div class="ampm">${BOARD_SEC[sc]}</div>` : '';
    sec = sc;
    const tag = st === 'here' ? '<span class="b-tag now">지금</span>' : st === 'next' ? '<span class="b-tag next">다음</span>' : '';
    const dist = !done && date >= today0 && hasPos(it) ? `<span class="b-dist" data-bd="${i}">${bubDist(it)}</span>` : '';
    return `<div class="bslot" data-i="${i}">${label}<div class="bubble ${st}" data-act="bubTap" data-i="${i}" style="--c:${placeColor(i, st)}">
      <span class="b-num ${i === 0 ? 'sq' : ''}">${done ? '✓' : labelOf(d, i)}</span><b>${esc(it.place)}</b>${tag}${it.files?.length ? '<span class="b-ic">📎</span>' : ''}${dist}${hasPos(it) ? '' : '<span class="b-ic warn" title="위치 없음">⚠</span>'}</div></div>`;
  }).join('');
  const body = n ? slots : '<div class="board-empty">아래 <b>＋</b>로 적거나, ☆ <b>가볼 곳</b> 버블을 꾹 눌러 여기로 끌어 오세요</div>';
  return `<div class="board-head"><b>${dayLabel(date)}</b><span class="muted small">${n ? `${n}곳 · 꾹 눌러 끌면 순서 바꾸기` : ''}</span></div>
    ${top}<div class="board">${body}</div>${addAreaHtml(n)}`;
}

// 버블 끌기 (보드 위 버블·가볼 곳 버블 공통): 꾹 눌러 들면 다른 버블이 밀려나며 들어갈 자리를 비워 줌.
// 날짜 탭에 잠깐 대면 그 날로 넘어가고, 🗑에 놓으면 지우기
S.bd = null;
const BD_GAP = 10;
const TEXT_OK = 'input, textarea, select, [contenteditable], .prompt, .vwc figcaption, .dt-addr, .selectable'; // 글자 선택·길게 누르기 메뉴를 허용하는 곳
function bdCollect() {
  return { slots: [...document.querySelectorAll('#timeline .bslot')].map(el => ({ el, i: +el.dataset.i, r: el.getBoundingClientRect() })), scroll0: $('#listView').scrollTop };
}
function bdStart(o) { // o: { kind: 'item' | 'wish', i, fav, from(누른 버블), card(가볼 곳 버블), x, y }
  getSelection()?.removeAllRanges(); // 혹시 잡힌 글자 선택은 풀고 시작
  const c = bdCollect();
  const me = o.kind === 'item' ? c.slots.find(x => x.i === o.i) : null;
  const H = (me ? me.el.querySelector('.bubble').offsetHeight : (c.slots[0]?.el.querySelector('.bubble').offsetHeight || 52)) + BD_GAP;
  const ghost = document.createElement('div');
  ghost.className = 'bubble bub-ghost';
  ghost.innerHTML = o.from.innerHTML;
  ghost.style.setProperty('--c', o.from.style.getPropertyValue('--c') || 'var(--accent)');
  document.body.append(ghost);
  S.bd = { ...o, srcDate: S.selected, ...c, me, H, ghost, w: ghost.offsetWidth, h: ghost.offsetHeight, target: null, spring: null };
  me?.el.classList.add('lifted');
  o.card?.classList.add('lifted');
  $('#dragTrash')?.classList.add('show');
  $('#favTray')?.classList.add('folded'); // 서랍은 접어서 보드 전체를 놓을 자리로
  navigator.vibrate?.(30);
  bdMove(o.x, o.y);
  S.bd.raf = requestAnimationFrame(bdScroll);
}
const bdRest = g => g.slots.filter(x => x !== g.me);
// 손가락 높이 → 몇 번째 자리 (보이는 버블 기준)
function bdIndex(g, y) {
  const dS = $('#listView').scrollTop - g.scroll0, rest = bdRest(g);
  for (let k = 0; k < rest.length; k++) {
    const x = rest[k], top = x.r.top - dS - (g.me && x.i > g.me.i ? g.H : 0);
    if (y < top + x.r.height / 2) return k;
  }
  return rest.length;
}
// 들어갈 자리 아래 버블은 내려가고, 든 버블 자리는 위로 메워짐
function bdShift(g, k) {
  for (const [j, x] of bdRest(g).entries()) {
    const dy = k == null ? 0 : (g.me && x.i > g.me.i ? -g.H : 0) + (j >= k ? g.H : 0);
    x.el.style.transform = dy ? `translateY(${dy}px)` : '';
  }
  $('#timeline .board')?.classList.toggle('drop-in', k != null && !bdRest(g).length);
}
function bdMove(x, y) {
  const g = S.bd;
  if (!g) return;
  g.x = x; g.y = y;
  document.querySelectorAll('#dayTabs .drop-tab').forEach(e => e.classList.remove('drop-tab'));
  const trash = $('#dragTrash'), tb = trash?.getBoundingClientRect();
  const overTrash = !!tb && x >= tb.left - 20 && x <= tb.right + 20 && y >= tb.top - 20 && y <= tb.bottom + 20;
  trash?.classList.toggle('hot', overTrash);
  let t = null;
  if (overTrash) t = { trash: true };
  else {
    const tab = document.elementsFromPoint(x, y).find(e => e.matches?.('#dayTabs [data-date]'));
    if (tab) { t = { date: tab.dataset.date, tab }; tab.classList.add('drop-tab'); }
    else if (topLayer() === 'list') {
      const lv = $('#listView').getBoundingClientRect(), trayTop = $('#favTray')?.getBoundingClientRect().top ?? innerHeight;
      if (y > lv.top && y < Math.min(lv.bottom, trayTop)) {
        let k = bdIndex(g, y);
        const first = bdRest(g)[0], d = curDay();
        if (k === 0 && first && d?.items[first.i]?.auto && !(g.kind === 'item' && g.srcDate === S.selected && d.items[g.i]?.auto)) k = 1; // 출발지(숙소) 앞에는 못 넣음
        t = { index: k };
      }
    }
  }
  // 날짜 탭에 0.45초 대고 있으면 그 날 보드로 (손가락은 그대로 끌면서 자리 고르기)
  if (t?.date && t.date !== S.selected) {
    if (g.spring?.date !== t.date) { clearTimeout(g.spring?.timer); const date = t.date; g.spring = { date, timer: setTimeout(() => bdSwitchDay(date), 450) }; }
  } else if (g.spring) { clearTimeout(g.spring.timer); g.spring = null; }
  g.target = t;
  bdShift(g, t?.index ?? null);
  // 날짜 탭 위에선 버블이 작아지며 그 날짜에 쏙 붙음 (그 날에 들어간다는 표시), 못 놓는 곳에선 흐리게
  if (t?.date) {
    const r = t.tab.getBoundingClientRect();
    g.ghost.style.transform = `translate(${r.left + r.width / 2 - g.w / 2}px, ${r.top + r.height / 2 - g.h / 2}px) scale(.55)`;
  } else g.ghost.style.transform = `translate(${x - g.w / 2}px, ${y - g.h - 30}px)`;
  g.ghost.classList.toggle('on-tab', !!t?.date);
  g.ghost.classList.toggle('nodrop', !t);
  bdLoupe(g, t);
}
// 날짜 탭 위에선 그 날짜를 손가락 위로 크게 띄워 보여 줌 (키보드 글자 미리보기처럼): 손가락에 탭이 가려도 어느 날인지 바로 확인
function bdLoupe(g, t) {
  let el = $('#tabLoupe');
  if (!t?.date) { if (el) el.hidden = true; g.loupe = null; return; }
  if (!el) { el = document.createElement('div'); el.id = 'tabLoupe'; document.body.append(el); }
  if (g.loupe !== t.date) {
    g.loupe = t.date;
    el.textContent = `${dayLabel(t.date)}${t.date === todayStr() ? ' · 오늘' : ''}`;
    el.hidden = false;
    el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
    navigator.vibrate?.(8); // 날짜가 바뀔 때마다 톡
  }
  const r = t.tab.getBoundingClientRect(), w = el.offsetWidth, h = el.offsetHeight, cx = r.left + r.width / 2;
  const left = Math.max(8, Math.min(innerWidth - w - 8, cx - w / 2));
  el.style.left = `${left}px`;
  el.style.top = `${Math.max(4, r.top - h - 10)}px`;
  el.style.setProperty('--ax', `${cx - left}px`); // 꼬리는 탭 가운데를 가리킴
}
function bdSwitchDay(date) {
  const g = S.bd;
  if (!g) return;
  g.spring = null;
  // 누르고 있는 버블이 다시 그려지며 사라지면 손가락 움직임을 못 받으니, 안 보이는 곳에 옮겨 둠
  if (g.from && $('#timeline').contains(g.from)) { g.holder = document.createElement('div'); g.holder.hidden = true; g.holder.append(g.from); document.body.append(g.holder); }
  g.switching = true;
  selectDay(date, true);
  g.switching = false;
  navigator.vibrate?.(15);
  Object.assign(g, bdCollect());
  g.me = g.kind === 'item' && g.srcDate === S.selected ? g.slots.find(x => x.i === g.i) : null;
  g.me?.el.classList.add('lifted');
  bdMove(g.x, g.y);
}
function bdScroll() {
  const g = S.bd;
  if (!g) return;
  const sc = $('#listView'), r = sc.getBoundingClientRect(), bottom = Math.min(r.bottom, $('#favTray')?.getBoundingClientRect().top ?? innerHeight);
  if (g.y > r.top && g.y < r.top + 56) { sc.scrollBy(0, -8); bdMove(g.x, g.y); }
  else if (g.y > bottom - 56 && g.y < bottom) { sc.scrollBy(0, 8); bdMove(g.x, g.y); }
  // 날짜 탭 줄의 왼쪽·오른쪽 끝에 대고 있으면 탭이 옆으로 넘어감 (화면 밖 날짜로 옮길 때)
  const tabs = $('#dayTabs'), tb = tabs && !tabs.hidden ? tabs.getBoundingClientRect() : null;
  if (tb && g.y >= tb.top && g.y <= tb.bottom) {
    if (g.x < tb.left + 40 && tabs.scrollLeft > 0) { tabs.scrollBy(-7, 0); bdMove(g.x, g.y); }
    else if (g.x > tb.right - 40 && tabs.scrollLeft < tabs.scrollWidth - tabs.clientWidth - 1) { tabs.scrollBy(7, 0); bdMove(g.x, g.y); }
  }
  g.raf = requestAnimationFrame(bdScroll);
}
// 보이는 자리(k번째) → 그 날 일정 목록에서 실제로 들어갈 자리 (옮기는 일정은 뺀 목록 기준)
function bdItemIndex(g, k, list) {
  const d = curDay(), rest = bdRest(g);
  if (!d || !rest.length) return list.length;
  if (k < rest.length) return Math.max(0, list.indexOf(d.items[rest[k].i]));
  return list.indexOf(d.items[rest.at(-1).i]) + 1;
}
function bdEnd(cancel) {
  const g = S.bd;
  if (!g) return;
  S.bd = null;
  clearTimeout(g.spring?.timer); cancelAnimationFrame(g.raf);
  g.ghost.remove(); g.holder?.remove(); g.card?.classList.remove('lifted');
  document.querySelectorAll('#dayTabs .drop-tab').forEach(e => e.classList.remove('drop-tab'));
  $('#dragTrash')?.classList.remove('show', 'hot');
  $('#favTray')?.classList.remove('folded');
  if ($('#tabLoupe')) $('#tabLoupe').hidden = true;
  S.dragJustEnded = Date.now();
  const t = cancel ? null : g.target;
  const reset = () => { bdShift(g, null); g.me?.el.classList.remove('lifted'); };
  if (!t || (t.date && t.date === g.srcDate && g.kind === 'item')) { reset(); return; }
  const keepStart = (list, at) => (at === 0 && list[0]?.auto ? 1 : at); // 자동으로 넣은 출발지(숙소) 앞에는 넣지 않음
  if (g.kind === 'wish') {
    reset();
    if (t.trash) removeWish(g.fav);
    else if (t.date) { placeNew(t.date, null, g.fav); tabPop(t.date); }
    else { const list = curDay()?.items || []; placeNew(S.selected, keepStart(list, bdItemIndex(g, t.index, list)), g.fav); }
    return;
  }
  const from = S.plan.days.find(x => x.date === g.srcDate), it = from?.items[g.i];
  if (!it) { reset(); return; }
  if (t.trash) { reset(); trashItem(from, g.i); return; }
  if (t.date) { reset(); if (moveItemToDay(g.srcDate, it.id, t.date)) tabPop(t.date); return; }
  const to = ensureDay(S.selected), list = to.items.filter(x => x !== it), at = it.auto ? bdItemIndex(g, t.index, list) : keepStart(list, bdItemIndex(g, t.index, list));
  list.splice(at, 0, it);
  if (to === from && list.every((x, k) => x === from.items[k])) { reset(); return; } // 제자리
  if (to !== from) {
    from.items = from.items.filter(x => x !== it);
    delete progOf(g.srcDate)[it.id];
    if (!from.items.length) S.plan.days = S.plan.days.filter(x => x !== from);
  }
  to.items = list;
  savePlan(); saveProgress(); recompute(); renderAll(false); prefetchLegs(); scheduleAlarms();
  const b = $(`#timeline .bslot[data-i="${at}"] .bubble`);
  if (b) { b.classList.add('flash'); b.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  toast(to === from ? `${it.place} → ${at + 1}번째` : `${it.place} → ${dayLabel(to.date)} ${at + 1}번째`);
}
function setupBoardDrag() {
  const tl = $('#timeline');
  let press = null;
  tl.addEventListener('pointerdown', e => {
    const b = e.target.closest('.bslot .bubble');
    if (!b || S.bd || e.target.closest('button')) return;
    const i = +b.closest('.bslot').dataset.i, id = e.pointerId;
    press = { x: e.clientX, y: e.clientY, timer: setTimeout(() => {
      press = null;
      try { b.setPointerCapture(id); } catch { /* 일부 브라우저 */ }
      bdStart({ kind: 'item', i, from: b, x: e.clientX, y: e.clientY });
    }, 350) };
  });
  tl.addEventListener('pointermove', e => { if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) { clearTimeout(press.timer); press = null; } });
  const stop = () => { if (press) { clearTimeout(press.timer); press = null; } };
  tl.addEventListener('pointerup', stop);
  tl.addEventListener('pointercancel', stop);
  tl.addEventListener('contextmenu', e => { if (S.bd || press) e.preventDefault(); });
  // 끄는 중의 움직임·놓기는 화면 어디서든 (날짜가 바뀌어 보드가 다시 그려져도)
  window.addEventListener('pointermove', e => { if (S.bd) bdMove(e.clientX, e.clientY); });
  window.addEventListener('pointerup', () => bdEnd());
  window.addEventListener('pointercancel', () => bdEnd(true));
  window.addEventListener('touchmove', e => { if (S.bd && e.cancelable) e.preventDefault(); }, { passive: false });
}
function tabPop(date) {
  const tab = document.querySelector(`#dayTabs [data-date="${date}"]`);
  if (!tab) return;
  tab.classList.remove('got'); void tab.offsetWidth; tab.classList.add('got');
  setTimeout(() => tab.classList.remove('got'), 700);
}
// 지도에서 꾹 누른 곳: 핀과 [🫧 버블 만들기] 말풍선. 이름·주소는 무료 지도로 찾아서 미리 채움
async function mapHold(ll) {
  if (topLayer() !== 'map' || S.pick || S.sheet) return;
  navigator.vibrate?.(25);
  const dr = S.drop = { lat: ll.lat, lng: ll.lng, x: ll.x, y: ll.y, name: '', address: '', busy: true };
  renderDrop(); renderMap(false);
  try {
    const r = await reverseFree(ll.lat, ll.lng);
    if (r) Object.assign(dr, { name: r.name, address: r.address, kind: r.kind });
  } catch { /* 이름 없이도 만들 수 있음 */ }
  dr.busy = false;
  if (S.drop === dr) renderDrop();
}
const shortAddr = a => (a || '').split(',').map(x => x.trim()).filter(Boolean).slice(0, 3).join(', ');
function renderDrop() {
  let el = $('#mapDrop');
  if (!S.drop) { el?.remove(); return; }
  if (!el) { el = document.createElement('div'); el.id = 'mapDrop'; el.className = 'map-drop'; $('#mapView').append(el); }
  const dr = S.drop, half = 120;
  el.style.left = `${Math.max(half + 8, Math.min(dr.x, $('#mapView').clientWidth - half - 8))}px`;
  el.style.top = `${dr.y}px`;
  el.innerHTML = `<div class="md-name">${dr.busy ? '<span class="muted">어디인지 찾는 중…</span>' : esc(dr.name || shortAddr(dr.address) || '이 위치')}</div>
    <div class="md-btns"><button class="md-make" data-act="dropMake">🫧 버블 만들기</button><button class="md-x" data-act="dropClose" aria-label="닫기">✕</button></div>`;
}
function clearDrop() {
  if (!S.drop) return;
  S.drop = null;
  renderDrop(); renderMap(false);
}
function openBubbleMaker(base) {
  S.sheet = { type: 'bubble', name: base.name || '', address: base.address || '', lat: base.lat, lng: base.lng, cat: base.name ? guessCat(base.name, base.kind) : 'etc', catTouched: false };
  renderSheet(); renderMap(false);
  setTimeout(() => { const t = $('#bubName'); t?.focus(); t?.select(); }, 300);
}
function bubbleHtml(sh) {
  const c = catOf(sh.cat);
  return `<div class="sheet-head"><div><div class="st-label">지도에서 고른 곳</div><b>🫧 버블 만들기</b></div><button class="x" data-act="closeSheet">✕</button></div>
    <div class="bub-stage"><div class="bub big cat-${sh.cat}" id="bubPrev"><span class="bub-ic">${c.icon}</span><b>${esc(sh.name) || '버블 이름'}</b></div></div>
    ${sh.address ? `<div class="muted small bub-addr">📍 ${esc(shortAddr(sh.address))}</div>` : ''}
    <label class="field">버블 이름<input id="bubName" value="${esc(sh.name)}" placeholder="예: 숙소 앞 빵집" enterkeyhint="done" autocomplete="off"></label>
    <div class="chips bub-cats">${FAV_CATS.map(x => `<button class="chip-btn ${x.id === sh.cat ? 'on' : ''}" data-act="bubCat" data-cat="${x.id}">${x.icon} ${x.label}</button>`).join('')}</div>
    <button class="primary bub-go" data-act="bubMake">🫧 버블 만들기</button>`;
}
// 이름을 적는 대로 위 버블 미리보기가 바뀌고, 종류도 이름으로 짐작 (직접 고르면 그대로)
function bubbleTyped(v) {
  const sh = S.sheet;
  if (sh?.type !== 'bubble') return;
  sh.name = v;
  if (!sh.catTouched) sh.cat = guessCat(v);
  const c = catOf(sh.cat), prev = $('#bubPrev');
  if (prev) { prev.className = `bub big cat-${sh.cat}`; prev.innerHTML = `<span class="bub-ic">${c.icon}</span><b>${esc(v.trim()) || '버블 이름'}</b>`; }
  document.querySelectorAll('.bub-cats [data-cat]').forEach(b => b.classList.toggle('on', b.dataset.cat === sh.cat));
}
function makeBubble() {
  const sh = S.sheet, name = ($('#bubName')?.value || '').trim();
  if (!name) { $('#bubName')?.focus(); toast('버블 이름을 적어 주세요'); return; }
  const ex = findFav(S.favs, { place: name, lat: sh.lat, lng: sh.lng });
  if (ex && hasPos(ex)) { toast(`🫧 ${ex.place} 버블이 이미 있어요`); return; }
  if (ex) Object.assign(ex, { lat: sh.lat, lng: sh.lng, address: sh.address, cat: sh.cat }); // 이름만 적어 둔 버블에 위치를 붙임
  else S.favs.push({ id: newId(), place: name, address: sh.address || '', lat: sh.lat, lng: sh.lng, cat: sh.cat, added: Date.now() });
  saveFavs();
  closeSheet();
  if (S.tray) renderTray();
  navigator.vibrate?.(20);
  toast(`🫧 ${name} 버블을 만들었어요`, 5000, { label: '가볼 곳 보기', fn: () => { if (!S.tray) toggleTray(true); } });
}
function removeWish(fav) {
  S.favs = S.favs.filter(f => f !== fav); saveFavs(); renderTray();
  toast(`🗑 ${fav.place} 가볼 곳에서 뺐어요`, 5000, { label: '되돌리기', fn: () => { S.favs.push(fav); saveFavs(); rerenderKeep(); } });
}

// 식사·여유 시간 추천 칸 (점선)
const gapsHtml = (list, i) => (list || []).map(g => `<div class="suggest-slot ${g.icon ? g.type : ''}" data-act="suggest" data-type="${g.type}" data-k="${i}">
      ${g.icon ? `<span>${g.icon} ${g.label} <span class="muted">· ${g.text}</span></span>`
        : `<span>🍽 ${g.label} 추가 <span class="muted">· ${fmtClock(g.center)} 무렵 · 근처 맛집 추천</span></span>`}
      <button class="suggest-x" data-act="suggestSkip" data-type="${g.skip || g.type}" aria-label="숨기기">✕</button></div>`).join('');

// ---------- 길게 누르면 간략 정보 창 (누른 채 끌면 순서 바꾸기로 이어짐) ----------
function peekHtml(d, i) {
  const it = d.items[i], s = S.cur.sched[i] || {}, l = S.cur.legs[i], n = d.items.length, m = MODES[it.mode];
  const ph = isLive() ? phase(d) : null, state = itemState(d, i, ph), done = state === 'done' || state === 'skip';
  const fixed = isFixedItem(d, i), first = i === 0 && n > 1 && !s.proc;
  const line = (icon, html) => `<div class="pk-line"><span>${icon}</span><span>${html}</span></div>`;
  const lines = [];
  if (done) lines.push(line('✓', state === 'skip' ? '건너뜀' : '다녀왔어요'));
  if (s.proc) lines.push(line('✈️', `${fmtClock(s.arrive)} 착륙 · 입국 절차 약 ${fmtDur(s.proc)}`));
  else if (first) { if (!boardMode()) lines.push(line('🚩', `${fmtClock(s.depart)}쯤 출발`)); } // 버블 보드에선 출발·머무는 시간 없이 예약 시각만
  else if (fixed) lines.push(line('🕒', `<b>${fmtClock(it.time)} 예약</b>`));
  else if (s.arrive != null) lines.push(line('🕒', `${fmtClock(s.arrive)}쯤 도착${i < n - 1 && !boardMode() ? ` · ${fmtClock(s.depart)}쯤 출발` : ''}${it.stay && !boardMode() ? ` <span class="muted">(${fmtDur(it.stay)} 머무름)</span>` : ''}`));
  if (s.late > 0 && !done && !boardMode()) lines.push(line('⚠️', `<span class="late-tag">${fmtDur(s.late)} 늦음</span>`));
  if (i > 0 && l && m) lines.push(line(m.icon, `오는 길 ${fmtDur(l.dur)}${l.dist != null ? ` · ${fmtDist(l.dist)}` : ''} <span class="muted">${m.label}</span>`));
  lines.push(line('📍', it.address ? esc(it.address) : hasPos(it) ? '<span class="muted">지도 위치 있음</span>' : '<span class="late-tag">위치 없음</span>'));
  if (it.memo) lines.push(line('📝', `<span class="pk-memo">${esc(it.memo)}</span>`));
  if (it.files?.length) lines.push(line('📎', `첨부 ${it.files.length}개`));
  return `<div class="pk-card" data-act="peekOpen" data-i="${i}" style="--c:${placeColor(i, state)}">
      <div class="pk-top"><span class="row-num ${i === 0 ? 'sq' : ''}">${done ? '✓' : labelOf(d, i)}</span><b>${esc(it.place)}</b></div>
      <div class="pk-lines">${lines.join('')}</div>
      ${boardMode() ? `<div class="pk-acts">${hasPos(it) ? `<button data-act="nav" data-i="${i}">🧭 길찾기</button>` : `<button data-act="fixPlace" data-i="${i}">📍 위치 고르기</button>`}<button data-act="peekOpen" data-i="${i}">✏️ 자세히</button>${done ? '' : `<button data-act="peekDone" data-i="${i}">✓ 다녀옴</button>`}</div>`
        : '<div class="pk-hint">눌러서 자세히 보기 · 누른 채로 끌면 순서 바꾸기</div>'}
    </div>`;
}
function openPeek(i, row, ready) {
  const d = curDay();
  if (!d?.items[i]) return;
  closePeek();
  const el = document.createElement('div');
  el.className = 'peek';
  el.dataset.act = 'peekClose';
  el.innerHTML = peekHtml(d, i);
  document.body.append(el);
  S.peek = { i, el };
  if (ready) el.classList.add('ready');
  row.classList.add('peeked');
  // 누른 줄 자리에서 커지듯이: 줄 위쪽에 맞추되 화면 밖으로 안 나가게
  const card = el.firstElementChild, r = row.getBoundingClientRect(), h = card.offsetHeight;
  const top = Math.max(12 + (window.visualViewport?.offsetTop || 0), Math.min(r.top - 6, innerHeight - h - 16));
  card.style.top = `${top}px`;
  card.style.transformOrigin = `50% ${Math.round(r.top + r.height / 2 - top)}px`;
  navigator.vibrate?.(15);
}
function closePeek() {
  if (!S.peek) return;
  S.peek.el.remove();
  document.querySelectorAll('.peeked').forEach(r => r.classList.remove('peeked'));
  S.peek = null;
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
    // 자유 일정은 원래 시간 제한이 없으니, 바로 다음이 예약이라 시간이 남을 때만 "여유 시간" 추천
    if (s.arrive == null || !(s.stayEff >= FREE_MIN) || isHotel(it.place) || skip[`free-${it.id}`] || !isFixedItem(d, nextStopIdx(d, i))) continue;
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
  const prev = d.items[i - 1], l = legs[i], m = MODES[it.mode], bm = boardMode();
  const warns = [];
  if (s.late) warns.push(`예약 시각보다 ${s.late}분 늦어요`);
  el.innerHTML = `<div class="dt-scroll">
    <div class="dt-hero" style="--c:${color}">
      <div class="dt-kicker"><span class="dt-num ${i === 0 ? 'sq' : ''}">${state === 'done' ? '✓' : labelOf(d, i)}</span>${dayLabel(d.date)} · ${i + 1}/${n}번째</div>
      <h1>${esc(it.place)}</h1>
      ${stateTag ? `<span class="dt-state ${state}">${stateTag}</span>` : ''}
      ${it.address ? `<div class="dt-addr">${esc(it.address)}</div>` : ''}
    </div>
    ${i === 0 && n > 1 && !s.proc
      ? bm ? '' : `<div class="dt-times one"><div><span>출발지</span><b>${fmtClock(s.depart)}쯤 출발</b>${p.dep ? `<em>실제 ${clockAt(p.dep, d.date)} 출발</em>` : ''}</div></div>`
      : !isFixedItem(d, i) && !s.proc
      ? (() => { const jf = nextFixedIdx(d, i + 1);
          return `<div class="dt-times one"><div><span>자유 일정 · 순서대로</span><b>${jf >= 0 ? `${esc(d.items[jf].place)} ${fmtClock(d.items[jf].time)} 예약 전까지` : '시간 제한 없이'}</b>${jf >= 0 && !bm ? `<em>늦어도 ${clockAt(latestDepMs(d, jf), d.date)} 출발</em>` : ''}${p.arr ? `<em>실제 ${clockAt(p.arr, d.date)} 도착</em>` : ''}</div></div>`; })()
      : bm ? `<div class="dt-times one"><div><span>${s.proc ? '착륙' : '예약'}</span><b>${fmtClock(s.proc ? s.arrive : it.time)}</b>${p.arr ? `<em>실제 ${clockAt(p.arr, d.date)} 도착</em>` : ''}</div></div>`
      : `<div class="dt-times">
      <div><span>도착</span><b>${s.arrive != null ? fmtClock(s.arrive) : '—'}</b>${p.arr ? `<em>실제 ${clockAt(p.arr, d.date)}</em>` : ''}</div>
      <div><span>여유</span><b>${free ? fmtDur(free) : '—'}</b></div>
      <div><span>출발</span><b>${i < n - 1 ? fmtClock(s.depart) : '—'}</b>${p.dep ? `<em>실제 ${clockAt(p.dep, d.date)}</em>` : ''}</div>
    </div>`}
    ${warns.map(w => `<div class="dt-warn">⚠ ${esc(w)}</div>`).join('')}
    ${hasPos(it) ? '' : `<button class="dt-warn fix" data-act="fixPlace" data-i="${i}">⚠ 위치를 찾지 못했어요 · <u>눌러서 지도에서 찾기</u></button>`}
    <div class="dt-card"><div class="dt-dist" data-dist="${i}">📍 내 위치를 확인하는 중…</div></div>
    ${i > 0 ? `<div class="dt-card">
      <div class="note-label">가는 방법 · ${esc(prevStop(d, i).place)}에서</div>
      <div class="dt-leg">${m.icon} <b>${m.label} ${fmtDur(l.dur)}</b>${l.dist != null ? ` · ${fmtDist(l.dist)}` : ''}${l.est ? '<span class="est">추정</span>' : ''}</div>
      ${it.mode === 'TRANSIT' ? rideOptionsHtml(l, d.date) : ''}
      <div class="st-actions"><button class="primary" data-act="nav" data-i="${i}">🗺️ 길찾기</button></div>
    </div>` : ''}
    ${(it.notes || []).length || it.memo ? `<div class="dt-card">${notesHtml(it, i)}</div>` : ''}
    <div class="dt-card">
      <div class="note-label">📎 첨부 파일 <span class="muted small">· 바우처, 예약 티켓 사진이나 PDF</span></div>
      <div class="att-grid" data-att="${i}"></div>
      <button class="chip-btn" data-act="attach" data-i="${i}">＋ 사진·파일 첨부</button>
    </div>
    <div class="dt-card dt-acts">
      <button data-act="editPlace" data-i="${i}">✏️ 수정</button>
      ${hasPos(it) ? `<button data-act="favToggle" data-i="${i}">${isFav(it) ? '🫧 버블 있음' : '🫧 버블 만들기'}</button>` : ''}
      <button data-act="addPlace" data-i="${i + 1}">＋ 이 장소 뒤에 일정 넣기</button>
      ${i > 0 ? `<button data-act="moveUp" data-i="${i}">↑ 순서 앞으로</button>` : ''}
      ${i < n - 1 ? `<button data-act="moveDown" data-i="${i}">↓ 순서 뒤로</button>` : ''}
      ${isLive() && i > 0 ? `<button data-act="arrive" data-i="${i}">도착 처리</button>` : ''}
      ${isLive() && i < n - 1 ? `<button data-act="depart" data-i="${i}">출발 처리</button>` : ''}
      ${isLive() ? `<button data-act="doneUpTo" data-i="${i}">✅ 여기까지 끝났어요</button>` : ''}
      ${p.arr || p.dep || p.skip || p.pass ? `<button data-act="clear" data-i="${i}">기록 지우기</button>` : ''}
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
  S.viewer = { i, k, key: f.id };
  const el = $('#viewer'), n = it.files.length;
  el.hidden = false;
  el.innerHTML = `<div class="vw-top">
      <button class="vw-btn" data-act="closeViewer" aria-label="닫기">✕</button>
      <div class="vw-title"><b>${esc(f.name)}</b><span>${esc(it.place)}${n > 1 ? ` · ${k + 1}/${n}` : ''}</span></div>
      <button class="vw-btn" data-act="delFile" aria-label="첨부 삭제">🗑</button>
    </div>
    <div class="vw-body"><div class="muted pad">불러오는 중…</div></div>${vwTools()}
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
  scanCodes(f.id, [...body.querySelectorAll('img, canvas')]);
}

// 크게 보기 아래 도구: 축소·배율·확대, QR·바코드가 있으면 그것만 크게 보기
const vwTools = () => `<div class="vw-tools">
    <button class="vw-btn" data-act="vwZoom" data-z="-1" aria-label="축소">−</button>
    <button class="vw-zl" data-act="vwZoom" data-z="0" aria-label="원래 크기">100%</button>
    <button class="vw-btn" data-act="vwZoom" data-z="1" aria-label="확대">+</button>
    <button class="vw-code" data-act="vwCodes" hidden></button>
  </div>`;

// 확대·축소: 두 손가락 벌리기, 두 번 톡, +/− 버튼, (컴퓨터) Ctrl+휠. 확대하면 끌어서 이리저리 보기
const ZMAX = 6;
const vwBody = () => $('#viewer .vw-body');
const zoomEls = b => [...b.querySelectorAll(':scope > img, :scope > canvas')];
function setZoom(z, fx, fy) {
  const v = S.viewer, b = vwBody();
  if (!v || !b || !zoomEls(b).length) return;
  z = Math.min(ZMAX, Math.max(1, z));
  if (Math.abs(z - 1) < 0.04) z = 1;
  const old = v.z || 1, r = b.getBoundingClientRect();
  fx ??= r.width / 2; fy ??= r.height / 2; // 손가락(또는 화면 가운데) 아래 지점을 그대로 둔 채 키움
  const cx = (b.scrollLeft + fx) / old, cy = (b.scrollTop + fy) / old;
  if (old === 1) for (const el of zoomEls(b)) el.dataset.bw = el.getBoundingClientRect().width;
  v.z = z;
  b.classList.toggle('zoomed', z > 1);
  for (const el of zoomEls(b)) el.style.width = z > 1 ? `${el.dataset.bw * z}px` : '';
  b.scrollLeft = cx * z - fx; b.scrollTop = cy * z - fy;
  const zl = $('#viewer .vw-zl');
  if (zl) zl.textContent = `${Math.round(z * 100)}%`;
}

// 첨부 속 QR·바코드 찾기 (한 번 찾은 건 기억). 찾으면 "크게" 버튼이 나타남
const codeCache = new Map();
async function scanCodes(key, srcs) {
  let found = codeCache.get(key);
  if (!found) {
    found = [];
    for (const s of srcs) {
      if (s.tagName === 'IMG') await s.decode?.().catch(() => {});
      found.push(...await findCodes(s).catch(() => []));
    }
    codeCache.set(key, found);
    if (codeCache.size > 30) codeCache.delete(codeCache.keys().next().value);
  }
  if (S.viewer?.key !== key) return;
  S.viewer.codes = found;
  const btn = $('#viewer [data-act="vwCodes"]');
  if (!btn || !found.length) return;
  const names = [...new Set(found.map(c => codeName(c.format)))].join('·');
  btn.textContent = `🔳 ${names} 크게${found.length > 1 ? ` (${found.length})` : ''}`;
  btn.hidden = false;
}

function showCodes() {
  const v = S.viewer;
  if (!v?.codes?.length) return;
  v.codesOn = true;
  const names = [...new Set(v.codes.map(c => codeName(c.format)))].join('·');
  const box = document.createElement('div');
  box.className = 'vw-codes';
  box.innerHTML = `<div class="vw-top"><button class="vw-btn" data-act="vwCodesOff" aria-label="원래대로">‹</button>
      <div class="vw-title"><b>${names}</b><span>화면 밝기를 최대로 올리면 더 잘 찍혀요</span></div></div>
    <div class="vwc-list">${v.codes.map(c => `<figure class="vwc ${c.two ? 'sq' : 'bar'}"><img src="${c.url}" alt="${esc(codeName(c.format))}">
      ${c.text ? `<figcaption>${esc(c.text)}</figcaption>` : ''}</figure>`).join('')}</div>`;
  $('#viewer').append(box);
}
function hideCodes() {
  if (S.viewer) S.viewer.codesOn = false;
  $('#viewer .vw-codes')?.remove();
}

function closeViewer() {
  S.viewer = null;
  $('#viewer').hidden = true;
  $('#viewer').innerHTML = '';
  freeUrls();
  if (topLayer() === 'detail') fillAttachments(S.detail);
  if (S.sheet?.type === 'keep') renderSheet(); // 작은 사진을 다시 채움
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
  document.querySelectorAll('#timeline [data-bd]').forEach(el => { const it = d.items[+el.dataset.bd]; if (it) el.textContent = bubDist(it); });
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
  const bp = S.drop || (S.sheet?.type === 'bubble' ? S.sheet : null); // 꾹 눌러 버블을 만드는 중인 곳
  if (bp) places.push({ lat: bp.lat, lng: bp.lng, label: '＋', color: '#3a5470', ring: true, z: 21, title: bp.name || '이 위치' });
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
    lines.push({ path: [prevStop(d, i), it], dashed: true, ...style, width: focus ? 4 : 3 }); // 경로는 지도 앱에서: 여기선 순서만 직선으로
  });
  const sh = S.sheet;
  if (sh?.type === 'edit' && hasPos(sh.draft)) {
    const prev = sh.trip ? originOf(sh) : d?.items[sh.index - 1];
    if (hasPos(prev) && !sh.id) lines.push({ path: [prev, sh.draft], color: '#fdd835', dashed: true, width: 3 });
  }
  const poiFrom = S.poi && d?.items[S.poi.from];
  if (hasPos(poiFrom)) lines.push({ path: [poiFrom, S.poi], color: '#ff7043', dashed: true, width: 3, z: 7 });
  if (S.live && S.pos) lines.push({ path: [S.pos, S.live.to], color: '#1a73e8', dashed: true, width: 4, opacity: 1, z: 9 }); // 내 위치 → 목적지
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
      html = `<div class="muted small">이동 중 · 파란 선을 따라가세요</div><b>${esc(it.place)}</b> · ${fmtDist(dist)} · 약 ${fmtDur(est)} · ${clockAt(eta, d.date)} 도착`;
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
  if (top !== 'map' && S.drop) { S.drop = null; renderDrop(); }
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
// 처음 화면이 아니면 뒤로 가기로 처음 화면에 돌아올 수 있음
const canGoBack = () => !$('#alarm').hidden || !!S.peek || !!S.drop || !!S.viewer || S.pick || !!S.sheet || S.stack.length > 1 || S.dayBack.length > 0
  || !S.home || (S.home.step !== 'kind' && S.home.step !== 'done') || S.home.fromDone;

// 휴대폰 뒤로 가기: 바로 전 화면으로. 첫 화면이면 종료할지 물어봄 (앱에서만)
function goBack() {
  if (!$('#alarm').hidden) { dismissAlarm(); return; }
  if (S.peek) { closePeek(); return; }
  if (S.drop) { clearDrop(); return; }
  if (S.viewer) { if (S.viewer.codesOn) hideCodes(); else closeViewer(); return; }
  if (S.memMap) { closeMemMap(); return; }
  if (S.pick) { finishPick(); return; }
  if (S.sheet) { closeSheet(); return; }
  if (S.home) {
    if (homeBack()) return;
    if (isNative) { S.sheet = { type: 'exit' }; renderSheet(); }
    return;
  }
  if (S.tray) { toggleTray(false); return; }
  if (S.stack.length > 1) { popLayer(); return; }
  if (S.dayBack.length) { selectDay(S.dayBack.pop(), true, true); return; }
  openHome();
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

// 🧪 시험용: 모든 일정 초기화 (버블·추억은 남김). 누르면 무엇이 지워지는지 먼저 보여 주고 한 번 더 확인
function resetHtml() {
  const days = S.plan.days.filter(d => d.items.length), n = days.reduce((a, d) => a + d.items.length, 0);
  const files = S.plan.days.reduce((a, d) => a + d.items.reduce((b, it) => b + (it.files?.length || 0), 0), 0);
  return `<div class="exit-box"><div class="exit-icon">⚠️</div><b>모든 일정을 지울까요?</b>
    <div class="reset-warn">${n ? `<b>${esc(S.plan.title || '내 여행')}</b> · ${days.length}일 · 장소 ${n}곳${files ? ` · 첨부 파일 ${files}개` : ''}` : '여행 날짜·설정한 여행'}과 진행 기록이 모두 지워지고 처음 화면으로 돌아가요.<br><b>되돌릴 수 없어요.</b></div>
    <div class="muted small">🫧 버블과 📸 추억은 그대로 남아요.</div>
    <div class="st-actions"><button class="danger-fill" data-act="resetAll">모두 지우기</button><button data-act="closeSheet">취소</button></div></div>`;
}
function resetAll() {
  for (const d of S.plan.days) for (const it of d.items) (it.files || []).forEach(f => deleteFile(f.id).catch(() => {}));
  S.plan = emptyPlan(); S.progress = {}; S.rest = null; S.snooze = []; S.dayBack = [];
  savePlan(); saveProgress(); saveRest();
  closeSheet(); selectDay(todayStr(), false);
  if (S.tray) renderTray();
  openHome();
  toast('🗑 모든 일정을 지웠어요');
}

function exitHtml() {
  return `<div class="exit-box"><div class="exit-icon">🧳</div><b>트립플립을 종료할까요?</b>
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
// undo: { label, fn } 주면 알림 안에 버튼(예: 되돌리기)을 붙임
// 알림은 맨 아래 꽉 찬 한 줄 띠: 글자 부분은 손가락이 그냥 지나가서 밑의 버블·버튼을 바로 누를 수 있고, [되돌리기] 같은 버튼만 눌림
function toast(msg, ms = 3000, undo = null) {
  const el = $('#toast'), t = document.createElement('span');
  t.className = 'toast-msg'; t.textContent = msg;
  el.replaceChildren(t); el.hidden = false;
  if (undo) {
    const b = document.createElement('button');
    b.className = 'toast-btn'; b.textContent = undo.label;
    b.onclick = e => { e.stopPropagation(); el.hidden = true; undo.fn(); };
    el.append(b);
  }
  el.classList.remove('fit');
  if (t.scrollWidth > t.clientWidth) el.classList.add('fit'); // 한 줄에 안 들어가면 글씨를 조금 작게 (그래도 길면 … 으로)
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

// ---------- 도착/출발 기록 ----------
function changed() {
  saveProgress();
  syncMemories(); // 도착하면 추억에도 담아 둠 (일정·기록을 지워도 남게)
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
    else if (!p) prog[it.id] = { pass: true }; // 기록 없는 앞 장소는 지나온 것으로 (들렀는데 감지를 못 했을 수 있음)
  });
  prog[d.items[i].id] = { arr: ts };
  changed();
}

// "여기까지 끝났어요": i번까지 모두 끝난 것으로, 다음 장소는 지금 출발 기준으로 다시 계산
function markDoneUpTo(d, i) {
  const prog = progOf(d.date), snap = JSON.stringify(prog), now = Date.now();
  d.items.forEach((it, j) => {
    if (j > i) return;
    const p = prog[it.id];
    if (p?.skip) return;
    if (p?.arr && !p.dep) p.dep = now;
    else if (!p || !(p.arr || p.dep || p.pass)) prog[it.id] = { pass: true };
  });
  changed();
  toast(`✅ ${d.items[i].place}까지 끝난 것으로 했어요`, 6000, undoProg(d, snap));
}
const undoProg = (d, snap) => ({ label: '되돌리기', fn: () => { S.progress[d.date] = JSON.parse(snap); changed(); toast('되돌렸어요'); } });

// 이 날 진행 초기화: 도착·출발·건너뜀 기록과 쉬기를 모두 지우고 처음부터 (일정 자체는 그대로)
function resetDay(d) {
  if (!confirm(`${dayLabel(d.date)} 진행 기록(도착·출발·건너뜀)을 모두 지우고 처음부터 다시 할까요?
일정은 그대로 남아요.`)) return;
  const snap = JSON.stringify(progOf(d.date));
  S.progress[d.date] = {};
  if (S.rest?.date === d.date) { S.rest = null; saveRest(); }
  closeSheet();
  changed();
  toast('🔄 진행 기록을 초기화했어요', 6000, undoProg(d, snap));
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
  // 실내(숙소·식당)에서는 와이파이·기지국 위치라 오차가 수백 m인 경우가 많음 → 그래도 도착은 알아채게
  // (오차가 1.5km 넘는 아주 대략적인 위치만 무시)
  if (!d || !S.pos || !isLive() || (S.pos.acc ?? 0) > 1500) return;
  const r = S.settings.radius, prog = progOf(d.date), n = d.items.length, acc = S.pos.acc ?? 0;
  // 자동 도착은 엄격하게: 핀에서 반경(기본 50m) 안 + 위치 오차 75m 이하일 때만
  // (실내처럼 부정확하면 자동으로 하지 않고 카드에서 "도착하셨나요?"를 물어봄 → askArrive)
  const arriveTol = acc <= 75 ? r : -1;
  let last = -1;
  d.items.forEach((it, i) => { const p = prog[it.id]; if (p && (p.arr || p.dep || p.skip || p.pass)) last = i; });
  const here = d.items.findIndex(it => prog[it.id]?.arr && !prog[it.id]?.dep);
  for (let i = last + 1; i < n; i++) {
    const it = d.items[i];
    // 낮에 숙소로 돌아와 쉬는데 "저녁 숙소 도착"으로 착각해 중간 일정을 다 건너뛰지 않게:
    // 바로 다음 장소이거나, 도착 예정이 90분 안쪽인 장소만 자동 도착 처리
    const soon = i === last + 1 || atMs(d.date, S.cur.sched[i]?.arrive ?? S.cur.sched[i]?.depart ?? 0) - Date.now() < 90 * 60000;
    if (soon && hasPos(it) && haversine(S.pos, it) <= arriveTol) {
      markArrive(d, i);
      toast(`📍 ${it.place} 도착 (${clockAt(Date.now(), d.date)})`);
      return;
    }
  }
  if (here >= 0 && here < n - 1) {
    const it = d.items[here];
    // 출발은 위치가 정확할 때만 (실내에서 위치가 튀어서 "출발"로 잘못 처리되지 않게)
    if (acc <= 300 && hasPos(it) && haversine(S.pos, it) > Math.max(r * 1.5, r + 50, acc)) {
      markDepart(d, here);
      toast(`🚶 ${it.place} 출발 (${clockAt(Date.now(), d.date)})`);
    }
  }
}

// 이동 중이면 내 위치에서 다음 장소까지 실제 길을 받아 파란 선으로. 길에서 벗어나거나 1분 지나면 다시 받음
async function updateLiveRoute(force) {
  const d = curDay(), ph = d && isLive() ? phase(d) : null;
  const target = ph?.type === 'move' ? d.items[ph.i] : null;
  if (!target || !hasPos(target) || !S.pos) {
    if (S.live) { S.live = null; drawLines(); }
    return;
  }
  // 이동 중 경로는 앱에서 따로 계산하지 않음 (지도 앱에서 고른 경로를 따라가면 됨). 지도에는 내 위치 → 목적지 직선만
  if (S.live?.id !== target.id) S.live = { id: target.id, to: target };
  drawLines();
}

function onPos(p) {
  S.pos = p;
  // 다음에 켤 때 바로 쓰도록 마지막 위치 기억 (1분에 한 번만 저장)
  if (!p.saved && Date.now() - (onPos.savedAt || 0) > 60000) { onPos.savedAt = Date.now(); store.set('tg.pos', p); }
  S.map?.setMe(p);
  if (S.follow) S.map?.panTo(p);
  if (isLive()) detect();
  // 이동 중 안내(내릴 역 등)를 위치가 바뀔 때마다 갱신 (5초에 한 번까지)
  if (isLive() && Date.now() - (onPos.shown || 0) > 5000) { onPos.shown = Date.now(); renderStatus(); }
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

// 경로 저장: 대표 경로 + (대중교통이면) 가능한 다른 노선들까지 최대 5개 (인터넷 없을 때도 보이게)
const ridesOf = segs => (segs || []).filter(s => s.type === 'TRANSIT').map(s => ({ icon: s.icon, line: s.line, from: s.from, to: s.to, stops: s.stops, headsign: s.headsign, dep: s.depTime || null }));
const pickLeg = (r, all) => ({
  dur: r.dur, dist: r.dist, poly: r.poly, segs: r.segs, fare: r.fare || null, v: 3,
  alts: (all || [r]).slice(0, 5).map(x => ({ dur: x.dur, walk: Math.round((x.segs || []).filter(s => s.type === 'WALK').reduce((a, s) => a + (s.dur || 0), 0)), rides: ridesOf(x.segs) })).filter(a => a.rides.length),
});

function renderSheet() {
  const el = $('#sheet'), sh = S.sheet;
  el.classList.toggle('mini', !!S.pick);
  if (!sh) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  if (S.pick) {
    el.innerHTML = `<div class="pick-bar"><b>지도를 눌러 ${S.pickTarget === 'origin' ? '출발지를' : '위치를'} 고르세요</b><button data-act="pickCancel">취소</button></div>`;
    return;
  }
  el.innerHTML = { settings: settingsHtml, edit: editHtml, cal: calendarHtml, exit: exitHtml, wake: wakeHtml, poi: poiHtml, suggest: suggestHtml, guide: guideHtml, near: nearHtml, invite: inviteHtml, prog: progHtml, keep: keepHtml, bubble: bubbleHtml, reset: resetHtml, tripName: tripNameHtml }[sh.type](sh);
  if (sh.type === 'keep') fillMemPhotos();
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
    if (it.time != null && j < newItems.length - 1 && cut >= 10) shortened.push({ it, mins: Math.round(cut) }); // 자유 일정은 원래 시간 제한이 없어서 알리지 않음
    const moved = (a.arrive ?? a.depart) - (b.arrive ?? b.depart);
    if (it.time != null && moved >= 5) shifted.push({ it, mins: Math.round(moved) }); // 시간 없는 일정은 순서만 의미 있어서 "밀림"을 알리지 않음
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
  if (boardMode()) return imp; // 버블 보드는 순서 중심이라 시간 제한으로 묻지 않음
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
  if (boardMode()) imp = null;
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
      <div class="chips"><button class="chip-btn on" data-act="suggestAdd" data-j="${j}">＋ 일정에 넣기</button><button class="chip-btn" data-act="suggestMap" data-j="${j}">🗺️ 지도</button><button class="chip-btn" data-act="suggestNav" data-j="${j}">길안내</button><button class="chip-btn" data-act="favRes" data-j="${j}" aria-label="버블 만들기">${favStar(r)}</button></div>
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
      <div class="chips"><button class="chip-btn on" data-act="nearNav" data-j="${j}">길안내</button><button class="chip-btn" data-act="favRes" data-j="${j}" aria-label="버블 만들기">${favStar(r)}</button></div>
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
      <div class="chips"><button class="chip-btn on" data-act="poiMap" data-k="${k}">🗺️ 지도에서 보기</button><button class="chip-btn" data-act="poiNav" data-k="${k}">길안내</button><button class="chip-btn" data-act="poiAdd" data-k="${k}">＋ 일정에 넣기</button><button class="chip-btn" data-act="favRes" data-j="${k}" aria-label="버블 만들기">${favStar(r)}</button></div>
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
  S.sheet = null; S.pick = false; S.tp = null;
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

// opt.draft: 미리 채울 장소(즐겨찾기 등), opt.autoIndex: 저장할 때 시간 순서에 맞는 자리로
function openEditor(index, id, opt = {}) {
  const d = curDay(), date = S.selected;
  index ??= d?.items.length || 0;
  if (opt.autoIndex && d?.items.length) index = insertIndexFor(d, opt.draft); // 제목의 "n번째"도 실제 들어갈 자리로
  const it = id ? d.items.find(x => x.id === id) : null;
  const prevMode = d?.items[index - 1]?.mode;
  // 빈 날에 처음 넣는 일정: 도착지와 출발지를 한 화면에서 같이 정함
  const trip = !it && !(d?.items.length);
  const sh = {
    type: 'edit', date, index, id: it?.id || null, results: null, query: '', trip,
    autoIndex: !!opt.autoIndex,
    draft: opt.draft ? { ...opt.draft } : it ? { ...it, files: [...(it.files || [])] } : { ...blankPlace(), time: null, stay: trip ? 60 : 60, mode: prevMode || 'TRANSIT', memo: '', notes: [] },
  };
  if (trip) {
    sh.origin = null; // 비워 두면 현재 위치에서 출발
    sh.oQuery = ''; sh.oResults = null;
    sh.timeMode = date === todayStr() ? 'now' : 'dep'; // 오늘이면 기본은 "즉시 떠나기"
    sh.tval = date === todayStr() ? Math.min(roundUp10(nowMinOf(date) + 10), 23 * 60 + 50) : 9 * 60;
  }
  S.sheet = sh;
 
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
    const cur = getTime(id) ?? (S.sheet.date === todayStr() ? Math.min(roundUp10(nowMinOf(S.sheet.date) + 10), 23 * 60 + 55) : 9 * 60);
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
        ? `<span class="muted small">지금 바로(${fmtClock(nowMinOf(sh.date))}) 출발해요. 도착 시간은 자동 계산돼요.</span>`
        : `${timeField('trTime', sh.tval)}
      <span class="muted small">${sh.timeMode === 'dep' ? '이 시간에 출발지에서 떠나요. 도착 시간은 자동 계산돼요.' : '이 시간까지 도착하도록 출발 시간을 거꾸로 계산해요 (예약 등).'}</span>`}
    </div>
    <div class="field">이동 방법<div class="chips">${modes}</div></div>`;
  } else {
    // 다른 날로 옮기기: 날짜를 고르면 저장할 때 그 날로 옮겨짐 (시간이 있으면 그 시간 순서에 맞게 끼워 넣음)
    if (!sh.trip) {
      const target = sh.moveTo || sh.date;
      html += `<div class="field">날짜 <span class="muted small">(${sh.id ? '다른 날로 옮기려면 고르세요' : '넣을 날'})</span><div class="chips date-chips">${S.plan.days.map(x =>
        `<button class="chip-btn ${x.date === target ? 'on' : ''}" data-act="edDate" data-date="${x.date}">${dayLabel(x.date)}</button>`).join('')}</div>
        ${target !== sh.date ? `<div class="muted small">저장하면 <b>${dayLabel(target)}</b>${sh.id ? '로 옮겨져요' : '에 넣어요 (시간 순서에 맞는 자리로)'}</div>` : ''}</div>`;
    }
    const bm = boardMode(); // 버블 보드: 출발 시간·머무는 시간은 묻지 않고 예약 시각만
    html += legInfo + `${isStart && bm ? '' : `<div class="field">${isStart ? '출발 시간' : '도착 시간 <span class="muted small">(예약처럼 정해진 경우만. 비우면 자동 계산)</span>'}
      ${timeField('edTime', dr.time, { placeholder: isStart ? '출발 시간 고르기' : '정해진 시간 없음 (자동)', clearable: !isStart })}</div>`}
    ${sh.id && !bm ? `<div class="field">${isStart ? '출발 전 머무는 시간' : '머무는 시간'}<div class="chips">${stayChips}<span class="stay-input"><input id="edStay" type="number" min="0" step="5" value="${dr.stay || 0}">분</span></div></div>` : ''}
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
  if (!hasPos(dr) && !sh.id && !confirm('위치를 고르지 않았어요. 위치 없이 저장할까요? (지도와 거리 계산에서 빠져요)')) return; // 이미 있던 곳(날짜만 옮기기 등)은 묻지 않음
  if (!sh.id && !sh.trip && sh.moveTo && sh.moveTo !== sh.date) { sh.date = sh.moveTo; sh.autoIndex = true; } // 새 일정을 다른 날에
  const d = ensureDay(sh.date);
  const item = {
    id: sh.id || newId(), place: dr.place, address: dr.address || '', lat: dr.lat ?? null, lng: dr.lng ?? null,
    time: dr.time, stay: dr.stay || 0, mode: dr.mode, memo: dr.memo || '', notes: dr.notes || [], files: dr.files || [],
  };
  if (dr.auto) item.auto = true;
  if (!sh.id && !sh.trip && sh.autoIndex) sh.index = insertIndexFor(d, item); // 날짜만 정했으면 시간 순서에 맞는 자리로
  if (sh.id && sh.moveTo && sh.moveTo !== sh.date) {
    sh.saved = true;
    (sh.removed || []).forEach(id => deleteFile(id).catch(() => {}));
    if (moveItemToDay(sh.date, sh.id, sh.moveTo, item)) closeSheet();
    return;
  }
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
    if (sh.timeMode === 'now') { start.time = nowMinOf(sh.date); item.time = null; }        // 지금 바로 출발
    else if (sh.timeMode === 'dep') { start.time = sh.tval; item.time = null; }  // 정한 시간에 출발
    else { item.time = sh.tval; }                                                // 정한 시간까지 도착
    d.items.splice(0, 0, start, item);
  } else if (sh.id) d.items[d.items.findIndex(x => x.id === sh.id)] = item;
  else d.items.splice(sh.index, 0, item);
  savePlan();
  if (sh.date !== S.selected) selectDay(sh.date, true);
  recompute();
  closeSheet();
  renderAll(true);
  prefetchLegs();
  scheduleAlarms();
  changeToast(imp, sh.id ? '수정했어요' : sh.trip ? `${originOf(sh).place} → ${item.place} 일정을 만들었어요` : `${item.place} 저장했어요. 지도에 표시했어요`);
}

// 다른 날로 옮길 때 넣을 자리: 시간이 있으면 그 시간 순서대로, 없으면 맨 뒤(마지막이 숙소면 숙소 앞)
function insertIndexFor(d, item) {
  const n = d.items.length;
  if (!n) return 0;
  if (item.time != null) {
    const sched = dayPlan(d).sched;
    for (let j = 1; j < n; j++) { const a = sched[j].arrive ?? sched[j].depart; if (a != null && a > item.time) return j; }
  }
  return n > 1 && isHotel(d.items[n - 1].place) ? n - 1 : n;
}

// 일정 하나를 다른 날로 옮기기 (그 날 예약에 늦게 되면 먼저 물어봄)
function moveItemToDay(fromDate, id, toDate, item) {
  const from = S.plan.days.find(x => x.date === fromDate), to = ensureDay(toDate);
  const old = from?.items.find(x => x.id === id);
  if (!from || !old) return false;
  const moved = { ...(item || old), id };
  const items = [...to.items];
  items.splice(insertIndexFor(to, moved), 0, moved);
  const imp = to.items.length ? confirmChange(to, items) : { late: [], shifted: [], shortened: [], tight: [] };
  if (!imp) return false;
  from.items = from.items.filter(x => x.id !== id);
  delete progOf(fromDate)[id];
  to.items = items;
  savePlan(); recompute(); renderAll(false); prefetchLegs(); scheduleAlarms();
  changeToast(imp, `${moved.place}을(를) ${dayLabel(toDate)}${moved.time != null ? ` ${fmtClock(moved.time)}` : ''}로 옮겼어요`);
  return true;
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

// 휴지통에 놓아 지우기: 묻지 않고 바로 지우고, 알림의 "되돌리기"로 되살림 (첨부 파일은 되돌릴 수 있게 남겨 둠)
function trashItem(d, idx) {
  const it = d.items[idx], prog = progOf(d.date)[it.id];
  const day = S.plan.days.indexOf(d);
  d.items.splice(idx, 1);
  delete progOf(d.date)[it.id];
  const emptied = !d.items.length;
  if (emptied) S.plan.days = S.plan.days.filter(x => x !== d);
  const redraw = () => { savePlan(); saveProgress(); recompute(); renderAll(false); prefetchLegs(); scheduleAlarms(); };
  redraw();
  navigator.vibrate?.(40);
  toast(`🗑 ${it.place}을(를) 지웠어요`, 6000, { label: '되돌리기', fn: () => {
    if (emptied) S.plan.days.splice(Math.min(day, S.plan.days.length), 0, d);
    d.items.splice(Math.min(idx, d.items.length), 0, it);
    if (prog) progOf(d.date)[it.id] = prog;
    S.selected = d.date;
    redraw();
    toast(`${it.place}을(를) 되살렸어요`);
  } });
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
    <div class="reset-box"><div><b>🧪 시험용</b><div class="muted small">일정을 모두 지우고 처음 화면부터 다시 해 볼 때</div></div><button data-act="resetAsk">🗑 모든 일정 초기화</button></div>
    <label class="field">구글맵 API 키<input id="setKey" type="password" autocomplete="off" value="${esc(s.apiKey)}" placeholder="AIza…"></label>
    <div class="muted small">${PROXY_URL
      ? '비워 두어도 트립플립 서버를 통해 구글 장소 검색·추천·경로를 쓸 수 있어요. 내 키를 넣으면 지도 화면도 구글맵으로 바뀌어요.'
      : '키는 이 기기에만 저장돼요. 비워 두면 무료 지도와 추정 시간으로 동작해요.'}</div>
    ${PROXY_URL ? `<div class="field">초대 코드 <span class="muted small">(지인 전용 구글 검색)</span>
      <div class="st-actions"><span class="muted small">${s.invite ? '✅ 입력됨' : '아직 없음 · 무료 지도로 동작 중'}</span><button data-act="invite">${s.invite ? '코드 바꾸기' : '코드 입력'}</button></div></div>` : ''}
    <label class="field">도착으로 인정할 거리 (m)<input id="setRadius" type="number" min="20" max="1000" value="${s.radius}"></label>
    <label class="field">예약 시간 전 여유 (분)<input id="setBuffer" type="number" min="0" max="60" value="${s.buffer}"></label>
    <label class="check"><input id="setDetail" type="checkbox" ${s.detailList ? 'checked' : ''}> 예전 시간표 화면 쓰기 (시간·추천 칸 포함. 끄면 버블 보드)</label>
    <label class="check"><input id="setSim" type="checkbox" ${s.sim ? 'checked' : ''}> 테스트 모드: 선택한 날을 오늘로 보고, 지도를 누른 곳을 내 위치로 사용</label>
    <div class="st-actions"><button class="primary" data-act="saveSettings">저장</button></div>
    <hr>
    <div class="st-actions wrap">
      <button data-act="load">📂 엑셀/CSV 일정 불러오기</button>
      <button data-act="guide">📄 일정 양식 · AI로 만들기</button>
      <button data-act="rename">여행 이름 바꾸기</button>
      <button data-act="home">🧳 처음 화면 · 새 여행 만들기</button>
      ${curDay() ? '<button data-act="resetProgress">이 날 진행 초기화</button><button data-act="clearRoutes">경로 다시 계산</button>' : ''}
    </div>`;
}

function saveSettings() {
  const num = (id, def) => { const v = parseInt($(id).value, 10); return isFinite(v) ? v : def; };
  const old = S.settings;
  S.settings = {
    ...old,
    apiKey: $('#setKey').value.trim(),
    radius: Math.min(1000, Math.max(20, num('#setRadius', 100))),
    buffer: Math.min(60, Math.max(0, num('#setBuffer', 5))),
    sim: $('#setSim').checked,
    detailList: $('#setDetail').checked,
  };
  store.set('tg.settings', S.settings);
  if (old.apiKey !== S.settings.apiKey) { location.reload(); return; }
  closeSheet();
  recompute(); renderAll(false); scheduleAlarms(true);
  toast('저장했어요');
}

// ---------- 알람 ----------
// 알람은 모두 끔: 여행 중 엉뚱한 때(새벽, 이미 숙소인데 "출발하세요")에 울려서.
// 예전 버전이 휴대폰에 예약해 둔 알림은 앱을 켤 때 한 번 지움
let alarmsCleared = false;
function scheduleAlarms() {
  if (alarmsCleared) return;
  alarmsCleared = true;
  Alarms.set([]).catch(() => {});
}

function showAlarm(a) {
  const el = $('#alarm');
  S.alarmNow = a;
  let title = a.title, body = a.body, btns = '<button class="primary" data-act="dismissAlarm">확인</button>';
  if (a.kind === 'depart') {
    // 이미 지난 출발이면(출발·건너뜀 기록, 다음 장소에 이미 도착) 울리지 않음
    const d = S.plan.days.find(x => x.date === a.date), prog = d && (S.progress[d.date] || {});
    const j = d ? nextStopIdx(d, a.i) : -1, nx = d?.items[j], pos = S.pos;
    if (d && (prog[d.items[a.i]?.id]?.dep || prog[d.items[a.i]?.id]?.skip || (nx && prog[nx.id]?.arr))) { scheduleAlarms(true); return; }
    const dn = nx && pos && hasPos(nx) && (pos.acc ?? 0) <= 1500 ? haversine(pos, nx) : Infinity;
    if (dn <= S.settings.radius && (pos.acc ?? 0) <= 75) { markArrive(d, j); toast(`📍 이미 ${nx.place}에 계셔서 도착으로 처리했어요`, 5000); return; }
    if (dn <= ASK_R) {
      // 근처인데 확실하지 않음 → "출발하세요" 대신 이미 도착했는지 물어봄
      S.alarmNow = { ...a, askDate: d.date, askI: j };
      const el = $('#alarm');
      el.innerHTML = `<div class="alarm-title">📍 이미 ${esc(nx.place)}에 도착하셨나요?</div><div>출발 알람 시간이지만 지금 ${esc(nx.place)} 근처로 보여요.</div>
        <div class="alarm-btns"><button class="primary" data-act="alarmArrived">네, 도착</button><button data-act="dismissAlarm">아직 · 닫기</button></div>`;
      el.hidden = false; beep(); webNotify({ title: `📍 이미 ${nx.place}에 도착하셨나요?`, body: '앱에서 [네, 도착]을 눌러 주세요' });
      return;
    }
  }
  if (a.kind === 'depart' || a.kind === 'restEnd') {
    // 알람 직전에 위치 확인: 아직 그 장소에 그대로면 "출발하세요" 대신 다시 맞출지 물어봄
    const d = S.plan.days.find(x => x.date === a.date), it = d?.items[a.i], pos = gpsNow();
    const still = it && pos && hasPos(it) && haversine(pos, it) <= nearTol(pos);
    if (still || a.kind === 'restEnd') {
      if (it) title = `📍 아직 ${it.place}에 계세요`;
      body = a.kind === 'restEnd' ? a.body : `출발할 시간이에요. 지금 출발 기준으로 남은 일정을 다시 맞출까요? (${a.body})`;
      btns = `<button class="primary" data-act="${a.kind === 'restEnd' ? 'restEnd' : 'alarmReplan'}">⏩ 다시 맞추기</button>`;
    }
    btns += '<button data-act="alarmSnooze">10분 뒤</button><button data-act="dismissAlarm">닫기</button>';
  }
  el.innerHTML = `<div class="alarm-title">${esc(title)}</div><div>${esc(body)}</div><div class="alarm-btns">${btns}</div>`;
  el.hidden = false;
  beep();
  webNotify({ ...a, title, body });
}

// ---------- 처음 화면: 여행 떠나기 → 기간 정하기 → 일정 등록 → D-day ----------
// 여행이 없거나 끝났으면 새 여행 만들기부터, 여행 전이면 D-day, 여행 중이면 "여행 펼쳐보기"
const HOME_STEPS = ['kind', 'dates', 'plan'];
function openHome(step) {
  const stage = tripStage(tripRange(S.plan), todayStr());
  const t = S.plan.trip || {};
  S.home = { step: step || (stage === 'none' ? 'kind' : 'done'), kind: t.kind || null, start: null, end: null, fromDone: false };
  renderHome();
}
function closeHome() { S.home = null; renderHome(); }

function renderHome() {
  const el = $('#home'), h = S.home;
  if (!h) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  el.innerHTML = { kind: homeKind, dates: homeDates, plan: homePlan, done: homeDone }[h.step](h);
  el.scrollTop = 0;
  if (h.step === 'dates' && h.start) document.querySelector(`.hm-mon[data-ym="${h.start.slice(0, 7)}"]`)?.scrollIntoView({ block: 'start' });
}

// 위쪽: 뒤로 가기 + 1·2·3 단계 점
function homeTop(h) {
  const k = HOME_STEPS.indexOf(h.step), back = k > 0 || h.fromDone;
  return `<div class="hm-top">${back ? '<button class="icon-btn" data-act="hmBack" aria-label="이전"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></button>' : '<span></span>'}
    <div class="hm-dots">${HOME_STEPS.map((_, j) => `<i class="${j <= k ? 'on' : ''}"></i>`).join('')}</div><span></span></div>
    <div class="hm-step">${k + 1} / ${HOME_STEPS.length}</div>`;
}

function homeKind(h) {
  const old = S.plan.days.some(d => d.items.length);
  return `${homeTop(h)}<h1>어디로 떠나세요?</h1><p class="hm-sub">이번 여행을 골라 주세요</p>
    <div class="hm-cards">
      <button class="hm-card ${h.kind === 'domestic' ? 'on' : ''}" data-act="hmKind" data-kind="domestic"><span>🏞️</span><b>국내</b><small>우리나라 곳곳으로</small></button>
      <button class="hm-card ${h.kind === 'abroad' ? 'on' : ''}" data-act="hmKind" data-kind="abroad"><span>✈️</span><b>해외</b><small>비행기 타고 멀리</small></button>
    </div>
    ${old && !h.fromDone ? '<button class="hm-link" data-act="hmView">지난 일정 보기</button>' : ''}`;
}

// 여행 이름 정하기: 처음 화면(국내·해외 고른 바로 다음)과 설정의 "여행 이름 바꾸기"에서
function openTripName(from) {
  S.sheet = { type: 'tripName', from, value: from === 'home' ? S.home?.title || '' : S.plan.title || '' };
  renderSheet();
  setTimeout(() => { const t = $('#tripName'); t?.focus(); t?.select(); }, 300);
}
function tripNameHtml(sh) {
  const home = sh.from === 'home', kind = { domestic: '🏞️ 국내 여행', abroad: '✈️ 해외 여행' }[home ? S.home?.kind : S.plan.trip?.kind] || '트립플립';
  return `<div class="sheet-head"><div><div class="st-label">${kind}</div><b>✏️ 여행 이름 정하기</b></div><button class="x" data-act="closeSheet">✕</button></div>
    <label class="field">여행 이름<input id="tripName" maxlength="30" autocomplete="off" enterkeyhint="done" value="${esc(sh.value)}" placeholder="${S.home?.kind === 'domestic' ? '예: 제주 가족여행' : '예: 시드니 신혼여행'}"></label>
    <div class="st-actions"><button class="primary" data-act="tripNameOk">${home ? '정하기' : '바꾸기'}</button><button data-act="closeSheet">${home ? '나중에 정하기' : '취소'}</button></div>`;
}
function tripNameOk() {
  const sh = S.sheet, v = ($('#tripName')?.value || '').trim().slice(0, 30);
  if (!v) { $('#tripName')?.focus(); toast('여행 이름을 적어 주세요'); return; }
  if (sh.from === 'home' && S.home) { S.home.title = v; closeSheet(); renderHome(); paintRange(); } // 날짜를 고르면 이 이름으로 여행이 만들어짐
  else { S.plan.title = v; S.plan.named = true; savePlan(); closeSheet(); renderAll(false); }
  toast(`✏️ 여행 이름: ${v}`);
}

// 2/3 날짜: 위에 [출발] → [도착] 칸, 아래로 여러 달이 이어진 달력. 출발일 → 도착일 차례로 누르면 기간 (다음 달로 넘어가도 그대로)
function homeDates(h) {
  const t = todayStr(), from = h.start && h.start < t ? h.start : t;
  let y = +from.slice(0, 4), m = +from.slice(5, 7);
  const months = [];
  for (let k = 0; k < 13; k++) { // 이번 달부터 1년치
    const cells = monthCells(y, m).map(date => date
      ? `<div class="hm-day ${date < t ? 'past' : ''} ${date === t ? 'today' : ''} ${new Date(dayStart(date)).getDay() === 0 ? 'sun' : ''}" data-act="hmDay" data-date="${date}">${+date.slice(8)}</div>`
      : '<div></div>').join('');
    months.push(`<div class="hm-mon" data-ym="${y}-${String(m).padStart(2, '0')}"><b>${y}년 ${m}월</b><div class="hm-grid">${cells}</div></div>`);
    if (++m > 12) { m = 1; y++; }
  }
  return `${homeTop(h)}<div class="hm-tname-row"><button class="hm-tname" data-act="hmName">${h.title ? `✏️ ${esc(h.title)}` : '✏️ 여행 이름 정하기'}</button></div><h1>언제 떠나세요?</h1><p class="hm-sub">출발일과 도착일을 차례로 눌러 주세요</p>
    <div class="hm-se">
      <button class="hm-se-box" id="hmS" data-act="hmSE" data-w="s"><span>🛫 출발</span><b></b></button>
      <span class="hm-se-arrow">→</span>
      <button class="hm-se-box" id="hmE" data-act="hmSE" data-w="e"><span>🛬 도착</span><b></b></button>
    </div>
    <div class="hm-week">${[...'일월화수목금토'].map(w => `<span>${w}</span>`).join('')}</div>
    <div class="hm-months" id="hmMonths">${months.join('')}</div>
    <div class="hm-bottom"><div class="hm-pick" id="hmPick"></div><button class="hm-next primary" id="hmNext" data-act="hmDates">다음</button></div>`;
}
// 날짜를 누를 때: 도착일을 고르는 중이면 도착, 아니면 출발 (출발을 고르면 다음은 도착)
function hmPickDay(d) {
  const h = S.home;
  if (h.pickEnd && h.start && d >= h.start) { h.end = d; h.pickEnd = false; }
  else {
    const keep = (h.keepEnd || h.pickEnd) && h.end && h.end >= d; // 출발 칸을 눌러 출발만 고칠 때는 도착일 그대로
    h.start = d;
    if (!keep) h.end = null;
    h.pickEnd = !h.end;
  }
  h.keepEnd = false;
  paintRange();
}
// 칸 색과 위의 출발·도착 칸만 바꿈 (달력은 다시 그리지 않아서 보던 자리 그대로)
function paintRange() {
  const h = S.home;
  if (!h || h.step !== 'dates') return;
  const a = h.start, b = h.end || h.start;
  document.querySelectorAll('.hm-day[data-date]').forEach(c => {
    const d = c.dataset.date, inR = a && d >= a && d <= b;
    c.classList.toggle('sel', !!inR);
    c.classList.toggle('edge-s', d === a);
    c.classList.toggle('edge-e', !!a && d === b);
  });
  const box = (id, date, on) => { const el = $(id); el.classList.toggle('on', on); el.classList.toggle('none', !date); el.querySelector('b').textContent = date ? dayLabel(date) : '날짜 선택'; };
  box('#hmS', h.start, !h.pickEnd);
  box('#hmE', h.end, !!h.pickEnd);
  const r = a && { start: a, end: b };
  $('#hmPick').innerHTML = !r ? '<span class="muted">출발일을 눌러 주세요</span>'
    : `<b>${fmtRange(r)}</b> · ${fmtNights(r)}${h.end ? '' : ' <span class="muted">· 도착일을 눌러 주세요</span>'}`;
  $('#hmNext').disabled = !r;
}

function homePlan(h) {
  const r = tripRange(S.plan);
  return `${homeTop(h)}<h1>일정을 넣어 볼까요?</h1><p class="hm-sub">${r ? `${fmtRange(r)} · ${fmtNights(r)}` : ''}</p>
    <div class="hm-list">
      <button class="hm-row" data-act="hmManual"><span>✍️</span><div><b>직접 등록하기</b><small>가고 싶은 곳을 하나씩 검색해서 넣어요</small></div></button>
      <button class="hm-row" data-act="hmExcel"><span>📄</span><div><b>엑셀로 등록하기</b><small>양식이나 AI로 만든 엑셀로 한 번에 넣어요</small></div></button>
    </div>
    <button class="hm-link" data-act="hmSkip">건너뛰기</button>`;
}

function homeDone() {
  const r = tripRange(S.plan), t = todayStr();
  if (!r) return homeKind(S.home);
  const stage = tripStage(r, t), n = S.plan.days.reduce((k, d) => k + (d.date >= r.start && d.date <= r.end ? d.items.length : 0), 0);
  const kind = { domestic: '🏞️ 국내 여행', abroad: '✈️ 해외 여행' }[S.plan.trip?.kind] || '🧳 여행';
  const left = daysBetween(t, r.start), day = daysBetween(r.start, t) + 1;
  const ended = stage === 'none', ago = daysBetween(r.end, t); // 이미 끝난 여행 (지난 일정을 불러왔을 때)
  const big = stage === 'during' ? `${day}일째` : ended ? '다녀온 여행' : `D-${left}`;
  const msg = stage === 'during' ? '즐거운 여행 중이에요' : ended ? `${ago}일 전에 끝난 여행이에요` : left === 1 ? '내일 여행이 시작돼요!' : `오늘부터 ${left}일 후 여행이 시작돼요`;
  return `<div class="hm-done">
      <div class="hm-kind">${kind}</div>
      <div class="hm-title">${esc(S.plan.title || '내 여행')}</div>
      <div class="hm-dday ${ended ? 'sm' : ''}">${big}</div>
      <div class="hm-msg">${msg}</div>
      <div class="hm-range">${fmtRange(r)} · ${fmtNights(r)}<br><span class="muted">${n ? `일정 ${n}곳` : '아직 등록한 일정이 없어요'}</span></div>
      <button class="hm-go primary" data-act="hmView">${stage === 'during' ? '여행 펼쳐보기' : '일정 보기'}</button>
      <button class="hm-link" data-act="hmNew">새 여행 만들기</button>
    </div>`;
}

// 새 여행 시작: 지난 여행의 다녀온 곳은 추억으로 남기고 일정·진행 기록은 비움
function startTrip(kind, start, end, title) {
  syncMemories();
  S.plan = { title: title || (kind === 'abroad' ? '해외 여행' : '국내 여행'), named: !!title, days: [], trip: { kind, start, end } };
  S.progress = {};
  savePlan(); saveProgress();
  scheduleAlarms(true);
}

// 처음 화면 안에서 한 단계 뒤로. 더 갈 곳이 없으면 false
function homeBack() {
  const h = S.home, k = HOME_STEPS.indexOf(h.step);
  if (k > 0) { h.step = HOME_STEPS[k - 1]; renderHome(); return true; }
  if (h.fromDone) { h.step = 'done'; h.fromDone = false; renderHome(); return true; }
  return false;
}

// 일정 화면으로: 여행 전이면 첫날, 아니면 오늘(또는 다음 일정 날)
function homeView() {
  const r = tripRange(S.plan), t = todayStr();
  closeHome();
  selectDay(r && (r.start > t || r.end < t) ? r.start : pickInitialDay(), false); // 아직 안 했거나 끝난 여행은 첫날부터
  scrollToNow();
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
  // 진행 기록도 이어감: 같은 날짜·같은 장소 이름이면 새 일정에 그대로 (일정을 고쳐 다시 넣어도 다녀온 곳이 되살아나지 않게)
  const old = new Map();
  for (const d of S.plan.days) for (const it of d.items) { const p = S.progress[d.date]?.[it.id]; if (p) old.set(`${d.date}|${it.place}`, p); }
  const progress = {};
  for (const d of plan.days) for (const it of d.items) { const p = old.get(`${d.date}|${it.place}`); if (p) (progress[d.date] ||= {})[it.id] = p; }
  // 여행 기간은 엑셀에 적힌 날짜대로 (국내·해외는 처음 화면에서 고른 그대로)
  const dates = plan.days.map(d => d.date).sort();
  if (dates.length) plan.trip = { kind: S.plan.trip?.kind || null, start: dates[0], end: dates[dates.length - 1] };
  if (S.plan.named && !S.plan.days.some(d => d.items.length)) { plan.title = S.plan.title; plan.named = true; } // 처음 화면에서 정한 이름은 그대로
  S.plan = plan; savePlan();
  S.progress = progress; saveProgress();
  const places = plan.days.reduce((n, d) => n + d.items.length, 0);
  toast(`${plan.days.length}일, ${places}곳을 불러왔어요`);
  closeSheet();
  selectDay(pickInitialDay(), false);
  geocodeMissing();
  scheduleAlarms(true);
  if (S.home) { S.home.step = 'done'; S.home.fromDone = false; renderHome(); } // 처음 화면에서 엑셀로 넣었으면 D-day 화면으로
}

// manual: 사용자가 직접 고른 날짜(뒤로 가기 기록에 남김), fromBack: 뒤로 가기로 돌아온 경우
function selectDay(date, manual, fromBack) {
  if (manual && !fromBack && S.selected && date !== S.selected) {
    S.dayBack.push(S.selected);
    if (S.dayBack.length > 30) S.dayBack.shift();
  }
  S.selected = date;
  S.followToday = !manual || date === todayStr();
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
  if (byDist.length) return byDist[0][0];
  // 그 날 위치 있는 곳이 없으면 가까운 다른 날의 장소 근처에서 (해외 여행이면 국내 공항 등은 빼고)
  const t0 = Date.parse(d.date);
  for (const x of S.plan.days.filter(x => x !== d).sort((a, b) => Math.abs(Date.parse(a.date) - t0) - Math.abs(Date.parse(b.date) - t0))) {
    const p = x.items.find(y => hasPos(y) && inTripArea(y));
    if (p) return p;
  }
  return null;
}
// 해외 여행이면 우리나라 밖, 국내 여행이면 우리나라 안 (모르면 다 됨)
const inTripArea = p => ({ abroad: !inKorea(p), domestic: inKorea(p) }[S.plan.trip?.kind] ?? true);
// 근처에 기준 삼을 장소가 하나도 없을 때 이름만으로 찾기: 결과가 여러 도시에 흩어져 있으면(자라 매장처럼 흔한 이름) 고르지 않음
async function soleMatch(it) {
  const key = gkey();
  for (const q of [...new Set([it.nameEn, it.place].filter(Boolean))]) {
    if (!key) await sleep(1100);
    const list = (key ? await searchPlaces(key, q, null) : await searchPlacesFree(q)).filter(inTripArea);
    if (list.length) return list.every(r => haversine(list[0], r) < 30000) ? list[0] : { unsure: true };
  }
  return { unsure: true };
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
const unsureSeen = new Set(); // 어디인지 몰라 비워 둔 곳 (앱을 다시 열 때까지 또 묻지 않음)
// 위치 고르기: 수정 창을 열고 장소 이름으로 바로 검색해 둠 → 결과에서 고르기만
function pickPlace(date, id) {
  if (S.selected !== date) selectDay(date, true);
  const d = curDay(), i = d ? d.items.findIndex(x => x.id === id) : -1;
  if (i < 0) return;
  closePeek();
  const it = d.items[i];
  openEditor(i, it.id);
  S.sheet.query = it.place || it.address;
  renderSheet(); // 검색칸에 이름을 먼저 채운 뒤 검색
  edSearch('dest');
}
async function geocodeMissing() {
  // 찾는 중에 새 일정을 불러오면, 지금 것이 끝난 뒤 새 일정으로 한 번 더
  if (geocoding) { geocodeAgain = true; return; }
  geocoding = true;
  const plan = S.plan;
  try {
    let fixed = dropFarPlaces(), found = 0, failed = 0, last = null;
    const unsure = [];
    // 두 번까지: 처음 찾은 결과가 그날 다른 장소들과 동떨어지면 지우고 한 번 더
    for (let pass = 0; pass < 2; pass++) {
      const todo = S.plan.days.flatMap(d => d.items.filter(it => !hasPos(it)).map(it => [d, it]));
      if (!todo.length) break;
      failed = 0;
      let errors = 0, lastErr = null;
      for (const [k, [d, it]] of todo.entries()) {
        if (S.plan !== plan) return; // 다른 일정을 불러왔으면 그만
        const q = it.address || it.place, anchor = anchorFor(d, it), nameOnly = !anchor && !it.address;
        if (nameOnly && unsureSeen.has(it.id)) continue; // 이번에 이미 "골라 주세요"라고 알린 곳
        let g = nameOnly ? null : S.geoCache[q]; // 기준 없이 이름만이면 예전에 찾아 둔 결과도 다시 확인
        if (!g) {
          if (!gkey()) toast(`📍 장소 위치 찾는 중… ${k + 1}/${todo.length}`, 8000);
          try {
            g = nameOnly ? await soleMatch(it) : await locate(it, anchor);
            errors = 0;
          } catch (e) {
            // 한 곳이 실패해도 멈추지 않고 다음 장소로. 연속으로 계속 실패하면(인터넷 끊김 등) 잠시 멈춤
            lastErr = e; failed++;
            if (++errors >= 4) { toast(`장소 검색이 계속 실패해요 (${e.message}). 잠시 뒤 앱을 다시 열면 이어서 찾아요`, 7000); break; }
            await sleep(3000);
            continue;
          }
        }
        if (g?.unsure) { unsure.push([d, it]); unsureSeen.add(it.id); continue; }
        if (!g) { failed++; continue; }
        S.geoCache[q] = g;
        it.lat = g.lat; it.lng = g.lng;
        found++; last = [d, it, g];
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
      // 한 곳이면 어디로 찾았는지 보여 주고, 아니면 바로 다른 곳 고르기
      if (found === 1 && !fixed && last[2].address) toast(`📍 ${last[1].place} → ${last[2].address}`, 7000, { label: '다른 곳', fn: () => pickPlace(last[0].date, last[1].id) });
      else toast(fixed ? `잘못 찾았던 장소 ${fixed}곳을 다시 찾았어요` : `장소 ${found}곳의 위치를 찾았어요`, 4000);
      recompute(); renderAll(true); prefetchLegs();
    }
    if (unsure.length) {
      const [ud, ui] = unsure[0];
      toast(`📍 ${unsure.length > 1 ? `${unsure.length}곳은` : `${ui.place}:`} 어디인지 확실하지 않아서 위치를 비워 뒀어요`, 8000, { label: '골라 주기', fn: () => pickPlace(ud.date, ui.id) });
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
// 인터넷이 될 때 오늘·앞으로의 모든 날 경로를 미리 받아 둠 → 인터넷이 끊겨도 저장된 길·환승·내릴 역 안내
// (예전에 받은 대중교통 경로에 내릴 역 위치가 없으면 한 번 다시 받음)
async function prefetchLegs() {
  const key = gkey(), run = ++prefetchRun, t = todayStr();
  if (navigator.onLine === false) return;
  const days = [...new Set([curDay(), ...S.plan.days.filter(x => x.date >= t)].filter(Boolean))];
  let errors = 0;
  for (const d of days) {
    const { sched } = dayPlan(d);
    const prog = S.progress[d.date] || {};
    for (let i = 1; i < d.items.length; i++) {
      const a = prevStop(d, i), b = d.items[i];
      if (prog[b.id]?.skip || !hasPos(a) || !hasPos(b)) continue;
      if (!key && b.mode === 'TRANSIT') continue; // 대중교통은 구글(키 또는 초대 코드)이 있어야
      const c = S.legCache[legKey(a, b, b.mode)];
      const departAt = atMs(d.date, sched[i - 1].depart);
      if (!c || (b.mode === 'TRANSIT' && !c.fail && (c.v || 0) < 3)) { // 예전 경로는 노선·정류장 정보를 더해 한 번 다시
        try {
          const routes = await routeFor(key, a, b, b.mode, departAt);
          S.legCache[legKey(a, b, b.mode)] = routes.length ? pickLeg(routes[0], routes) : { fail: true };
          saveLegs();
        } catch (e) {
          if (++errors >= 3) { toast(`경로를 미리 받지 못했어요: ${e.message}`, 5000); return; }
          continue;
        }
        if (run !== prefetchRun) return;
        if (d === curDay()) { recompute(); renderAll(false); }
      }
      // 비행기에서 내린 공항에서 나가는 길은 지하철·택시·도보를 미리 비교해 둠 (인터넷 없을 때 대비)
      if (key && landingOf(d, i - 1)) await ensureAlts(a, b, departAt);
    }
  }
  scheduleAlarms();
}

// ---------- 이동 방법 비교 (지하철·택시·도보) ----------
const altKey = (a, b) => `ALT|${legKey(a, b, '')}`;
const altBusy = new Set();
async function ensureAlts(a, b, departAt) {
  const k = altKey(a, b), key = gkey();
  if (S.legCache[k] || altBusy.has(k) || !key || navigator.onLine === false) return S.legCache[k];
  altBusy.add(k);
  const out = {};
  for (const mode of ['TRANSIT', 'DRIVE', 'WALK']) {
    try {
      const [r] = await routeFor(key, a, b, mode, departAt);
      if (r) out[mode] = { dur: r.dur, dist: r.dist, fare: r.fare || null, segs: mode === 'TRANSIT' ? r.segs : undefined };
    } catch { /* 그 방법은 건너뜀 */ }
  }
  altBusy.delete(k);
  if (Object.keys(out).length) { S.legCache[k] = out; saveLegs(); renderStatus(); }
  return out;
}

// 택시 요금 대략 (도시별 기본요금 + km당). 모르는 나라는 표시 안 함
function taxiFare(distM, tz, fromAirport) {
  const km = distM / 1000;
  if (tz?.startsWith('Australia/')) {
    const v = 4.8 + 2.5 * km + (fromAirport ? 5.5 : 0); // 시드니 기준 대략 (주말·밤·톨게이트 별도)
    return `약 A$${Math.round(v * 0.9 / 5) * 5}~${Math.round(v * 1.2 / 5) * 5}`;
  }
  if (tz === 'Asia/Seoul') return `약 ₩${(Math.round((4800 + Math.max(0, km - 1.6) * 760) / 1000) * 1000).toLocaleString()}`;
  return '';
}

// "🚇 45분 · 🚕 25분 약 A$45~60 · 🚶 2시간 30분" 비교 줄 (계획한 방법 강조)
function altsHtml(d, i) {
  const a = prevStop(d, i), b = d.items[i];
  if (!a || !hasPos(a) || !hasPos(b)) return '';
  const alt = S.legCache[altKey(a, b)];
  if (!alt) {
    if (gkey() && navigator.onLine !== false) ensureAlts(a, b, atMs(d.date, S.cur.sched[d.items.indexOf(a)].depart));
    return '';
  }
  const tz = dayTz(d.date), fromAirport = !!landingOf(d, i - 1);
  const row = (mode, icon, label) => {
    const r = alt[mode];
    if (!r) return '';
    const cost = mode === 'TRANSIT' ? (r.fare || '') : mode === 'DRIVE' ? taxiFare(r.dist, tz, fromAirport) : '';
    const tooFar = mode === 'WALK' && r.dur > 60;
    return `<button class="alt ${b.mode === mode ? 'on' : ''} ${tooFar ? 'far' : ''}" data-act="nav" data-i="${i}">
      <span class="alt-ic">${icon}</span><b>${fmtDur(r.dur)}</b><small>${label}${cost ? ` · ${cost}` : ''}</small></button>`;
  };
  return `<div class="alts">${row('TRANSIT', '🚇', '대중교통')}${row('DRIVE', '🚕', '택시')}${row('WALK', '🚶', '도보')}</div>`;
}

// ---------- 버튼 처리 ----------
async function act(name, el) {
  const d = curDay(), i = +el.dataset.i;
  switch (name) {
    case 'load': $('#fileInput').click(); break;
    case 'rename': openTripName('settings'); break;
    case 'calendar': S.calMonth = null; S.sheet = { type: 'cal' }; renderSheet(); break;
    case 'settings': S.sheet = { type: 'settings' }; renderSheet(); break;
    case 'toggleView': if (topLayer() === 'map') popLayer(); else openMap(null); break;
    case 'toList': popLayer(); break;
    case 'openMap': openMap(i); break;
    case 'openDetail': openDetail(i, !!el.dataset.swap); break;
    case 'peekOpen': closePeek(); openDetail(i); break;
    case 'peekClose': closePeek(); break;
    case 'bubTap': openPeek(i, el, true); break;
    case 'peekDone': closePeek(); markDoneUpTo(d, i); break;
    case 'showPast': S.showPast = S.showPast === S.selected ? null : S.selected; renderTimeline(); break;
    case 'detailMap': openMap(S.detail, 'bottom'); break;
    case 'cardToList': backToList(i); break;
    case 'guide': S.sheet = { type: 'guide' }; renderSheet(); break;
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
    case 'fixPlace': pickPlace(S.selected, d.items[i].id); break;
    case 'tpOpen': case 'tpAmpm': case 'tpH': case 'tpM': case 'tpDone': case 'tpClear': tpAct(name, el); break;
    case 'files': openViewer(i, 0); break;
    case 'viewFile': openViewer(i, +el.dataset.k); break;
    case 'closeViewer': closeViewer(); break;
    case 'vwPrev': openViewer(S.viewer.i, S.viewer.k - 1); break;
    case 'vwNext': openViewer(S.viewer.i, S.viewer.k + 1); break;
    case 'vwZoom': { const d = +el.dataset.z; setZoom(d ? (S.viewer?.z || 1) * (d > 0 ? 1.5 : 1 / 1.5) : 1); break; }
    case 'vwCodes': showCodes(); break;
    case 'vwCodesOff': hideCodes(); break;
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
    case 'calPrev': case 'calNext': {
      const c = S.calMonth, m = c.m + (name === 'calNext' ? 1 : -1);
      S.calMonth = m < 1 ? { y: c.y - 1, m: 12 } : m > 12 ? { y: c.y + 1, m: 1 } : { y: c.y, m };
      renderSheet();
      break;
    }
    case 'pickDate': closeSheet(); selectDay(el.dataset.date, true); break;
    case 'goDay': selectDay(el.dataset.date, true); break;
    case 'addPlace': if (d?.items.length || boardMode()) { S.quickAdd = true; renderTimeline(); $('#qaIn')?.focus(); } else openEditor(i); break;
    case 'qaSave': qaSave(); break;
    case 'qaClose': S.quickAdd = false; renderTimeline(); break;
    case 'qaSearch': { const q = $('#qaIn')?.value.trim(); S.quickAdd = false; openEditor(d?.items.length || 0); if (q && S.sheet?.type === 'edit') { S.sheet.query = q; renderSheet(); } break; }
    case 'wishAdd': wishAdd(); break;
    case 'editPlace': openEditor(i, d.items[i].id); break;
    case 'delPlace': deletePlace(d, el.dataset.id ? d.items.findIndex(x => x.id === el.dataset.id) : i); break;
    case 'moveUp': movePlace(d, i, -1); break;
    case 'moveDown': movePlace(d, i, 1); break;
    case 'edSearch': edSearch('dest'); break;
    case 'edChoose': edChoose(+el.dataset.k); break;
    case 'orSearch': edSearch('origin'); break;
    case 'orChoose': { const r = S.sheet.oResults[+el.dataset.k]; setOrigin({ place: r.name, address: r.address, lat: r.lat, lng: r.lng, from: 'search' }); break; }
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
    case 'arrive': markArrive(d, i); break;
    case 'edDate': syncDraft(); S.sheet.moveTo = el.dataset.date; renderSheet(); break;
    case 'arriveYes': markArrive(d, i); toast(`📍 ${d.items[i].place} 도착`); break;
    case 'arriveNo': S.askNo[d.items[i].id] = Date.now(); renderStatus(); break;
    case 'replan': { const st = stuckInfo(d, phase(d)); const ph = phase(d);
      const at = st?.at ?? (ph.type === 'stay' ? ph.i : 0), next = st?.next ?? nextStopIdx(d, at);
      if (next >= 0) replan(d, at, next, +el.dataset.m || 0); break; }
    case 'skipNext': { const prog = progOf(d.date); S.undo = { date: d.date, at: Date.now(), snap: JSON.stringify(prog), rest: S.rest };
      prog[d.items[i].id] = { skip: true }; changed(); toast(`${d.items[i].place}은(는) 건너뛰었어요`); break; }
    case 'rest': setRest(d, el.dataset.m); break;
    case 'restEnd': { $('#alarm').hidden = true; S.rest = null; saveRest(); const ph = phase(d), at = ph.type === 'stay' ? ph.i : (stuckInfo(d, ph)?.at ?? 0);
      const next = nextStopIdx(d, at); if (next >= 0) replan(d, at, next, 0); else { renderStatus(); scheduleAlarms(true); } break; }
    case 'undoReplan': if (S.undo) { S.progress[S.undo.date] = JSON.parse(S.undo.snap); S.rest = S.undo.rest || null; saveRest(); S.undo = null; changed(); toast('되돌렸어요'); } break;
    case 'alarmReplan': { const a = S.alarmNow, dd = S.plan.days.find(x => x.date === a?.date);
      dismissAlarm(); if (dd) { selectDay(dd.date, false); const next = nextStopIdx(dd, a.i); if (next >= 0) replan(dd, a.i, next, 0); } break; }
    case 'alarmArrived': { const a = S.alarmNow, dd = S.plan.days.find(x => x.date === a?.askDate); dismissAlarm();
      if (dd) { markArrive(dd, a.askI); toast(`📍 ${dd.items[a.askI].place} 도착`); } break; }
    case 'alarmSnooze': { const a = S.alarmNow; dismissAlarm();
      if (a) { S.snooze = [...(S.snooze || []).filter(x => x.at > Date.now()).slice(-4), { ...a, id: Math.floor(a.id / 100) * 100 + 90 + ((S.snooze?.length || 0) % 5), at: Date.now() + 10 * 60000, title: `⏰ (10분 지남) ${a.title}` }];
        scheduleAlarms(true); toast('10분 뒤에 다시 알려 드릴게요'); } break; }
    case 'depart': markDepart(d, i); break;
    case 'clear': delete progOf(d.date)[d.items[i].id]; changed(); if (S.sheet?.type === 'prog') renderSheet(); break;
    case 'gmap': openExternal(placeUrl(d.items[i])); break;
    case 'closeSheet': closeSheet(); break;
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
    case 'resetProgress': resetDay(d); break;
    case 'doneUpTo': closeSheet(); markDoneUpTo(d, i); break;
    case 'keep': S.sheet = { type: 'keep', tab: S.keepTab || 'fav', cat: 'all' }; renderSheet(); break;
    case 'keepTab': S.keepTab = S.sheet.tab = el.dataset.tab; renderSheet(); break;
    case 'favCat': S.sheet.cat = el.dataset.cat; renderSheet(); break;
    case 'favSearch': favSearch(); break;
    case 'favResAdd': { const r = S.sheet.res?.[+el.dataset.j]; if (r) toggleFav(r, r.kind); break; }
    case 'favRes': { const sh = S.sheet, r = sh?.results?.[+el.dataset.j]; if (r) toggleFav(r, [sh.slot?.what, sh.near && NEAR_ME[sh.near]?.label, r.kind].filter(Boolean).join(' ')); break; }
    case 'favToggle': toggleFav(d.items[i], d.items[i].memo); break;
    case 'favAdd': { const f = S.favs.find(x => x.id === el.dataset.id); if (!f) break; closeSheet(); openEditor(null, null, { draft: favDraft(f), autoIndex: true }); break; }
    case 'favMap': { const f = S.favs.find(x => x.id === el.dataset.id); if (f) openExternal(placeUrl(f)); break; }
    case 'favOpen': S.sheet.open = S.sheet.open === el.dataset.id ? null : el.dataset.id; S.sheet.catEdit = null; renderSheet(); break;
    case 'dropMake': { const dr = S.drop; if (!dr) break; S.drop = null; renderDrop(); openBubbleMaker(dr); break; }
    case 'dropClose': clearDrop(); break;
    case 'bubCat': S.sheet.cat = el.dataset.cat; S.sheet.catTouched = true; bubbleTyped($('#bubName')?.value || ''); break;
    case 'bubMake': makeBubble(); break;
    case 'favCatEdit': S.sheet.catEdit = S.sheet.catEdit === el.dataset.id ? null : el.dataset.id; renderSheet(); break;
    case 'favSetCat': { const f = S.favs.find(x => x.id === el.dataset.id); if (f) { f.cat = el.dataset.cat; saveFavs(); } S.sheet.catEdit = null; rerenderKeep(); break; }
    case 'favDel': { const f = S.favs.find(x => x.id === el.dataset.id); if (f) toggleFav(f); break; }
    case 'favTray': if (S.sheet) closeSheet(); toggleTray(); break;
    case 'trayCat': S.tray.cat = el.dataset.cat; renderTray(); break;
    case 'memHeart': { const m = S.mems[el.dataset.key]; if (m) { m.heart = !m.heart; saveMems(); renderSheet(); } break; }
    case 'memNote': { const m = S.mems[el.dataset.key]; if (!m) break; const t = prompt(`${m.place} · 한 줄 메모`, m.note || ''); if (t != null) { m.note = t.trim(); saveMems(); renderSheet(); } break; }
    case 'memPhoto': S.memPhotoFor = el.dataset.key; memInput.click(); break;
    case 'memView': openMemPhoto(el.dataset.key, +el.dataset.k); break;
    case 'memPhotoDel': { const v = S.viewer, m = v?.mem && S.mems[v.mem]; if (!m || !confirm('이 사진을 지울까요?')) break;
      const [id] = m.photos.splice(v.k, 1); deleteFile(id).catch(() => {}); saveMems(); closeViewer(); break; }
    case 'memDel': { const m = S.mems[el.dataset.key]; if (!m || !confirm(`"${m.place}"을(를) 추억에서 뺄까요? (사진·메모도 함께 지워져요)`)) break;
      (m.photos || []).forEach(id => deleteFile(id).catch(() => {})); S.mems[m.key] = { key: m.key, gone: true }; saveMems(); renderSheet(); toast('추억에서 뺐어요'); break; }
    case 'memMap': openMemMap(); break;
    case 'memFocus': openMemMap(el.dataset.key); break;
    case 'memMapClose': closeMemMap(); break;
    case 'memMapDay': memMapFit(el.dataset.date); break;
    case 'memExport': exportKeep(); break;
    case 'memImport': importInput.click(); break;
    case 'progSheet': S.sheet = { type: 'prog' }; renderSheet(); break;
    case 'home': closeSheet(); openHome(); break;
    case 'hmBack': homeBack(); break;
    case 'hmKind': S.home.kind = el.dataset.kind; S.home.step = 'dates'; renderHome(); paintRange(); openTripName('home'); break;
    case 'hmName': openTripName('home'); break;
    case 'tripNameOk': tripNameOk(); break;
    case 'hmDay': hmPickDay(el.dataset.date); break;
    case 'hmSE': if (el.dataset.w === 'e') S.home.pickEnd = !!S.home.start; else { S.home.pickEnd = false; S.home.keepEnd = true; } paintRange(); break;
    case 'hmDates': {
      const h = S.home;
      if (!h.start) break;
      startTrip(h.kind, h.start, h.end || h.start, h.title);
      h.step = 'plan'; h.fromDone = false; renderHome();
      break;
    }
    case 'hmManual': { const s = S.plan.trip?.start; closeHome(); selectDay(s, false); openEditor(0); break; }
    case 'hmExcel': S.sheet = { type: 'guide' }; renderSheet(); break;
    case 'hmSkip': S.home.step = 'done'; renderHome(); break;
    case 'hmView': homeView(); break;
    case 'hmNew': {
      const live = S.plan.days.some(d => d.items.length) && tripStage(tripRange(S.plan), todayStr()) !== 'none';
      if (live && !confirm('지금 여행 일정을 지우고 새 여행을 만들까요? (다녀온 곳은 추억에 남아요)')) break;
      Object.assign(S.home, { step: 'kind', fromDone: true, start: null, end: null });
      renderHome();
      break;
    }
    case 'clearRoutes': S.legCache = {}; saveLegs(); recompute(); renderAll(false); prefetchLegs(); toast('경로를 다시 계산해요'); break;
    case 'resetAsk': S.sheet = { type: 'reset' }; renderSheet(); break;
    case 'resetAll': resetAll(); break;
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
  if (Date.now() - swipedAt < 400 || Date.now() - (S.dragJustEnded || 0) < 400) return;
  const b = e.target.closest('[data-act]');
  if (b) { e.stopPropagation(); act(b.dataset.act, b); return; }
  const tab = e.target.closest('.tab');
  if (tab) selectDay(tab.dataset.date, true);
});
document.addEventListener('input', e => { if (e.target.id === 'bubName') bubbleTyped(e.target.value); });
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.id === 'edQuery') { e.preventDefault(); edSearch('dest'); }
  if (e.key === 'Enter' && e.target.id === 'qaIn' && !e.isComposing) { e.preventDefault(); qaSave(); }
  if (e.key === 'Enter' && e.target.id === 'bubName' && !e.isComposing) { e.preventDefault(); makeBubble(); }
  if (e.key === 'Enter' && e.target.id === 'tripName' && !e.isComposing) { e.preventDefault(); tripNameOk(); }
  if (e.key === 'Enter' && e.target.id === 'orQuery') { e.preventDefault(); edSearch('origin'); }
});

// ---------- 손가락을 따라 움직이는 화면 넘기기 ----------
const EASE = 'cubic-bezier(.32,.72,0,1)'; // 아이폰 화면 전환과 비슷한 감속 곡선
let swipedAt = 0;

// 드래그 공통: 가로/세로 방향을 먼저 정하고, 정해진 방향일 때만 처리
function dragTracker(el, { onMove, onEnd, axis: want, holdY, skip }) {
  let st = null;
  const begin = (x, y) => { st = skip?.() ? null : { x, y, t: Date.now(), axis: null, dx: 0, dy: 0 }; };
  const move = (x, y, e) => {
    if (!st) return;
    if (S.drag || S.peek || S.bd) { st = null; return; } // 일정 끌어서 옮기는 중·간략 창이 떠 있을 땐 화면 넘기기 안 함
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
  el.addEventListener('touchstart', e => e.touches.length > 1 ? (st = null) : begin(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
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

// 첨부 크게 보기에서 좌우로 밀어 다음/이전 파일 (확대했을 땐 끌기가 이리저리 보기라서 안 넘김)
dragTracker($('#viewer'), {
  axis: 'x',
  skip: () => (S.viewer?.z || 1) > 1 || !!S.viewer?.codesOn,
  onEnd(s) {
    if (!S.viewer || Math.abs(s.dx) < 60) return;
    const n = curDay()?.items[S.viewer.i]?.files?.length || 0, k = S.viewer.k + (s.dx < 0 ? 1 : -1);
    if (k >= 0 && k < n) openViewer(S.viewer.i, k);
  },
});

// 크게 보기 확대: 두 손가락 벌리기 / 두 번 톡 / Ctrl+휠
{
  const vw = $('#viewer');
  let pinch = null, lastTap = 0;
  const mid = (t, r) => [(t[0].clientX + t[1].clientX) / 2 - r.left, (t[0].clientY + t[1].clientY) / 2 - r.top];
  const gap = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  vw.addEventListener('touchstart', e => {
    if (e.touches.length === 2 && vwBody() && !S.viewer?.codesOn) pinch = { d: gap(e.touches), z: S.viewer?.z || 1 };
  }, { passive: true });
  vw.addEventListener('touchmove', e => {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    const [x, y] = mid(e.touches, vwBody().getBoundingClientRect());
    setZoom(pinch.z * gap(e.touches) / pinch.d, x, y);
  }, { passive: false });
  vw.addEventListener('touchend', e => { if (e.touches.length < 2) pinch = null; });
  vw.addEventListener('click', e => {
    const b = vwBody();
    if (!b?.contains(e.target) || e.target.closest('button')) return;
    const now = Date.now();
    if (now - lastTap > 320) { lastTap = now; return; }
    lastTap = 0;
    const r = b.getBoundingClientRect();
    setZoom((S.viewer?.z || 1) > 1 ? 1 : 2.5, e.clientX - r.left, e.clientY - r.top);
  });
  vw.addEventListener('wheel', e => {
    const b = vwBody();
    if (!e.ctrlKey || !b) return;
    e.preventDefault();
    const r = b.getBoundingClientRect();
    setZoom((S.viewer?.z || 1) * (e.deltaY < 0 ? 1.2 : 1 / 1.2), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
}

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
  toast('휴대폰 시간대가 바뀌어 현지 시각으로 다시 맞췄어요', 5000);
}
// 앱을 다시 열면: 시간대 확인 + 지금 위치를 새로 받아 어디쯤인지 다시 확인
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  checkTimeZone(); ackWake();
  if (S.pos) detect();
  Geo.once().then(p => { if (p && !S.settings.sim) onPos(p); });
  scheduleAlarms(true); renderStatus();
});

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
  setupStatusFold();
  setupRowDrag();
  setupBoardDrag();
  // 폰의 길게 누르기 메뉴(번역·복사·공유)도 글 쓰는 칸·주소 말고는 안 뜨게
  document.addEventListener('contextmenu', e => { if (!e.target.closest?.(TEXT_OK)) e.preventDefault(); });
  // 웹앱: 인터넷 없이도 열리게 화면 파일 저장 (안드로이드 앱은 파일이 이미 들어 있음)
  if (!isNative && 'serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  // 인터넷이 다시 되면 못 받은 경로를 이어서 받음
  addEventListener('online', () => { toast('인터넷이 다시 연결됐어요'); prefetchLegs(); geocodeMissing(); renderStatus(); });
  addEventListener('offline', () => { toast('인터넷이 끊겼어요. 저장된 안내로 보여 드려요', 4000); renderStatus(); });
  // 화면 층(목록·상세·지도)을 담는 무대는 절대 스크롤되면 안 됨: 브라우저가 밀어 버리면 바로 되돌림 (지도가 검게 비는 문제 방지)
  const stage = $('.stage');
  stage?.addEventListener('scroll', () => { if (stage.scrollLeft || stage.scrollTop) stage.scrollTo(0, 0); });
  Alarms.onFire = showAlarm;
  await Alarms.init();
  S.selected = pickInitialDay();
  syncMemories(); // 지금까지의 도착 기록을 추억으로 (처음 켤 때 이번 여행 기록을 채움)
  recompute();
  renderAll(false);
  scrollToNow();
  openHome(); // 켤 때마다 처음 화면: 새 여행 만들기 / D-day / 여행 펼쳐보기

  S.map = await createMap($('#map'), S.settings.apiKey, msg => toast(msg || '구글맵 API 키를 확인해 주세요', 6000));
  S.map.onClick(ll => {
    if (S.drop) { clearDrop(); return; }
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
  S.map.onLongPress(mapHold);
  S.map.onMoveStart(() => { if (S.drop) clearDrop(); }); // 지도를 움직이면 말풍선은 닫음
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
  scheduleAlarms();
  if (S.plan.days.length) { geocodeMissing(); prefetchLegs(); }
  // 지인 전용 구글 검색: 처음 한 번 초대 코드를 물어봄 (건너뛰면 무료 지도)
  if (PROXY_URL && !S.settings.apiKey && !S.settings.invite && !S.settings.inviteAsked) setTimeout(openInvite, 600);
}

init();
