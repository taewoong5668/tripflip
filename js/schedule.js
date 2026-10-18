// 일정 시간 계산과 표시 형식

export const MODES = {
  WALK: { label: '도보', icon: '🚶', kmh: 4.5, extra: 0, color: '#2e7d32', gm: 'walking' },
  TRANSIT: { label: '대중교통', icon: '🚇', kmh: 18, extra: 8, color: '#7b1fa2', gm: 'transit' },
  DRIVE: { label: '차량', icon: '🚗', kmh: 25, extra: 5, color: '#1565c0', gm: 'driving' },
  BICYCLE: { label: '자전거', icon: '🚲', kmh: 12, extra: 0, color: '#ef6c00', gm: 'bicycling' },
};

export function haversine(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// 직선거리로 대략적인 이동시간(분) 추정. 실제 경로를 못 받았을 때 사용
export function estimateMin(distM, mode) {
  const m = MODES[mode] || MODES.TRANSIT;
  return Math.max(1, Math.round((distM * 1.3) / 1000 / m.kmh * 60 + (distM > 300 ? m.extra : 0)));
}

/**
 * 하루 일정의 도착/출발 시각 계산 (단위: 그날 0시부터의 분)
 * items[i].time: 도착 희망 시각(없으면 자동 계산).
 *   단, 0번(그날 첫 장소)의 시각은 언제나 "출발 시각" (양식: 첫 줄 = 출발 시각)
 * legs[i].dur: i-1번 → i번 이동시간
 * actual[i]: 실제 도착/출발 기록 {arr, dep}
 */
export function computeSchedule(items, legs, actual, buffer = 0) {
  const out = [];
  // 첫 장소에 적은 시간은 언제나 "출발 시각" (양식·수정 화면 모두 "출발 시간"으로 안내)
  // 단, 비행기에서 내린 공항(landing)은 그 시간이 "착륙 시각"이고, 입국심사·짐 찾기 시간(landing 분)이 지난 뒤 출발
  const firstIsDeparture = items[0]?.time != null && items.length > 1 && !items[0].landing;
  for (let i = 0; i < items.length; i++) {
    const it = items[i], a = actual[i] || {};
    const r = { travel: i > 0 ? (legs[i]?.dur ?? 0) : 0, late: 0, short: 0 };
    if (i === 0) {
      r.arrive = a.arr ?? (firstIsDeparture ? null : it.time);
    } else {
      r.eta = out[i - 1].depart + r.travel;
      r.arrive = a.arr ?? (it.time != null ? Math.max(it.time, r.eta) : r.eta);
      if (it.time != null) r.late = Math.max(0, Math.round((a.arr ?? r.eta) - it.time));
    }
    const next = items[i + 1];
    let dep;
    if (a.dep != null) dep = a.dep;
    else if (i === 0 && firstIsDeparture) dep = it.time;
    else if (next && next.time != null) {
      // 다음 장소 도착 시각이 정해져 있으면 늦어도 이때 출발
      dep = next.time - (legs[i + 1]?.dur ?? 0) - buffer;
      r.fixedByNext = true;
    } else dep = (r.arrive ?? 9 * 60) + (it.landing || 0) + (it.stay || 0);
    if (it.landing && r.arrive != null && a.dep == null) dep = Math.max(dep, r.arrive + it.landing); // 수속 끝나기 전엔 못 떠남
    if (r.arrive != null && a.dep == null && dep < r.arrive) dep = r.arrive;
    r.proc = it.landing || 0;
    if (r.arrive != null) {
      r.stayEff = dep - r.arrive;
      r.short = Math.max(0, Math.round((it.stay || 0) - r.stayEff));
    }
    r.depart = dep;
    out.push(r);
  }
  return out;
}

export function fmtClock(min) {
  if (min == null || !isFinite(min)) return '--:--';
  const m = Math.round(min);
  const day = Math.floor(m / 1440), mm = ((m % 1440) + 1440) % 1440;
  const s = `${String(Math.floor(mm / 60)).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}`;
  return day > 0 ? `${s}(+${day}일)` : s;
}

export function clockOf(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function fmtDur(min) {
  if (min == null || !isFinite(min)) return '?';
  const m = Math.round(min);
  if (m < 60) return `${m}분`;
  return m % 60 ? `${Math.floor(m / 60)}시간 ${m % 60}분` : `${m / 60}시간`;
}

export function fmtDist(m) {
  if (m == null) return '?';
  return m < 1000 ? `${Math.round(m)}m` : `${(m / 1000).toFixed(1)}km`;
}

// 남은 시간 카운트다운: 1시간 이상이면 "1시간 05분", 미만이면 "12:34"
export function fmtCountdown(ms) {
  const neg = ms < 0, t = Math.floor(Math.abs(ms) / 1000);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const body = h > 0 ? `${h}시간 ${String(m).padStart(2, '0')}분` : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return neg ? `${body} 지남` : body;
}

export function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function dayStart(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

export function dayLabel(date) {
  const [y, m, d] = date.split('-').map(Number);
  const w = '일월화수목금토'[new Date(y, m - 1, d).getDay()];
  return `${m}/${d} (${w})`;
}
