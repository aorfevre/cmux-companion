"use client";
/* eslint-disable @next/next/no-img-element */

import { ImageUploadSession } from "./image-upload-session";
import { request } from "./api-request";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

export type ImageAttachment = { path: string; name: string; mime: string; size: number; preview: string };

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_COUNT = 4;
const ACCEPT = "image/png,image/jpeg,image/gif,image/webp";

export { request } from "./api-request";

function imageDataUrl(file: File) { return new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error("Could not read that image")); reader.readAsDataURL(file); }); }

// The paths travel inside the prompt because each agent runs in its own
// worktree and reads the file itself.
function imagePromptLines(attachments: { path: string }[]) {
  if (!attachments.length) return "";
  return [`Attached image${attachments.length > 1 ? "s" : ""}:`, ...attachments.map((image) => `- ${image.path}`)].join("\n");
}

export function composedPrompt(draft: string, attachments: { path: string }[]) {
  return [draft.trim(), imagePromptLines(attachments)].filter(Boolean).join("\n\n");
}

export function imageReferences(attachments: ImageAttachment[]) {
  return attachments.map((image) => ({ path: image.path, name: image.name }));
}

// One uploader for every sheet: it validates the files, saves each one through
// the attachments route, and reports each failure through the notice callback.
export function useImageAttachments(onNotice: (message: string) => void, ownerKey = "sheet") {
  const owner = useMemo(() => new ImageUploadSession(ownerKey), [ownerKey]);
  const [snapshot, setSnapshot] = useState({ owner, images: owner.images, pending: 0 });
  const inputRef = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    owner.activate();
    return () => owner.deactivate();
  }, [owner]);
  const publish = useCallback(() => {
    if (owner.active) setSnapshot({ owner, images: [...owner.images], pending: owner.pending });
  }, [owner]);
  const addImages = useCallback(async (files: File[]) => {
    if (!owner.active) return;
    const available = MAX_IMAGE_COUNT - owner.images.length - owner.pending;
    if (available <= 0) { onNotice("You can attach up to four images at a time"); return; }
    if (files.length > available) onNotice("Only the first four images were added");
    const valid = files.slice(0, available).filter((file) => {
      if (!IMAGE_TYPES.has(file.type)) { onNotice(`${file.name || "That file"} is not a supported image`); return false; }
      if (file.size > MAX_IMAGE_BYTES) { onNotice(`${file.name || "That image"} must be 8 MB or smaller`); return false; }
      return true;
    });
    if (!valid.length) return;
    const generation = owner.reserve(valid.length);
    // Reserve before any await so simultaneous paste/picker events cannot
    // upload beyond the cap or append into a different terminal/sheet.
    publish();
    const current = () => owner.active && owner.generation === generation;
    const uploaded = await Promise.all(valid.map(async (file) => {
      try {
        const dataUrl = await imageDataUrl(file);
        if (!current()) return null;
        const result = await request<{ image: Omit<ImageAttachment, "preview"> }>("/api/attachments/images", { method: "POST", body: JSON.stringify({ dataUrl, name: file.name || "pasted image" }) });
        return { ...result.image, preview: dataUrl };
      } catch (cause) { if (current()) onNotice(cause instanceof Error ? cause.message : "Could not attach image"); return null; }
    }));
    if (!current()) return;
    owner.finish(valid.length, uploaded.filter((image): image is ImageAttachment => image != null));
    publish();
  }, [owner, onNotice, publish]);
  const pasteImages = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const images = [...event.clipboardData.items].filter((item) => item.type.startsWith("image/")).map((item) => item.getAsFile()).filter((file): file is File => Boolean(file));
    if (!images.length) return;
    event.preventDefault();
    void addImages(images);
  }, [addImages]);
  const removeImage = useCallback((path: string) => {
    owner.remove(path);
    publish();
  }, [owner, publish]);
  const clearAttachments = useCallback(() => {
    owner.clear();
    publish();
  }, [owner, publish]);
  return { attachments: snapshot.owner === owner ? snapshot.images : [], uploading: snapshot.owner === owner ? snapshot.pending : 0, inputRef, addImages, pasteImages, removeImage, clearAttachments };
}

export function AttachmentStrip({ attachments, className = "worktree-attachments", onRemove }: { attachments: ImageAttachment[]; className?: string; onRemove: (path: string) => void }) {
  if (!attachments.length) return null;
  return <div className={`attachment-strip ${className}`.trim()}>{attachments.map((image) => <div key={image.path}>
    <img src={image.preview} alt={image.name} />
    <span>{image.name}</span>
    <button type="button" aria-label={`Remove ${image.name}`} onClick={() => onRemove(image.path)}>×</button>
  </div>)}</div>;
}

// The review panel shows what was sent, so it has no remove button. A draft
// restored in a new sheet holds paths but no preview data URL, so it names the
// file instead of rendering a broken image.
export function AttachmentReview({ attachments }: { attachments: { path: string; name: string; preview?: string }[] }) {
  if (!attachments.length) return null;
  return <div className="attachment-strip worktree-attachments review">{attachments.map((image) => <div key={image.path}>
    {image.preview ? <img src={image.preview} alt={image.name} /> : <em className="attachment-missing" aria-hidden="true">no preview</em>}
    <span>{image.name}</span>
  </div>)}</div>;
}

export function ImagePickerButton({ attachments, disabled, inputRef, label = "Choose images", onFiles }: { attachments: ImageAttachment[]; disabled: boolean; inputRef: React.RefObject<HTMLInputElement | null>; label?: string; onFiles: (files: File[]) => void }) {
  return <>
    <input ref={inputRef} className="image-input" aria-label={label} type="file" accept={ACCEPT} multiple onChange={(event) => { onFiles([...(event.currentTarget.files || [])]); event.currentTarget.value = ""; }} />
    <button type="button" className="worktree-add-images" disabled={disabled || attachments.length >= MAX_IMAGE_COUNT} onClick={() => inputRef.current?.click()}>＋ Image{attachments.length ? ` · ${attachments.length}/${MAX_IMAGE_COUNT}` : ""}</button>
  </>;
}
