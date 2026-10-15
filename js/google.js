// 구글 Routes API(경로)와 Places API(장소 검색) 호출

const ROUTE_FIELDS = [
  'routes.duration',
  'routes.distanceMeters',
  'routes.polyline.encodedPolyline',
  'routes.legs.steps.travelMode',
  'routes.legs.steps.staticDuration',
  'routes.legs.steps.distanceMeters',
  'routes.legs.steps.navigationInstruction.instructions',
  'routes.legs.steps.transitDetails.headsign',
  'routes.legs.steps.transitDetails.stopCount',
  'routes.legs.steps.transitDetails.transitLine.name',
  'routes.legs.steps.transitDetails.transitLine.nameShort',
  'routes.legs.steps.transitDetails.transitLine.vehicle.type',
  'routes.legs.steps.transitDetails.stopDetails.departureStop.name',
  'routes.legs.steps.transitDetails.stopDetails.arrivalStop.name',
  'routes.legs.steps.transitDetails.stopDetails.departureTime',
].join(',');

const VEHICLE = { SUBWAY: '🚇', METRO_RAIL: '🚇', HEAVY_RAIL: '🚆', COMMUTER_TRAIN: '🚆', HIGH_SPEED_TRAIN: '🚄', RAIL: '🚆', BUS: '🚌', INTERCITY_BUS: '🚌', TROLLEYBUS: '🚎', TRAM: '🚊', MONORAIL: '🚝', FERRY: '⛴️', CABLE_CAR: '🚡', GONDOLA_LIFT: '🚡', FUNICULAR: '🚞' };

const wp = p => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });
const secs = s => (s ? parseInt(s, 10) : 0);

async function post(url, key, fields, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': fields },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error?.message || `요청 실패 (${res.status})`);
  return json;
}

/** 경로 목록 반환. 경로가 없으면 빈 배열 */
export async function fetchRoutes(key, from, to, mode, departAt) {
  const body = { origin: wp(from), destination: wp(to), travelMode: mode, languageCode: 'ko', units: 'METRIC' };
  if (mode === 'DRIVE') body.routingPreference = 'TRAFFIC_AWARE';
  if (mode === 'TRANSIT') body.computeAlternativeRoutes = true;
  if (departAt && departAt > Date.now() + 60000 && (mode === 'TRANSIT' || mode === 'DRIVE')) {
    body.departureTime = new Date(departAt).toISOString();
  }
  const json = await post('https://routes.googleapis.com/directions/v2:computeRoutes', key, ROUTE_FIELDS, body);
  return (json.routes || []).map(r => ({
    dur: Math.max(1, Math.round(secs(r.duration) / 60)),
    dist: r.distanceMeters || 0,
    poly: r.polyline?.encodedPolyline || '',
    segs: toSegments(r.legs?.[0]?.steps || []),
  }));
}

// 걸음 단계는 하나로 묶고, 대중교통 단계는 노선 정보로 정리
function toSegments(steps) {
  const segs = [];
  for (const s of steps) {
    const t = s.transitDetails;
    if (s.travelMode === 'TRANSIT' && t) {
      const line = t.transitLine || {};
      segs.push({
        type: 'TRANSIT',
        icon: VEHICLE[line.vehicle?.type] || '🚌',
        line: line.nameShort || line.name || '',
        headsign: t.headsign || '',
        from: t.stopDetails?.departureStop?.name || '',
        to: t.stopDetails?.arrivalStop?.name || '',
        stops: t.stopCount || 0,
        depTime: t.stopDetails?.departureTime || null,
        dur: Math.round(secs(s.staticDuration) / 60),
      });
    } else {
      const last = segs[segs.length - 1];
      const type = s.travelMode === 'WALK' ? 'WALK' : 'MOVE';
      if (last && last.type === type) {
        last.dur += secs(s.staticDuration) / 60;
        last.dist += s.distanceMeters || 0;
        if (s.navigationInstruction?.instructions) last.steps.push(s.navigationInstruction.instructions);
      } else {
        segs.push({ type, dur: secs(s.staticDuration) / 60, dist: s.distanceMeters || 0, steps: s.navigationInstruction?.instructions ? [s.navigationInstruction.instructions] : [] });
      }
    }
  }
  segs.forEach(s => (s.dur = Math.round(s.dur)));
  return segs;
}

/** 장소 검색 결과 여러 개. near가 있으면 그 근처 결과를 먼저 */
export async function searchPlaces(key, query, near) {
  const body = { textQuery: query, languageCode: 'ko', maxResultCount: 6 };
  if (near) body.locationBias = { circle: { center: { latitude: near.lat, longitude: near.lng }, radius: 50000 } };
  const json = await post(
    'https://places.googleapis.com/v1/places:searchText',
    key,
    'places.location,places.displayName,places.formattedAddress',
    body,
  );
  return (json.places || []).filter(p => p.location).map(p => ({
    name: p.displayName?.text || query,
    address: p.formattedAddress || '',
    lat: p.location.latitude,
    lng: p.location.longitude,
  }));
}

/** API 키 없이 쓰는 무료 검색 (OpenStreetMap). 결과가 구글보다 부정확할 수 있음 */
export async function searchPlacesFree(query, near) {
  let u = `https://nominatim.openstreetmap.org/search?format=json&limit=6&accept-language=ko&q=${encodeURIComponent(query)}`;
  // near가 있으면 그 주변(약 5km) 안에서만 찾기
  if (near) u += `&viewbox=${near.lng - 0.05},${near.lat + 0.05},${near.lng + 0.05},${near.lat - 0.05}&bounded=1`;
  let list = [], err = null;
  try {
    const res = await fetch(u);
    if (!res.ok) throw new Error(`검색 실패 (${res.status})`);
    list = (await res.json()).map(p => ({
      name: p.name || p.display_name.split(',')[0],
      address: p.display_name,
      lat: +p.lat,
      lng: +p.lon,
    }));
  } catch (e) { err = e; }
  if (list.length) return list;
  // 못 찾으면 Photon으로 한 번 더: 글자가 조금 달라도(띄어쓰기·일부 이름) 찾아 줌. "광주 유스퀘어" 같은 경우
  try { list = await searchPhoton(query, near); } catch (e) { if (err) throw err; throw e; }
  return list;
}

async function searchPhoton(query, near) {
  let u = `https://photon.komoot.io/api/?limit=6&q=${encodeURIComponent(query)}`;
  if (near) u += `&lat=${near.lat}&lon=${near.lng}`;
  const res = await fetch(u);
  if (!res.ok) throw new Error(`검색 실패 (${res.status})`);
  const json = await res.json();
  return (json.features || []).filter(f => {
    const [lng, lat] = f.geometry.coordinates;
    // near가 있으면 Nominatim처럼 주변(약 5km)만
    return !near || (Math.abs(lat - near.lat) < 0.05 && Math.abs(lng - near.lng) < 0.05);
  }).map(f => {
    const p = f.properties, [lng, lat] = f.geometry.coordinates;
    return {
      name: p.name || p.street || query,
      address: [p.name, p.housenumber && p.street ? `${p.street} ${p.housenumber}` : p.street, p.district, p.city, p.state, p.country].filter(Boolean).join(', '),
      lat, lng,
    };
  });
}

// 식사 종류별로 찾을 가게 종류
const FOOD_TYPES = {
  brunch: { google: ['cafe', 'breakfast_restaurant', 'brunch_restaurant', 'bakery'], osm: 'cafe|restaurant|bakery' },
  lunch: { google: ['restaurant'], osm: 'restaurant|fast_food|food_court' },
  dinner: { google: ['restaurant'], osm: 'restaurant|pub|bar' },
};

/** 근처 식당·카페 (구글: 평점 높은 순) */
export async function nearbyFood(key, center, meal, radius = 800) {
  const json = await post(
    'https://places.googleapis.com/v1/places:searchNearby',
    key,
    'places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.primaryTypeDisplayName,places.priceLevel',
    {
      includedTypes: FOOD_TYPES[meal].google, maxResultCount: 15, rankPreference: 'POPULARITY', languageCode: 'ko',
      locationRestriction: { circle: { center: { latitude: center.lat, longitude: center.lng }, radius } },
    },
  );
  return (json.places || []).filter(p => p.location).map(p => ({
    name: p.displayName?.text || '이름 없음',
    address: p.formattedAddress || '',
    lat: p.location.latitude, lng: p.location.longitude,
    rating: p.rating || null, reviews: p.userRatingCount || 0,
    kind: p.primaryTypeDisplayName?.text || '',
  }));
}

/** 근처 식당·카페 (무료 OpenStreetMap, 키 없이) */
export async function nearbyFoodFree(center, meal, radius = 800) {
  const q = `[out:json][timeout:15];nwr(around:${radius},${center.lat},${center.lng})[amenity~"^(${FOOD_TYPES[meal].osm})$"][name];out center 30;`;
  // 무료 서버는 가끔 바쁘거나 막혀 있어서 여러 곳을 차례로 시도
  const servers = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
  let json = null;
  // 서버들을 차례로 시도하고, 모두 실패하면 2초 쉬고 한 바퀴 더
  for (let round = 0; round < 2 && !json; round++) {
    if (round) await new Promise(r => setTimeout(r, 2000));
    for (const s of servers) {
      const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 8000); // 8초 안에 답 없으면 다음 서버
      try {
        const res = await fetch(`${s}?data=${encodeURIComponent(q)}`, { signal: ctl.signal });
        if (res.ok) { json = await res.json(); break; }
      } catch { /* 다음 서버로 */ } finally { clearTimeout(timer); }
    }
  }
  if (!json) throw new Error('무료 지도 서버가 응답하지 않아요. 잠시 뒤 다시 해 보세요');
  const KIND = { cafe: '카페', restaurant: '식당', bakery: '베이커리', fast_food: '간편식', food_court: '푸드코트', pub: '펍', bar: '바' };
  return (json.elements || []).map(e => {
    const t = e.tags || {};
    return {
      name: t['name:ko'] || t.name, address: [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' '),
      lat: e.lat ?? e.center?.lat, lng: e.lon ?? e.center?.lon,
      rating: null, reviews: 0,
      kind: [KIND[t.amenity] || t.amenity, t.cuisine?.split(';')[0]].filter(Boolean).join(' · '),
      hours: t.opening_hours || '',
    };
  }).filter(r => r.name && r.lat != null);
}

/** 장소 이름이나 주소로 좌표 찾기 */
export async function searchPlace(key, query) {
  const json = await post(
    'https://places.googleapis.com/v1/places:searchText',
    key,
    'places.location,places.displayName,places.formattedAddress',
    { textQuery: query, languageCode: 'ko', maxResultCount: 1 },
  );
  const p = json.places?.[0];
  if (!p?.location) return null;
  return { lat: p.location.latitude, lng: p.location.longitude, address: p.formattedAddress || '' };
}

export function decodePolyline(str) {
  const pts = [];
  let i = 0, lat = 0, lng = 0;
  while (i < str.length) {
    for (const k of [0, 1]) {
      let b, shift = 0, res = 0;
      do { b = str.charCodeAt(i++) - 63; res |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const d = res & 1 ? ~(res >> 1) : res >> 1;
      if (k === 0) lat += d; else lng += d;
    }
    pts.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return pts;
}

// 한국 안인지 (구글은 한국에서 도보·자동차 길찾기를 제공하지 않음)
export const inKorea = p => !!p && p.lat > 33 && p.lat < 38.9 && p.lng > 124.5 && p.lng < 131.5;

const OSRM = { WALK: 'routed-foot/route/v1/foot', BICYCLE: 'routed-bike/route/v1/bike', DRIVE: 'routed-car/route/v1/car' };
const TURN = { left: '좌회전', right: '우회전', 'slight left': '왼쪽 방향', 'slight right': '오른쪽 방향', 'sharp left': '크게 좌회전', 'sharp right': '크게 우회전', straight: '직진', uturn: '유턴' };

/** 무료 OpenStreetMap 길찾기(도보/자전거/차). 구글 경로가 없을 때(한국, API 키 없음) 사용 */
export async function fetchRouteFree(from, to, mode) {
  const path = OSRM[mode];
  if (!path) return [];
  const url = `https://routing.openstreetmap.de/${path}/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=polyline&steps=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`무료 길찾기 실패 (${res.status})`);
  const json = await res.json();
  return (json.routes || []).map(r => {
    // 몇 m짜리 자잘한 꺾임은 빼고 안내
    const steps = (r.legs?.[0]?.steps || []).filter(s => s.distance >= 10 || ['depart', 'arrive'].includes(s.maneuver.type)).map(s => {
      const m = s.maneuver, name = s.name ? ` · ${s.name}` : '';
      if (m.type === 'depart') return `출발${name}`;
      if (m.type === 'arrive') return '도착';
      return `${TURN[m.modifier] || '계속 직진'}${name} (${Math.round(s.distance)}m)`;
    });
    return {
      dur: Math.max(1, Math.round(r.duration / 60)),
      dist: Math.round(r.distance),
      poly: r.geometry,
      free: true,
      segs: [{ type: mode === 'WALK' ? 'WALK' : 'MOVE', dur: Math.round(r.duration / 60), dist: Math.round(r.distance), steps }],
    };
  });
}

/** 구글 경로 → 없으면 무료 경로로 대신 */
export async function routeFor(key, from, to, mode, departAt) {
  let routes = [], err = null;
  if (key && !(inKorea(from) && inKorea(to) && mode !== 'TRANSIT')) {
    try { routes = await fetchRoutes(key, from, to, mode, departAt); } catch (e) { err = e; }
  }
  if (!routes.length && OSRM[mode]) {
    try { routes = await fetchRouteFree(from, to, mode); } catch (e) { err ||= e; }
  }
  if (!routes.length && err) throw err;
  return routes;
}

// 길안내 앱 열기: 한국 안이면 카카오맵(도보·자동차 길안내 가능), 아니면 구글맵
export function navUrl(from, to, mode, name = '목적지') {
  if (inKorea(to)) return `https://map.kakao.com/link/to/${encodeURIComponent(name)},${to.lat},${to.lng}`;
  return googleNavUrl(from, to, mode);
}

function googleNavUrl(from, to, mode) {
  const gm = { WALK: 'walking', TRANSIT: 'transit', DRIVE: 'driving', BICYCLE: 'bicycling' }[mode] || 'transit';
  const q = new URLSearchParams({ api: '1', destination: `${to.lat},${to.lng}`, travelmode: gm, dir_action: 'navigate' });
  if (from) q.set('origin', `${from.lat},${from.lng}`);
  return `https://www.google.com/maps/dir/?${q}`;
}

export function placeUrl(p) {
  return `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`;
}
