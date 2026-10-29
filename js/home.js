// 처음 화면(여행 만들기 → 기간 → 일정 → D-day)에 쓰는 계산. 화면 그리기는 app.js

const dnum = s => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86400000;
/** 두 날짜(YYYY-MM-DD) 사이 일수 (b - a) */
export const daysBetween = (a, b) => Math.round(dnum(b) - dnum(a));

/** 여행 기간: 처음 화면에서 정한 기간과 실제 일정이 있는 날을 합친 범위. 둘 다 없으면 null */
export function tripRange(plan) {
  const dates = (plan?.days || []).filter(d => d.items?.length).map(d => d.date);
  const t = plan?.trip;
  if (t?.start) dates.push(t.start, t.end || t.start);
  if (!dates.length) return null;
  dates.sort();
  return { start: dates[0], end: dates[dates.length - 1] };
}

/** 지금 상태: 'none'(여행 없음·끝남) | 'before'(여행 전) | 'during'(여행 중) */
export function tripStage(range, today) {
  if (!range || range.end < today) return 'none';
  return range.start > today ? 'before' : 'during';
}

/** "10월 3일 ~ 10월 9일" */
export function fmtRange(r) {
  const f = s => `${+s.slice(5, 7)}월 ${+s.slice(8, 10)}일`;
  return r.start === r.end ? f(r.start) : `${f(r.start)} ~ ${f(r.end)}`;
}

/** "6박 7일" (당일치기면 "당일") */
export function fmtNights(r) {
  const n = daysBetween(r.start, r.end);
  return n ? `${n}박 ${n + 1}일` : '당일';
}

/** 달력 칸: 그 달 1일 앞의 빈칸은 null, 나머지는 'YYYY-MM-DD' (일요일 시작) */
export function monthCells(y, m) {
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay(), last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const pad = n => String(n).padStart(2, '0');
  return [...Array(first).fill(null), ...Array.from({ length: last }, (_, i) => `${y}-${pad(m)}-${pad(i + 1)}`)];
}
