// Screenshots from large monitors can be several MB. Vercel Functions accept at most 4.5 MB per
// request, so big images are scaled down and re-encoded in the browser before upload. This also
// strips photo metadata (such as location) from the file.

const MAX_EDGE = 2000;
const SHRINK_ABOVE_BYTES = 900 * 1024;

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read image'));
    };
    img.src = url;
  });
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** Returns the file ready to upload (resized if large), or null if it is not a readable image. */
export async function prepareImage(file: File): Promise<File | null> {
  let img: HTMLImageElement;
  try {
    img = await loadImage(file);
  } catch {
    return null;
  }
  const longest = Math.max(img.naturalWidth, img.naturalHeight);
  if (file.size <= SHRINK_ABOVE_BYTES && longest <= MAX_EDGE) return file;

  const scale = Math.min(1, MAX_EDGE / longest);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) return file;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  // Prefer WebP; fall back to JPEG on browsers that cannot encode WebP.
  let blob = await toBlob(canvas, 'image/webp', 0.85);
  let ext = 'webp';
  if (!blob || blob.type !== 'image/webp') {
    blob = await toBlob(canvas, 'image/jpeg', 0.85);
    ext = 'jpg';
  }
  if (!blob || blob.size >= file.size) return file;
  const base = file.name.replace(/\.[^.]+$/, '') || 'screenshot';
  return new File([blob], `${base}.${ext}`, { type: blob.type });
}
