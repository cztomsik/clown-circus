// Client-side image helpers for the composer. All DOM-dependent (FileReader,
// canvas), so this module is kept separate from the no-DOM util.js.

// Accepted image MIME types (raster only; SVG excluded due to taint/size issues).
export const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

// Maximum megapixels before we downscale. ~4 MP covers most phone cameras and
// keeps the base64 payload reasonable for the 25mb JSON body limit.
const MAX_MEGAPIXELS = 4;

// Read a File / Blob as a base64 data-URL.
export const fileToDataURL = (file) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });

// If the image exceeds MAX_MEGAPIXELS, downscale it via canvas and re-encode
// as PNG (lossless, good for screenshots and photos alike). Returns the
// (possibly new) data-URL.
export const capImageDataURLSize = async (dataUrl) => {
  const img = await loadImage(dataUrl);
  const mp = (img.naturalWidth * img.naturalHeight) / 1_000_000;
  if (mp <= MAX_MEGAPIXELS) return dataUrl; // already small enough

  const scale = Math.sqrt(MAX_MEGAPIXELS / mp);
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL('image/png');
};

// Internal: create an <img> and wait for it to decode.
const loadImage = (src) =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('failed to decode image'));
    img.src = src;
  });
