// 휴대폰 기능(GPS, 알람, 외부 앱 열기). 앱에서는 Capacitor 플러그인, PC 브라우저에서는 웹 기능 사용

const Cap = window.Capacitor;
export const isNative = !!Cap?.isNativePlatform?.();
const plugin = name => Cap?.Plugins?.[name];

const norm = p => ({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, ts: p.timestamp || Date.now() });

export const Geo = {
  async watch(onPos, onErr) {
    const G = isNative && plugin('Geolocation');
    if (G) {
      try { await G.requestPermissions(); } catch (e) { onErr(e); }
      const id = await G.watchPosition({ enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }, (pos, err) => {
        if (err) onErr(err); else if (pos) onPos(norm(pos));
      });
      return () => G.clearWatch({ id });
    }
    if (!navigator.geolocation) { onErr(new Error('이 기기는 위치 기능을 지원하지 않아요')); return () => {}; }
    // 웹: 정확한 GPS는 실내·휴대폰 브라우저에서 오래 걸리거나 실패하기 쉬움
    // → 먼저 와이파이·통신망 기반 대략 위치를 빨리 받고, 정확한 GPS는 계속 따라가며 덮어씀
    let best = null;
    const take = p => {
      const n = norm(p);
      // 더 정확하거나, 30초 넘게 지난 위치면 바꿈 (대략 위치가 정확한 GPS를 덮지 않게)
      if (!best || n.acc <= best.acc * 1.5 || n.ts - best.ts > 30000) { best = n; onPos(n); }
    };
    this.once().then(p => p && take({ coords: { latitude: p.lat, longitude: p.lng, accuracy: p.acc }, timestamp: p.ts }));
    const id = navigator.geolocation.watchPosition(take, e => {
      onErr(e);
      if (e.code !== 1) this.once().then(p => p && take({ coords: { latitude: p.lat, longitude: p.lng, accuracy: p.acc }, timestamp: p.ts }));
    }, { enableHighAccuracy: true, maximumAge: 15000, timeout: 30000 });
    return () => navigator.geolocation.clearWatch(id);
  },

  /** 위치 한 번 받기 (대략 위치라도 빨리). 실패하면 null */
  once(highAccuracy = false) {
    const G = isNative && plugin('Geolocation');
    if (G) return G.getCurrentPosition({ enableHighAccuracy: highAccuracy, timeout: 10000, maximumAge: 60000 }).then(norm).catch(() => null);
    if (!navigator.geolocation) return Promise.resolve(null);
    return new Promise(res => navigator.geolocation.getCurrentPosition(p => res(norm(p)), () => res(null),
      { enableHighAccuracy: highAccuracy, maximumAge: 5 * 60000, timeout: 10000 }));
  },
};

let timers = [];

export const Alarms = {
  onFire: null,

  async init() {
    const LN = isNative && plugin('LocalNotifications');
    if (LN) {
      try {
        await LN.createChannel({ id: 'depart', name: '출발 알람', importance: 5, vibration: true, visibility: 1 });
      } catch { /* 채널은 Android 8 이상에서만 */ }
    }
  },

  async requestPermission() {
    const LN = isNative && plugin('LocalNotifications');
    if (LN) {
      const r = await LN.requestPermissions();
      return r.display === 'granted';
    }
    if ('Notification' in window) {
      if (Notification.permission === 'default') await Notification.requestPermission();
      return Notification.permission === 'granted';
    }
    return false;
  },

  /** list: [{id, at(ms), title, body}] — 기존 예약을 모두 지우고 다시 예약 */
  async set(list) {
    timers.forEach(clearTimeout);
    timers = [];
    const now = Date.now();
    const future = list.filter(a => a.at > now).sort((a, b) => a.at - b.at);
    // 앱이 켜져 있을 때 화면 안 알림
    for (const a of future) {
      const ms = a.at - now;
      if (ms < 2 ** 31 - 1) timers.push(setTimeout(() => this.onFire?.(a), ms));
    }
    const LN = isNative && plugin('LocalNotifications');
    if (LN) {
      // 앱을 닫거나 화면이 꺼져도 울리는 휴대폰 예약 알림
      const pending = await LN.getPending();
      if (pending.notifications.length) await LN.cancel({ notifications: pending.notifications.map(n => ({ id: n.id })) });
      if (future.length) {
        await LN.schedule({
          notifications: future.slice(0, 400).map(a => ({
            id: a.id, title: a.title, body: a.body, channelId: 'depart',
            schedule: { at: new Date(a.at), allowWhileIdle: true },
          })),
        });
      }
    }
  },
};

export function webNotify(a) {
  if (!isNative && 'Notification' in window && Notification.permission === 'granted') {
    try { new Notification(a.title, { body: a.body }); } catch { /* 일부 브라우저는 서비스워커 필요 */ }
  }
}

export function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.35, 0.7].forEach(t => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = 880; o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.3, ctx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.3);
      o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.3);
    });
  } catch { /* 소리 재생 불가 */ }
  navigator.vibrate?.([400, 200, 400, 200, 400]);
}

// 휴대폰 뒤로 가기 버튼. 앱에서는 이 함수가 처리하고, 기본 동작(앱 종료)은 막음
export function onBackButton(cb) {
  const A = isNative && plugin('App');
  if (A) A.addListener('backButton', cb);
  // PC 미리보기에서는 Esc 키를 뒤로 가기로
  document.addEventListener('keydown', e => { if (e.key === 'Escape') cb(); });
}

export function exitApp() {
  const A = isNative && plugin('App');
  if (A) A.exitApp();
  else window.close();
}

// 구글맵 앱으로 길안내 열기
export function openExternal(url) {
  if (isNative) window.location.href = url; // Capacitor가 외부 앱(구글맵)으로 넘김
  else window.open(url, '_blank', 'noopener');
}

// 파일 내보내기(백업): 앱에서는 휴대폰 "문서" 폴더에 저장한 뒤 공유 창(카톡·메일·드라이브)을 띄우고,
// 브라우저에서는 공유 창(아이폰) 또는 바로 다운로드
export async function saveOrShare(name, text, mime = 'application/json') {
  const FS = isNative && plugin('Filesystem'), Sh = isNative && plugin('Share');
  if (FS) {
    const r = await FS.writeFile({ path: name, data: text, directory: 'DOCUMENTS', encoding: 'utf8', recursive: true })
      .catch(() => FS.writeFile({ path: name, data: text, directory: 'CACHE', encoding: 'utf8' }));
    if (Sh) await Sh.share({ title: name, files: [r.uri] }).catch(() => {});
    return 'saved';
  }
  const file = new File([text], name, { type: mime });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return 'shared'; } catch (e) { if (e?.name === 'AbortError') return 'cancel'; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  return 'downloaded';
}
