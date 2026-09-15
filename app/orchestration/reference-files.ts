/** Pure helpers for goal reference intake from the file picker, clipboard paste and drag-and-drop.
 * The server (server/orchestration/goal-references.mjs) remains authoritative: it infers the type from the
 * filename extension, enforces 8 files x 1 MiB and rejects unsupported binaries. These helpers only give
 * clipboard images safe names and reject up front what the server would certainly reject.
 */
export const REFERENCE_MAX_FILES = 8;
export const REFERENCE_MAX_BYTES = 1024 * 1024;
export const REFERENCE_LIMIT_ERROR = 'Attach up to 8 nonempty files, at most 1 MiB each.';
export const UNSUPPORTED_IMAGE_ERROR = 'Paste or drop PNG, JPEG or WebP images. GIF and other image formats are not supported.';
/** Raster image MIME types the server accepts, mapped to the extension it recognises. */
export const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
/** Raster image MIME types the server rejects by extension. Anything else (SVG, HTML, text, unknown) is left to the server. */
export const UNSUPPORTED_IMAGE_TYPES: readonly string[] = ['image/gif', 'image/heic', 'image/heif', 'image/avif', 'image/bmp', 'image/tiff', 'image/x-icon', 'image/vnd.microsoft.icon'];
const GENERIC_CLIPBOARD_NAMES = new Set(['image.png', 'image.jpg', 'image.jpeg', 'image.webp', 'image', 'blob']);
const EXTENSION_TYPES: Readonly<Record<string, string>> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

type FileLike = Pick<File, 'name' | 'size' | 'type'>;
type TransferLike = { files?: ArrayLike<File> | null; items?: ArrayLike<{ kind?: string; type?: string; getAsFile?: () => File | null }> | null; types?: ArrayLike<string> | null } | null | undefined;

/** Files carried by a clipboard or drag transfer. `files` wins; `items` is only a fallback because browsers
 * expose the same file through both and `getAsFile()` returns a distinct File object each time.
 */
export function filesFromDataTransfer(data: TransferLike): File[] {
  if (!data) return [];
  const files = Array.from(data.files ?? []).filter(Boolean);
  if (files.length) return files;
  const items = Array.from(data.items ?? []);
  const fallback: File[] = [];
  for (const item of items) {
    if (item?.kind !== 'file' || typeof item.getAsFile !== 'function') continue;
    const file = item.getAsFile();
    if (file) fallback.push(file);
  }
  return fallback;
}

/** Whether a drag transfer carries files (as opposed to text or links). */
export function transferHasFiles(data: TransferLike): boolean {
  if (!data) return false;
  if (Array.from(data.types ?? []).includes('Files')) return true;
  if (Array.from(data.files ?? []).length) return true;
  return Array.from(data.items ?? []).some(item => item?.kind === 'file');
}

// eslint-disable-next-line no-control-regex -- Strip path separators and control characters from user-supplied names.
const sanitise = (name: string) => name.replace(/[\\/\x00-\x1f\x7f]/g, '').trim();
const extensionOf = (name: string) => { const match = /\.([^.]+)$/.exec(name); return match ? match[1].toLowerCase() : ''; };

/** A safe filename whose extension matches the server type for supported raster images.
 * Unnamed or generically named clipboard images become pasted-image-N.<ext>, avoiding names in `taken`.
 */
export function nameReferenceFile(file: FileLike, taken: ReadonlySet<string>): string {
  const imageExtension = IMAGE_EXTENSIONS[file.type];
  let name = sanitise(file.name ?? '');
  if (!name || name === '.' || name === '..' || GENERIC_CLIPBOARD_NAMES.has(name.toLowerCase())) {
    const extension = imageExtension ?? extensionOf(name);
    for (let counter = 1; ; counter += 1) {
      const candidate = `pasted-image-${counter}${extension ? `.${extension}` : ''}`;
      if (!taken.has(candidate)) return candidate;
    }
  }
  if (imageExtension && EXTENSION_TYPES[extensionOf(name)] !== file.type) name = `${name}.${imageExtension}`;
  return name;
}

/** Client-side validation of a whole batch. Either every file passes or none is added. */
export function validateReferenceFiles(files: File[], existingCount: number): { files: File[]; error: string | null } {
  if (existingCount + files.length > REFERENCE_MAX_FILES || files.some(file => !file.size || file.size > REFERENCE_MAX_BYTES)) return { files: [], error: REFERENCE_LIMIT_ERROR };
  if (files.some(file => UNSUPPORTED_IMAGE_TYPES.includes(file.type))) return { files: [], error: UNSUPPORTED_IMAGE_ERROR };
  return { files, error: null };
}
