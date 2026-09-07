import type { ImageAttachment } from "./image-attachments";

// Mutable upload ownership stays outside React snapshots; consumers receive
// copies. One instance belongs to one terminal/sheet identity.
export class ImageUploadSession {
  active = false;
  generation = 0;
  pending = 0;
  images: ImageAttachment[] = [];
  constructor(readonly key: string) {}
  activate() { this.active = true; }
  deactivate() { this.active = false; this.generation++; }
  reserve(count: number) { this.pending += count; return this.generation; }
  finish(count: number, images: ImageAttachment[]) { this.pending -= count; this.images.push(...images); }
  remove(path: string) { this.images = this.images.filter(image => image.path !== path); }
  clear() { this.generation++; this.pending = 0; this.images = []; }
}
