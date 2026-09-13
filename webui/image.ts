// Client-side image helpers for the composer. All DOM-dependent (FileReader,
// canvas), so this module is kept separate from the no-DOM util.js.

// Formats the LLM backend is guaranteed to decode. Anything else (iOS HEIC/
// HEIF camera captures, AVIF, TIFF, …) is re-encoded to one of these before
// being sent.
const SEND_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

// Maximum megapixels before we downscale. ~4 MP covers most phone cameras and
// keeps the base64 payload reasonable for the 25mb JSON body limit.
const MAX_MEGAPIXELS = 4;

// True for a file we'll accept as an attachment. We take any `image/*` type
// (SVG is the one exclusion — canvas taint + unbounded size) and we *also*
// accept a file whose type is empty/unknown: some mobile browsers (notably
// iOS Safari) report no MIME for a pasted image, and the real validation
// happens later, at decode time in prepareImageDataURL, which surfaces a clear
// error if the bytes can't be decoded.
export const isImageFile = (file: File) => {
  const t = (file?.type ?? '').toLowerCase();
  if (t === 'image/svg+xml') return false;
  return t.startsWith('image/') || t === '';
};

// Read a File / Blob as a base64 data-URL.
export const fileToDataURL = (file: File) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });

// Decode the data-URL, downscale it if it exceeds the 4 MP cap, and re-encode
// it if its format isn't one the backend accepts (e.g. an iOS HEIC capture →
// PNG). Decoding is what actually validates the bytes, so an un-decodable
// image (e.g. HEIC in a non-Safari browser) rejects here with a real error.
// Returns the (possibly new) data-URL.
export const prepareImageDataURL = async (dataUrl: string) => {
  const mime = (dataUrl.split(',')[0].split(':')[1] ?? '').toLowerCase();
  const img = await loadImage(dataUrl);
  const mp = (img.naturalWidth * img.naturalHeight) / 1_000_000;
  const needsResize = mp > MAX_MEGAPIXELS;
  const needsReencode = !SEND_MIMES.includes(mime);
  if (!needsResize && !needsReencode) return dataUrl; // already fine

  const scale = needsResize ? Math.sqrt(MAX_MEGAPIXELS / mp) : 1;
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(img, 0, 0, w, h);
  return canvas.toDataURL('image/png');
};

// Internal: create an <img> and wait for it to decode.
const loadImage = (src: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('failed to decode image'));
    img.src = src;
  });
