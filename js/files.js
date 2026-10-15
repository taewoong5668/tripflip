// 일정에 붙이는 사진·PDF(바우처, 예약 티켓) 보관함. 용량이 커서 localStorage 대신 IndexedDB에 저장

const DB_NAME = 'tripflip-files', STORE = 'files';
let dbp = null;

function db() {
  dbp ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode), s = t.objectStore(STORE);
    const r = fn(s);
    t.oncomplete = () => resolve(r?.result);
    t.onerror = () => reject(t.error);
  });
}

const newFileId = () => `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

// 큰 사진은 긴 변 2000px JPEG로 줄여 저장 (바우처 글씨는 충분히 읽힘)
async function shrinkImage(file) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 1.5e6) return file;
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise(r => c.toBlob(b => r(b || file), 'image/jpeg', 0.85));
  } catch {
    return file;
  }
}

/** 파일을 저장하고 일정에 붙일 정보 {id, name, type} 반환 */
export async function saveFile(file) {
  const blob = await shrinkImage(file);
  const meta = { id: newFileId(), name: file.name || '첨부', type: blob.type || file.type || 'application/octet-stream' };
  await tx('readwrite', s => s.put({ ...meta, blob, created: Date.now() }));
  return meta;
}

export async function getFile(id) {
  return tx('readonly', s => s.get(id));
}

export async function deleteFile(id) {
  return tx('readwrite', s => s.delete(id));
}

export const isPdf = f => /pdf/i.test(f.type) || /\.pdf$/i.test(f.name);

// PDF를 페이지별 그림(canvas)으로 그림
let pdfjs = null;
export async function renderPdf(blob, container) {
  if (!pdfjs) {
    pdfjs = await import('../lib/pdfjs/pdf.min.js?v=202610160144');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('../lib/pdfjs/pdf.worker.min.js', import.meta.url).href;
  }
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
  const width = Math.min(container.clientWidth || 360, 900);
  for (let p = 1; p <= Math.min(pdf.numPages, 20); p++) {
    const page = await pdf.getPage(p);
    const base = page.getViewport({ scale: 1 });
    const scale = (width / base.width) * (window.devicePixelRatio || 1);
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = vp.width; canvas.height = vp.height;
    canvas.style.width = `${width}px`;
    container.appendChild(canvas);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  }
}
