// 여행 일정 파일(CSV / 엑셀) 읽기

export async function readPlanFile(file) {
  const name = file.name.toLowerCase();
  const buf = await file.arrayBuffer();
  let sheets;
  if (/\.xlsx?$/.test(name)) {
    if (!window.XLSX) throw new Error('엑셀 읽기 모듈을 불러오지 못했어요');
    const wb = window.XLSX.read(buf, { type: 'array' });
    sheets = wb.SheetNames.map(n => ({ name: n, rows: sheetRows(wb.Sheets[n]) }));
  } else {
    sheets = [{ name: '', rows: parseCSV(decodeText(buf)) }];
  }
  const plan = sheetsToPlan(sheets);
  plan.title = file.name.replace(/\.[^.]+$/, '');
  return plan;
}

export function parsePlanText(text, title = '여행 일정') {
  const plan = sheetsToPlan([{ name: '', rows: parseCSV(text.replace(/^﻿/, '')) }]);
  plan.title = title;
  return plan;
}

// 시트를 2차원 배열로. 셀에 걸린 링크(구글맵 "지도 열기" 등)는 rows.links에 따로 보관
function sheetRows(ws) {
  const X = window.XLSX;
  const rows = X.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '', blankrows: true });
  rows.links = {};
  if (!ws['!ref']) return rows;
  const start = X.utils.decode_range(ws['!ref']).s;
  for (const addr of Object.keys(ws)) {
    if (addr[0] === '!' || !ws[addr].l?.Target) continue;
    const { r, c } = X.utils.decode_cell(addr);
    rows.links[`${r - start.r},${c - start.c}`] = ws[addr].l.Target;
  }
  return rows;
}

// 엑셀에서 저장한 CSV는 CP949(EUC-KR)인 경우가 많음
function decodeText(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('euc-kr').decode(buf);
  }
}

export function parseCSV(text) {
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',' || c === '\t') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); rows.push(row); row = []; cur = '';
    } else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

const HEADER_RE = /장소|목적지|place/i;
// 머리글 줄: 칸이 2개 이상 채워져 있고, 짧은 "장소" 칸이 있는 줄 (제목 문장 속 "장소"는 무시)
const isHeaderRow = r => r.filter(c => String(c).trim()).length >= 2
  && r.some(c => HEADER_RE.test(String(c)) && String(c).trim().length <= 12);
const isHotel = s => /호텔|숙소|리조트|게스트하우스|에어비앤비|메리턴|풀러턴|hotel|suites|resort|hostel|airbnb/i.test(s);
const isFlight = s => /탑승|비행기|항공편|flight|\b[A-Z]{2}\d{2,4}\b/i.test(s);

// 시트 여러 개(날짜별 시트) 또는 하나(전체 일정)를 날짜별 일정으로 합치기
function sheetsToPlan(sheets) {
  const days = new Map();
  const dayOf = date => {
    if (!days.has(date)) days.set(date, { date, title: '', subtitle: '', notes: [], items: [] });
    return days.get(date);
  };
  for (const s of sheets) {
    const hi = s.rows.findIndex(isHeaderRow);
    if (hi < 0) continue;
    // 날짜 열이 없으면 표 위의 제목 줄("10월 18일(일) 출국일")이나 시트 이름("10.18(일)")에서 날짜를 가져옴
    const above = s.rows.slice(0, hi).map(r => r.map(c => String(c).trim()).filter(Boolean).join(' ')).filter(Boolean);
    const fallback = above.map(parseDate).find(Boolean) || parseDate(s.name);
    const { out, footer } = parseRows(s.rows, hi, fallback);
    for (const { date, item } of out) dayOf(date).items.push(item);
    // 시트 하나가 하루치면 제목·부제·아래쪽 요약/메모를 그날 정보로 보관
    const dates = new Set(out.map(o => o.date));
    if (dates.size === 1) {
      const d = dayOf([...dates][0]);
      d.title ||= above[0] || '';
      d.subtitle ||= above[1] || '';
      d.notes.push(...footer);
    }
  }
  if (!days.size) throw new Error('"장소" 열이 있는 표를 찾지 못했어요');
  const list = [...days.values()].filter(d => d.items.length).sort((a, b) => a.date.localeCompare(b.date));

  // 하루가 식당 같은 곳에서 끝나면(마지막 날·비행기 제외) 식사 후 숙소로 돌아가는 줄을 끝에 추가
  for (let k = 0; k < list.length - 1; k++) {
    const items = list[k].items, last = items.at(-1);
    if (isHotel(last.place) || isFlight(last.place)) continue;
    const hotel = list.slice(0, k + 1).flatMap(d => d.items).filter(it => isHotel(it.place)).at(-1);
    if (!hotel) continue;
    if (!last.stay) last.stay = 75;
    items.push({ ...hotel, time: null, stay: 0, mode: 'TRANSIT', memo: '식사 후 숙소로 복귀', notes: [] });
  }

  // 아침 첫 장소가 숙소가 아니면, 전날 묵은 숙소에서 출발하는 줄을 맨 앞에 추가
  // (전날 마지막이 식당이어도 숙소 기준. 비행기 탄 다음 날은 추가 안 함)
  for (let k = 1; k < list.length; k++) {
    const prevItems = list[k - 1].items, first = list[k].items[0];
    if (isFlight(prevItems.at(-1).place) || isHotel(first.place)) continue;
    const prev = prevItems.filter(it => isHotel(it.place)).at(-1) || prevItems.at(-1);
    if (samePlace(prev, first)) continue;
    list[k].items.unshift({ ...prev, time: null, stay: 0, memo: '전날 숙소에서 출발', notes: [], auto: true });
  }
  for (const d of list) d.items.forEach((it, i) => (it.id = `${d.date}#${i}`));
  return { days: list };
}

function samePlace(a, b) {
  if (a.place === b.place) return true;
  if (a.address && a.address === b.address) return true;
  return a.lat != null && a.lat === b.lat && a.lng === b.lng;
}

function parseRows(rows, hi, fallbackDate) {
  const head = rows[hi].map(c => String(c).trim().toLowerCase());
  const find = (re, not) => head.findIndex(h => re.test(h) && !(not && not.test(h)));
  const col = {
    date: find(/날짜|일자|date/),
    stay: find(/체류|머무|stay|duration/),
    time: find(/시간|시각|time/, /체류|머무|소요|stay|duration/),
    place: find(/장소|목적지|place/),
    address: find(/주소|address/),
    lat: find(/위도|^lat/),
    lng: find(/경도|^lng|^lon/),
    mode: find(/이동|교통|수단|mode/),
    link: find(/지도|맵|map|링크|link|url/),
  };
  const memoCol = find(/메모|비고|memo|note/);
  // 장소 카드에 항목별로 보여줄 열들
  const NOTE_LABELS = [[/어떻게|방법|how/, '이동 방법'], [/설명|detail|desc/, '설명'], [/추천|주변|nearby/, '주변 추천'], [/팁|tip/, '팁']];
  const noteCols = head.flatMap((h, i) => {
    const hit = NOTE_LABELS.find(([re]) => re.test(h));
    return hit && i !== memoCol ? [{ i, label: hit[1] }] : [];
  });
  const cell = (r, k) => (col[k] < 0 ? '' : r[col[k]] ?? '');

  const out = [], footer = [];
  let lastDate = null, prev = null;
  rows.slice(hi + 1).forEach((r, k) => {
    const place = String(cell(r, 'place')).trim();
    if (!place) {
      // 표 아래 요약·가이드 메모 같은 글
      const text = r.map(c => String(c).trim()).filter(Boolean).join(' ');
      if (text) footer.push(text);
      return;
    }
    const date = parseDate(cell(r, 'date')) || lastDate || fallbackDate;
    if (!date) throw new Error(`"${place}" 줄에 날짜가 없어요. 첫 줄에는 날짜를 꼭 적어 주세요`);
    if (date !== lastDate) prev = null;
    lastDate = date;

    let lat = parseFloat(cell(r, 'lat')), lng = parseFloat(cell(r, 'lng'));
    let address = String(cell(r, 'address')).trim();
    const linkCell = col.link < 0 ? '' : rows.links?.[`${hi + 1 + k},${col.link}`] || String(r[col.link] ?? '');
    const link = parseMapLink(linkCell);
    if (link?.lat != null && !isFinite(lat)) { lat = link.lat; lng = link.lng; }
    if (link?.query && !address) address = link.query;
    let ok = isFinite(lat) && isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

    // 비행기 탑승 줄은 바로 앞 장소(공항)와 같은 위치로
    if (prev && isFlight(place) && (!address || isFlight(address))) {
      address = prev.address;
      ok = prev.lat != null;
      lat = prev.lat; lng = prev.lng;
    }

    const memo = memoCol < 0 ? '' : String(r[memoCol] ?? '').trim();
    const notes = noteCols.map(({ i, label }) => ({ label, text: String(r[i] ?? '').trim() })).filter(n => n.text);
    const item = {
      notes,
      place,
      address,
      lat: ok ? lat : null,
      lng: ok ? lng : null,
      time: parseTime(cell(r, 'time')),
      stay: parseStay(cell(r, 'stay')),
      mode: parseMode(cell(r, 'mode')),
      memo,
    };
    out.push({ date, item });
    prev = item;
  });
  return { out, footer };
}

// 구글맵 링크에서 좌표나 검색어 꺼내기
function parseMapLink(s) {
  if (!/^https?:\/\//.test(s)) return null;
  try {
    const u = new URL(s);
    const at = u.pathname.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (at) return { lat: +at[1], lng: +at[2] };
    const q = u.searchParams.get('query') || u.searchParams.get('q') || u.searchParams.get('destination');
    if (!q) return null;
    const ll = q.match(/^\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)\s*$/);
    return ll ? { lat: +ll[1], lng: +ll[2] } : { query: q.trim() };
  } catch {
    return null;
  }
}

const pad = n => String(n).padStart(2, '0');

export function parseDate(v) {
  if (v === '' || v == null) return null;
  if (typeof v === 'number') {
    // 엑셀 날짜 일련번호
    if (v < 20000) return null;
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86400000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  const s = String(v).trim();
  let m = s.match(/(\d{4})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2})$/); // 11/3/26
  if (m) return `20${m[3]}-${pad(m[1])}-${pad(m[2])}`;
  m = s.match(/(\d{1,2})\s*[./월]\s*(\d{1,2})/); // 11/3, 11월 3일
  if (m) return `${new Date().getFullYear()}-${pad(m[1])}-${pad(m[2])}`;
  return null;
}

// 결과: 0시부터의 분, 없으면 null
export function parseTime(v) {
  if (v === '' || v == null) return null;
  if (typeof v === 'number') {
    if (Number.isInteger(v) && v >= 0 && v < 24) return v * 60; // "9" 처럼 시만 입력
    const f = v - Math.floor(v);
    return f > 0 ? Math.round(f * 1440) : null;
  }
  const s = String(v).trim();
  const m = s.match(/(오전|오후|am|pm)?\s*(\d{1,2})\s*(?:[:시]\s*(\d{1,2})?)?\s*분?\s*(am|pm)?/i);
  if (!m || (!/[:시]/.test(s) && !m[1] && !m[4])) return null;
  let h = +m[2];
  const min = +(m[3] || 0);
  const ap = (m[1] || m[4] || '').toLowerCase();
  if ((ap === '오후' || ap === 'pm') && h < 12) h += 12;
  if ((ap === '오전' || ap === 'am') && h === 12) h = 0;
  return h * 60 + min;
}

// 체류시간(분): 90, "1:30", "1시간 30분", "1.5시간"
export function parseStay(v) {
  if (v === '' || v == null) return 0;
  if (typeof v === 'number') return v > 0 && v < 1 ? Math.round(v * 1440) : Math.round(v);
  const s = String(v).trim();
  let m = s.match(/^(\d+):(\d{1,2})$/);
  if (m) return +m[1] * 60 + +m[2];
  const h = s.match(/([\d.]+)\s*시간/), mi = s.match(/(\d+)\s*분/);
  if (h || mi) return Math.round((h ? parseFloat(h[1]) * 60 : 0) + (mi ? +mi[1] : 0));
  const n = parseFloat(s);
  return isFinite(n) ? Math.round(n) : 0;
}

// "도보/경전철"처럼 여러 개면 앞에 적힌 것을 사용
export function parseMode(v) {
  const s = String(v || '').toLowerCase();
  for (const t of s.split(/[/,·+]|또는/)) {
    if (/도보|걷|walk/.test(t)) return 'WALK';
    if (/자전거|bike|bicycl/.test(t)) return 'BICYCLE';
    if (/대중|버스|기차|지하철|전철|철도|트램|페리|bus|train|metro|subway|tram|ferry/.test(t)) return 'TRANSIT';
    if (/차|택시|운전|렌트|자가용|우버|drive|car|taxi|uber/.test(t)) return 'DRIVE';
  }
  return 'TRANSIT';
}
