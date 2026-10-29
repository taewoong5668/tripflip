// 지도 표시. API 키가 있으면 구글맵, 없으면 무료 지도(OpenStreetMap)로 대신 표시

let authFailed = null;
window.gm_authFailure = () => authFailed?.();

function loadGoogle(key) {
  if (window.google?.maps?.Map) return Promise.resolve();
  return new Promise((resolve, reject) => {
    window.__gmReady = resolve;
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&language=ko&loading=async&callback=__gmReady`;
    s.onerror = () => reject(new Error('구글맵을 불러오지 못했어요 (인터넷 연결 확인)'));
    document.head.appendChild(s);
  });
}

// 지도를 꾹 누르기 (0.55초). 손가락이 움직이거나 두 손가락(확대·축소)이면 취소. 구글맵·무료 지도 공통
function holdOn(el, view, toLatLng, cb) {
  let t = 0, p0 = null;
  const ids = new Set(), stop = () => { clearTimeout(t); t = 0; };
  el.addEventListener('pointerdown', e => {
    ids.add(e.pointerId);
    stop();
    if (ids.size > 1 || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const r = el.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    p0 = { x: e.clientX, y: e.clientY };
    t = setTimeout(() => {
      t = 0;
      const ll = toLatLng(x, y);
      if (!ll) return;
      view.heldAt = Date.now(); // 손을 뗄 때 생기는 "누르기"는 무시
      cb({ ...ll, x, y });
    }, 550);
  }, true);
  el.addEventListener('pointermove', e => { if (t && Math.hypot(e.clientX - p0.x, e.clientY - p0.y) > 8) stop(); }, true);
  const up = e => { ids.delete(e.pointerId); stop(); };
  el.addEventListener('pointerup', up, true);
  el.addEventListener('pointercancel', up, true);
}
const justHeld = v => Date.now() - (v.heldAt || 0) < 600;

export async function createMap(el, apiKey, onAuthFail) {
  if (apiKey) {
    try {
      authFailed = onAuthFail;
      await loadGoogle(apiKey);
      await google.maps.importLibrary('maps');
      await google.maps.importLibrary('marker');
      return new GoogleView(el);
    } catch (e) {
      onAuthFail?.(e.message);
    }
  }
  return new LeafletView(el);
}

class GoogleView {
  constructor(el) {
    this.kind = 'google';
    this.map = new google.maps.Map(el, {
      center: { lat: 37.5665, lng: 126.978 }, zoom: 12,
      disableDefaultUI: true, zoomControl: false, gestureHandling: 'greedy', clickableIcons: false,
      colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'DARK' : 'LIGHT',
    });
    this.el = el;
    this.markers = []; this.lines = [];
    // 화면 좌표 → 위도·경도 변환용 (구글맵은 오버레이를 하나 깔아야 변환 함수를 줌)
    this.ov = new google.maps.OverlayView();
    this.ov.onAdd = this.ov.draw = this.ov.onRemove = () => {};
    this.ov.setMap(this.map);
  }
  setPlaces(list) {
    this.markers.forEach(m => m.setMap(null));
    this.markers = list.map(p => {
      // 출발지는 네모, 나머지는 동그라미. ring이면 노란 테두리(지금 가는 곳/새로 추가 중인 곳)
      const path = p.shape === 'square' ? 'M -1.1,-1.1 1.1,-1.1 1.1,1.1 -1.1,1.1 z' : google.maps.SymbolPath.CIRCLE;
      const m = new google.maps.Marker({
        map: this.map, position: p, title: p.title, zIndex: p.z || 1,
        label: { text: p.label, color: p.textColor || '#fff', fontWeight: '700', fontSize: '12px' },
        icon: {
          path, scale: p.shape === 'square' ? 11 : 13, fillColor: p.color, fillOpacity: 1,
          strokeColor: p.ring ? '#ffd600' : '#fff', strokeWeight: p.ring ? 4 : 2,
        },
      });
      if (p.onClick) m.addListener('click', p.onClick);
      return m;
    });
  }
  setLines(list) {
    this.lines.forEach(l => l.setMap(null));
    this.lines = list.map(l => new google.maps.Polyline({
      map: this.map, path: l.path, strokeColor: l.color, zIndex: l.z || 1,
      strokeOpacity: l.dashed ? 0 : (l.opacity ?? 0.8), strokeWeight: l.width || 4,
      icons: l.dashed ? [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 0.7, scale: 3, strokeColor: l.color }, offset: '0', repeat: '12px' }] : undefined,
    }));
  }
  setMe(p) {
    if (!this.me) {
      this.acc = new google.maps.Circle({ map: this.map, fillColor: '#1a73e8', fillOpacity: 0.12, strokeWeight: 0, clickable: false });
      this.me = new google.maps.Marker({ map: this.map, zIndex: 999, clickable: false, icon: { path: google.maps.SymbolPath.CIRCLE, scale: 8, fillColor: '#1a73e8', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 3 } });
    }
    this.me.setPosition(p); this.acc.setCenter(p); this.acc.setRadius(p.acc || 0);
  }
  fit(points) {
    if (!points.length) return;
    if (points.length === 1) { this.map.setCenter(points[0]); this.map.setZoom(15); return; }
    const b = new google.maps.LatLngBounds();
    points.forEach(p => b.extend(p));
    // 위쪽 상태 표시와 아래쪽 장소 카드에 가리지 않게 여백
    this.map.fitBounds(b, { top: 80, bottom: 150, left: 40, right: 40 });
  }
  panTo(p, zoom) { this.map.panTo(p); if (zoom) this.map.setZoom(zoom); }
  resize() { /* 구글맵은 크기 변화를 스스로 감지 */ }
  onClick(cb) { this.map.addListener('click', e => { if (!justHeld(this)) cb({ lat: e.latLng.lat(), lng: e.latLng.lng() }); }); }
  onDrag(cb) { this.map.addListener('dragstart', cb); }
  onMoveStart(cb) { this.map.addListener('dragstart', cb); this.map.addListener('zoom_changed', cb); }
  onLongPress(cb) {
    holdOn(this.el, this, (x, y) => {
      const ll = this.ov.getProjection()?.fromContainerPixelToLatLng(new google.maps.Point(x, y));
      return ll && { lat: ll.lat(), lng: ll.lng() };
    }, cb);
  }
}

class LeafletView {
  constructor(el) {
    this.kind = 'osm';
    this.el = el;
    this.map = L.map(el, { zoomControl: false, attributionControl: true }).setView([37.5665, 126.978], 12);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(this.map);
    this.markers = []; this.lines = [];
  }
  setPlaces(list) {
    this.markers.forEach(m => m.remove());
    this.markers = list.map(p => {
      const cls = `pin${p.shape === 'square' ? ' sq' : ''}${p.ring ? ' ring' : ''}`;
      const icon = L.divIcon({ className: '', html: `<div class="${cls}" style="background:${p.color};color:${p.textColor || '#fff'}">${p.label}</div>`, iconSize: [28, 28], iconAnchor: [14, 14] });
      const m = L.marker([p.lat, p.lng], { icon, title: p.title, zIndexOffset: (p.z || 1) * 100 }).addTo(this.map);
      if (p.onClick) m.on('click', p.onClick);
      return m;
    });
  }
  setLines(list) {
    this.lines.forEach(l => l.remove());
    this.lines = list.map(l => L.polyline(l.path.map(p => [p.lat, p.lng]), {
      color: l.color, weight: l.width || 4, opacity: l.opacity ?? 0.8, dashArray: l.dashed ? '6 8' : null,
    }).addTo(this.map));
  }
  setMe(p) {
    if (!this.me) {
      this.acc = L.circle([p.lat, p.lng], { radius: 0, stroke: false, fillColor: '#1a73e8', fillOpacity: 0.12, interactive: false }).addTo(this.map);
      this.me = L.circleMarker([p.lat, p.lng], { radius: 8, color: '#fff', weight: 3, fillColor: '#1a73e8', fillOpacity: 1, interactive: false }).addTo(this.map);
    }
    this.me.setLatLng([p.lat, p.lng]); this.acc.setLatLng([p.lat, p.lng]); this.acc.setRadius(p.acc || 0);
  }
  fit(points) {
    if (!points.length) return;
    if (points.length === 1) { this.map.setView([points[0].lat, points[0].lng], 15); return; }
    this.map.fitBounds(points.map(p => [p.lat, p.lng]), { paddingTopLeft: [30, 80], paddingBottomRight: [30, 150] });
  }
  panTo(p, zoom) { zoom ? this.map.setView([p.lat, p.lng], zoom) : this.map.panTo([p.lat, p.lng]); }
  // 숨겨져 있던 지도를 보여줄 때 크기와 선 그리기 영역을 다시 계산
  resize() { this.map.invalidateSize({ pan: false }); }
  onClick(cb) { this.map.on('click', e => { if (!justHeld(this)) cb({ lat: e.latlng.lat, lng: e.latlng.lng }); }); }
  onDrag(cb) { this.map.on('dragstart', cb); }
  onMoveStart(cb) { this.map.on('dragstart zoomstart', cb); }
  onLongPress(cb) {
    holdOn(this.el, this, (x, y) => { const ll = this.map.containerPointToLatLng([x, y]); return { lat: ll.lat, lng: ll.lng }; }, cb);
  }
}
