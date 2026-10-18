// 장소별 현지 시간대: 위도·경도로 대략 판단 (인터넷 없이). 모르면 null → 휴대폰 시간대 사용
// 하루 일정의 시각은 그 날 장소의 현지 시각으로 계산해야, 비행기로 시간대가 바뀌어도 뒤죽박죽이 안 됨

const box = (la1, la2, lo1, lo2) => p => p.lat >= la1 && p.lat <= la2 && p.lng >= lo1 && p.lng <= lo2;

// 위에서부터 차례로 검사 (좁은 지역을 먼저)
const ZONES = [
  [box(33, 39, 124, 132), 'Asia/Seoul'],
  [box(22.1, 22.6, 113.8, 114.5), 'Asia/Hong_Kong'],
  [box(21.8, 25.4, 119.5, 122.1), 'Asia/Taipei'],
  [box(24, 46, 122.9, 146), 'Asia/Tokyo'],
  [box(13.2, 13.7, 144.6, 145), 'Pacific/Guam'],
  [box(4.5, 21, 116, 127), 'Asia/Manila'],
  [box(5.5, 20.5, 97.3, 105.6), 'Asia/Bangkok'],
  [box(8, 23.5, 102, 110), 'Asia/Ho_Chi_Minh'],
  [box(-9, 7.5, 99.6, 119.5), 'Asia/Singapore'],
  [box(18, 54, 73, 135), 'Asia/Shanghai'],
  // 호주: 주마다 다름 (퀸즐랜드·서호주는 서머타임 없음)
  [p => p.lat < -10 && p.lat > -44 && p.lng > 112 && p.lng < 129, 'Australia/Perth'],
  [p => p.lat < -10 && p.lat > -26 && p.lng >= 129 && p.lng < 138, 'Australia/Darwin'],
  [p => p.lat <= -26 && p.lat > -40 && p.lng >= 129 && p.lng < 141, 'Australia/Adelaide'],
  [p => p.lat < -10 && p.lat > -28.2 && p.lng >= 138 && p.lng < 154, 'Australia/Brisbane'],
  [p => p.lat <= -28.2 && p.lat > -44 && p.lng >= 141 && p.lng < 154, 'Australia/Sydney'],
  [box(-48, -34, 166, 179), 'Pacific/Auckland'],
  [box(18.5, 22.5, -161, -154), 'Pacific/Honolulu'],
  [box(49, 61, -11, 2), 'Europe/London'],
  [box(36, 43.5, -9.6, -6), 'Europe/Lisbon'],
  [box(34, 72, -10, 24), 'Europe/Paris'],
  [box(34, 72, 24, 40), 'Europe/Athens'],
  [box(24, 50, -125, -114), 'America/Los_Angeles'],
  [box(24, 50, -114, -102), 'America/Denver'],
  [box(24, 50, -102, -87), 'America/Chicago'],
  [box(24, 50, -87, -66), 'America/New_York'],
];

export function tzOf(p) {
  if (!p || p.lat == null || p.lng == null) return null;
  return ZONES.find(([f]) => f(p))?.[1] || null;
}

export const deviceTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; } };

const fmts = new Map();
function partsOf(tz, ms) {
  if (!fmts.has(tz)) {
    fmts.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  const o = {};
  for (const p of fmts.get(tz).formatToParts(ms)) o[p.type] = +p.value;
  return o;
}

/** 그 시간대가 UTC보다 몇 분 빠른지 (서울 +540, 시드니 여름 +660) */
export function offsetMin(tz, ms) {
  const o = partsOf(tz, ms);
  const wall = Date.UTC(o.year, o.month - 1, o.day, o.hour % 24, o.minute, o.second);
  return Math.round((wall - Math.floor(ms / 1000) * 1000) / 60000);
}

/** 그 시간대의 해당 날짜 0시 (ms) */
export function zonedMidnight(date, tz) {
  const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - offsetMin(tz, guess) * 60000;
  t = guess - offsetMin(tz, t) * 60000; // 서머타임 경계 보정
  return t;
}

/** ms를 그 시간대의 "HH:MM"으로 */
export function clockIn(ms, tz) {
  const o = partsOf(tz, ms);
  return `${String(o.hour % 24).padStart(2, '0')}:${String(o.minute).padStart(2, '0')}`;
}

/** 시간대 이름을 짧은 한국어로 (화면 표시용) */
export function tzLabel(tz) {
  const city = { 'Asia/Seoul': '한국', 'Asia/Tokyo': '일본', 'Australia/Sydney': '시드니', 'Australia/Brisbane': '브리즈번', 'Australia/Perth': '퍼스',
    'Australia/Adelaide': '애들레이드', 'Australia/Darwin': '다윈', 'Pacific/Auckland': '뉴질랜드', 'Asia/Shanghai': '중국', 'Asia/Hong_Kong': '홍콩',
    'Asia/Taipei': '대만', 'Asia/Bangkok': '태국', 'Asia/Ho_Chi_Minh': '베트남', 'Asia/Singapore': '싱가포르', 'Asia/Manila': '필리핀', 'Pacific/Guam': '괌',
    'Pacific/Honolulu': '하와이', 'Europe/London': '영국', 'Europe/Lisbon': '포르투갈', 'Europe/Paris': '유럽 중부', 'Europe/Athens': '유럽 동부',
    'America/Los_Angeles': '미국 서부', 'America/Denver': '미국 산악', 'America/Chicago': '미국 중부', 'America/New_York': '미국 동부' }[tz];
  return city ? `${city} 시간` : tz;
}
