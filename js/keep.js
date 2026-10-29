// 즐겨찾기·추억(다녀온 곳) 데이터: 화면과 상관없는 계산만 (npm test로 점검)
import { isHotel, isFlight } from './parser.js?v=202610291415';

export const FAV_CATS = [
  { id: 'food', icon: '🍽', label: '맛집' },
  { id: 'cafe', icon: '☕', label: '카페' },
  { id: 'shop', icon: '🛍', label: '쇼핑' },
  { id: 'sight', icon: '🏛', label: '명소' },
  { id: 'stay', icon: '🏨', label: '숙소' },
  { id: 'etc', icon: '📌', label: '기타' },
];
export const catOf = id => FAV_CATS.find(c => c.id === id) || FAV_CATS.at(-1);

// 이름·종류 설명으로 카테고리 짐작 (나중에 직접 바꿀 수 있음)
export function guessCat(name = '', hint = '') {
  const t = `${name} ${hint}`.toLowerCase();
  if (/hotel|호텔|숙소|리조트|resort|hostel|motel|suites?\b|스위트|airbnb|에어비앤비|apartments?\b/.test(t)) return 'stay';
  if (/cafe|café|coffee|카페|커피|bakery|베이커리|빵집|dessert|디저트|gelato|젤라또|tea house|찻집/.test(t)) return 'cafe';
  if (/market|마켓|시장|mall|몰\b|shop|store|쇼핑|outlet|아울렛|백화점|department|gift|기념품|qvb|arcade|아케이드/.test(t)) return 'shop';
  if (/restaurant|레스토랑|식당|grill|그릴|\bbar\b|pub|펍|맛집|bistro|비스트로|kitchen|pizza|피자|burger|버거|sushi|스시|ramen|라멘|bbq|바베큐|steak|스테이크|seafood|해산물|diner|brunch|브런치|eatery|food|음식|야식|술집|izakaya|이자카야/.test(t)) return 'food';
  if (/museum|박물관|미술관|gallery|갤러리|park|공원|beach|해변|비치|bridge|브릿지|다리|tower|타워|opera|오페라|garden|가든|zoo|동물원|aquarium|아쿠아리움|church|성당|교회|temple|사원|절\b|palace|궁|lookout|전망|harbou?r|하버|island|섬|cathedral|monument|기념|castle|성\b|view|뷰/.test(t)) return 'sight';
  return 'etc';
}

const near = (a, b, m = 80) => {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h)) <= m;
};
const hasPos = p => p && p.lat != null && p.lng != null;

// 이미 즐겨찾기한 곳인지: 같은 이름이거나, 이름이 비슷하고 80m 안
export function findFav(favs, p) {
  const name = (p.place || p.name || '').trim().toLowerCase();
  return favs.find(f => f.place.trim().toLowerCase() === name || (hasPos(f) && hasPos(p) && near(f, p) && name && (f.place.toLowerCase().includes(name) || name.includes(f.place.toLowerCase()))));
}

/**
 * 진행 기록(도착·출발·지나옴)에서 다녀온 곳을 추억으로 모음.
 * 추억은 일정과 따로 보관해서, 일정을 지우거나 기록을 초기화해도 남음.
 * 키는 "날짜|장소 이름" (일정을 다시 불러와 id가 바뀌어도 같은 곳)
 * 이미 있던 추억의 메모·하트·사진은 그대로, 지운 추억(gone)은 다시 만들지 않음.
 * 숙소는 여행 전체에서 처음 한 번만 (매일 아침·저녁 숙소가 반복되지 않게)
 */
export function collectVisits(plan, progress, mems) {
  const out = { ...mems };
  let added = 0;
  const hotels = new Set(Object.values(out).filter(m => !m.gone && isHotel(m.place)).map(m => m.place));
  const seen = new Set();
  const days = [...(plan?.days || [])].sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const d of days) for (const [ord, it] of d.items.entries()) {
    const p = progress?.[d.date]?.[it.id];
    if (!p || p.skip || !(p.arr || p.dep || p.pass) || !hasPos(it) || isFlight(it.place)) continue;
    const key = `${d.date}|${it.place}`, old = out[key];
    if (old?.gone || seen.has(key)) continue; // 같은 날 같은 곳을 두 번(숙소 출발·복귀) → 처음 한 번만
    seen.add(key);
    if (!old && isHotel(it.place)) { if (hotels.has(it.place)) continue; hotels.add(it.place); }
    const rec = {
      key, date: d.date, place: it.place, address: it.address || '', lat: it.lat, lng: it.lng,
      arr: p.arr ?? old?.arr ?? null, dep: p.dep ?? old?.dep ?? null,
      ord, note: old?.note || '', heart: !!old?.heart, photos: old?.photos || [], at: old?.at || p.arr || p.dep || Date.now(),
    };
    if (!old) added++;
    out[key] = rec;
  }
  return { mems: out, added };
}

// 날짜순(같은 날은 일정 순서대로) 추억 목록
export function memList(mems) {
  return Object.values(mems || {}).filter(m => !m.gone)
    .sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : (a.ord ?? 99) - (b.ord ?? 99) || (a.arr ?? 0) - (b.arr ?? 0)));
}

// 백업 파일 합치기: 추억은 키별로(메모·하트는 있는 쪽 우선, 사진은 합침), 즐겨찾기는 같은 곳이면 하나만
export function mergeBackup(cur, inc) {
  const mems = { ...(cur.mems || {}) };
  for (const m of Object.values(inc.mems || {})) {
    const o = mems[m.key];
    if (!o || o.gone) { mems[m.key] = m; continue; }
    mems[m.key] = { ...o, note: o.note || m.note, heart: o.heart || m.heart, photos: [...new Set([...(o.photos || []), ...(m.photos || [])])] };
  }
  const favs = [...(cur.favs || [])];
  for (const f of inc.favs || []) if (!findFav(favs, f)) favs.push(f);
  return { mems, favs };
}
