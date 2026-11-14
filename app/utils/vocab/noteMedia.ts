// 068 录入笔记：把图片 / PDF 变成「一页一张、长边 ≤2000px 的 JPEG」，并生成缩略图。
// 只在浏览器 / WebView 里用（要 canvas）；纯规则在 noteImport.ts。
import { fitLongEdge, NOTE_LONG_EDGE, noteFileKind, type NoteFileKind } from './noteImport';

export interface NotePage {
  id: string;
  /** 给人看的来源，例如「照片 1.jpg」「讲义.pdf 第 2 页」 */
  label: string;
  /** 缩略图 data URL（CSP 的 img-src 放行 data:，不放行 blob:） */
  thumb: string;
  base64: string;
  mimeType: 'image/jpeg';
}

const JPEG_QUALITY = 0.85;
const THUMB_EDGE = 160;
let counter = 0;
const newId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${counter++}`;

const canvasToJpegBase64 = (canvas: HTMLCanvasElement): string => {
  const url = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  return url.slice(url.indexOf(',') + 1);
};

/** 把任意 canvas 画到白底的新 canvas（JPEG 不支持透明），长边缩到 maxEdge。 */
const drawScaled = (source: CanvasImageSource, width: number, height: number, maxEdge: number): HTMLCanvasElement => {
  const size = fitLongEdge(width, height, maxEdge);
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('当前环境不能处理图片。');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, size.width, size.height);
  ctx.drawImage(source, 0, 0, size.width, size.height);
  return canvas;
};

const toPage = (label: string, source: CanvasImageSource, width: number, height: number): NotePage => {
  const full = drawScaled(source, width, height, NOTE_LONG_EDGE);
  const thumb = drawScaled(full, full.width, full.height, THUMB_EDGE);
  return {
    id: newId(),
    label,
    thumb: thumb.toDataURL('image/jpeg', 0.7),
    base64: canvasToJpegBase64(full),
    mimeType: 'image/jpeg',
  };
};

const decodeImage = async (file: File, kind: NoteFileKind): Promise<ImageBitmap | HTMLImageElement> => {
  try {
    return await createImageBitmap(file);
  } catch {
    // 兜底：用 <img> 解码（老 WebView 没有 createImageBitmap 的某些选项时）
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(kind === 'heic'
        ? `「${file.name}」是 HEIC 格式，当前设备读不了，请先转成 JPG 或用扫描软件扫成 PDF。`
        : `读取「${file.name}」失败，图片可能已损坏。`));
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
};

export const imageFileToPage = async (file: File, label = file.name): Promise<NotePage> => {
  const kind = noteFileKind(file);
  if (!kind || kind === 'pdf') throw new Error(`「${file.name}」不是图片。`);
  const image = await decodeImage(file, kind);
  const width = 'naturalWidth' in image ? image.naturalWidth : image.width;
  const height = 'naturalHeight' in image ? image.naturalHeight : image.height;
  if (!width || !height) throw new Error(`读取「${file.name}」失败，图片可能已损坏。`);
  try {
    return toPage(label, image, width, height);
  } finally {
    if ('close' in image) image.close();
  }
};

// ---- PDF ----

type PdfModule = typeof import('pdfjs-dist');
let pdfModule: Promise<PdfModule> | null = null;

/** 懒加载 pdf.js；worker 用打包进应用的同源文件（CSP 的 script-src 'self' 即可，不用放开）。 */
const loadPdf = (): Promise<PdfModule> => {
  pdfModule ??= (async () => {
    // legacy 版兼容老安卓 WebView。
    // 用 Vite 的 ?worker：worker 被打成一个同源 .js 文件（不走 blob、不走 CDN），MIME 也最稳。
    const [lib, worker] = await Promise.all([
      import('pdfjs-dist/legacy/build/pdf.mjs'),
      import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?worker'),
    ]);
    lib.GlobalWorkerOptions.workerPort = new (worker as { default: new () => Worker }).default();
    return lib as unknown as PdfModule;
  })().catch(error => { pdfModule = null; throw error; });
  return pdfModule;
};

export interface PdfOpened {
  numPages: number;
  /** 渲染第 n 页（1 起）。 */
  render: (pageNumber: number) => Promise<NotePage>;
  destroy: () => void;
}

const pdfErrorText = (name: string, file: string, error: unknown): Error => {
  const errName = (error as { name?: string } | null)?.name ?? '';
  if (errName === 'PasswordException') return new Error(`「${file}」有密码保护，请先去掉密码，或用扫描软件重新扫一份。`);
  if (errName === 'InvalidPDFException' || errName === 'FormatError') return new Error(`「${file}」不是有效的 PDF，或文件已损坏。`);
  return new Error(`读取 PDF「${file}」失败，请换一份或用扫描软件重新扫。`);
};

export const openPdf = async (file: File): Promise<PdfOpened> => {
  const lib = await loadPdf();
  const data = new Uint8Array(await file.arrayBuffer());
  let doc;
  try {
    doc = await lib.getDocument({ data }).promise;
  } catch (error) {
    throw pdfErrorText('open', file.name, error);
  }
  return {
    numPages: doc.numPages,
    render: async pageNumber => {
      try {
        const page = await doc.getPage(pageNumber);
        const base = page.getViewport({ scale: 1 });
        const scale = NOTE_LONG_EDGE / Math.max(base.width, base.height);
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(viewport.width));
        canvas.height = Math.max(1, Math.round(viewport.height));
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('当前环境不能处理图片。');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, canvas, viewport }).promise;
        page.cleanup();
        return toPage(`${file.name} 第 ${pageNumber} 页`, canvas, canvas.width, canvas.height);
      } catch (error) {
        throw pdfErrorText('render', file.name, error);
      }
    },
    destroy: () => { void doc.destroy(); },
  };
};
