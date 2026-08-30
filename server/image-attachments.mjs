import { chmod, mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_ATTACHMENT_DIRECTORY = join(homedir(), ".config", "cmux-companion", "attachments");

function imageType(buffer) {
  if (buffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return { mime: "image/png", extension: "png" };
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { mime: "image/jpeg", extension: "jpg" };
  if (["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"))) return { mime: "image/gif", extension: "gif" };
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return { mime: "image/webp", extension: "webp" };
  return null;
}

export class ImageAttachments {
  constructor({ directory = DEFAULT_ATTACHMENT_DIRECTORY, maxBytes = MAX_IMAGE_BYTES } = {}) {
    this.directory = directory;
    this.maxBytes = maxBytes;
  }

  async save(dataUrl, originalName = "pasted image") {
    if (typeof dataUrl !== "string" || !/^data:image\/[a-z0-9.+-]+;base64,/i.test(dataUrl)) throw new TypeError("Choose a valid image");
    const encoded = dataUrl.slice(dataUrl.indexOf(",") + 1);
    if (!encoded || encoded.length > Math.ceil(this.maxBytes * 4 / 3) + 8) throw new TypeError("Image must be 8 MB or smaller");
    const buffer = Buffer.from(encoded, "base64");
    if (!buffer.length || buffer.length > this.maxBytes) throw new TypeError("Image must be 8 MB or smaller");
    const type = imageType(buffer);
    if (!type) throw new TypeError("Use a PNG, JPEG, GIF, or WebP image");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    await this.cleanup();
    const filename = `${Date.now()}-${randomUUID()}.${type.extension}`;
    const path = join(this.directory, filename);
    await writeFile(path, buffer, { mode: 0o600, flag: "wx" });
    return {
      path,
      name: typeof originalName === "string" && originalName.trim() ? originalName.trim().slice(0, 200) : "pasted image",
      mime: type.mime,
      size: buffer.length,
    };
  }

  async cleanup(maxAgeMs = 7 * 24 * 60 * 60 * 1_000) {
    const entries = await readdir(this.directory).catch(() => []);
    const cutoff = Date.now() - maxAgeMs;
    await Promise.all(entries.map(async (name) => {
      const path = join(this.directory, name);
      const details = await stat(path).catch(() => null);
      if (details?.isFile() && details.mtimeMs < cutoff) await unlink(path).catch(() => {});
    }));
  }
}
