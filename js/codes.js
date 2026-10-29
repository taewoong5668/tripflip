// 첨부(사진·PDF)에서 QR·바코드 찾기 → 그 부분만 잘라 크게 보여 줄 그림으로.
// 휴대폰 기본 기능(BarcodeDetector)을 먼저 쓰고, 없거나 못 찾으면 zxing(인터넷 없이 동작)

/** QR처럼 네모난(2차원) 코드인지 */
export const is2D = f => /qr|aztec|matrix|pdf417|maxi/i.test(f || '');
/** 버튼·제목에 쓸 이름 */
export const codeName = f => /qr/i.test(f || '') ? 'QR' : '바코드';

/** 코드 모서리 점들 → 잘라낼 네모 (여백 포함, 그림 밖으로 안 나가게). 막대 바코드는 위아래가 얇게 잡혀서 높이를 늘림 */
export function cropRect(pts, format, W, H) {
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const w = x1 - x0;
  if (!is2D(format) && y1 - y0 < w * 0.35) { const c = (y0 + y1) / 2; y0 = c - w * 0.175; y1 = c + w * 0.175; }
  const pad = Math.max(w, y1 - y0) * 0.08 + 4;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
  x1 = Math.min(W, x1 + pad); y1 = Math.min(H, y1 + pad);
  return { x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0) };
}

let zx = null;
function loadZxing() {
  const lib = p => new URL(`../lib/zxing/${p}`, import.meta.url).href;
  return zx ||= new Promise((ok, no) => {
    const s = document.createElement('script');
    s.src = lib('zxing.js');
    s.onload = () => {
      window.ZXingWASM.prepareZXingModule({ overrides: { locateFile: (p, pre) => p.endsWith('.wasm') ? lib('zxing_reader.wasm') : pre + p } });
      ok(window.ZXingWASM);
    };
    s.onerror = () => { zx = null; no(new Error('zxing를 불러오지 못했어요')); };
    document.head.append(s);
  });
}

async function native(c) {
  if (!('BarcodeDetector' in window)) return [];
  try {
    if (!(await BarcodeDetector.getSupportedFormats()).length) return [];
    return (await new BarcodeDetector().detect(c)).map(r => ({ format: r.format, text: r.rawValue, pts: r.cornerPoints }));
  } catch { return []; }
}

async function zxing(c) {
  const Z = await loadZxing();
  const res = await Z.readBarcodes(c.getContext('2d').getImageData(0, 0, c.width, c.height));
  return res.filter(r => r.isValid).map(r => {
    const p = r.position;
    return { format: r.format, text: r.text, pts: [p.topLeft, p.topRight, p.bottomRight, p.bottomLeft] };
  });
}

/** 사진(img)이나 PDF 쪽(canvas)에서 코드 찾기 → [{ format, text, url(잘라낸 그림) }] */
export async function findCodes(src) {
  const W0 = src.naturalWidth || src.width, H0 = src.naturalHeight || src.height;
  if (!W0 || !H0) return [];
  const s = Math.min(1, 2000 / Math.max(W0, H0));
  const c = document.createElement('canvas');
  c.width = Math.round(W0 * s); c.height = Math.round(H0 * s);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); // 투명한 그림도 흰 바탕에
  g.drawImage(src, 0, 0, c.width, c.height);
  let hits = await native(c);
  if (!hits.length) hits = await zxing(c).catch(() => []);
  return hits.map(h => {
    const r = cropRect(h.pts, h.format, c.width, c.height);
    const out = document.createElement('canvas');
    out.width = r.w; out.height = r.h;
    out.getContext('2d').drawImage(c, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    return { format: h.format, text: h.text || '', two: is2D(h.format), url: out.toDataURL('image/png') };
  });
}
