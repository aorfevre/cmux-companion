"use client";
/* eslint-disable @next/next/no-img-element */

import { useCallback, useRef, useState } from "react";

export type ImageAttachment = { path: string; name: string; mime: string; size: number; preview: string };

export const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGE_COUNT = 4;
const ACCEPT = "image/png,image/jpeg,image/gif,image/webp";

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { ...(init?.body != null ? { "Content-Type": "application/json" } : {}), ...init?.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body as T;
}

export function imageDataUrl(file: File) { return new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error("Could not read that image")); reader.readAsDataURL(file); }); }

// The paths travel inside the prompt because each agent runs in its own
// worktree and reads the file itself.
export function imagePromptLines(attachments: { path: string }[]) {
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
export function useImageAttachments(onNotice: (message: string) => void) {
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const count = attachments.length;

  const addImages = useCallback(async (files: File[]) => {
    const available = MAX_IMAGE_COUNT - count;
    if (available <= 0) { onNotice("You can attach up to four images at a time"); return; }
    if (files.length > available) onNotice("Only the first four images were added");
    const selected = files.slice(0, available);
    const valid = selected.filter((file) => {
      if (!IMAGE_TYPES.has(file.type)) { onNotice(`${file.name || "That file"} is not a supported image`); return false; }
      if (file.size > MAX_IMAGE_BYTES) { onNotice(`${file.name || "That image"} must be 8 MB or smaller`); return false; }
      return true;
    });
    if (!valid.length) return;
    setUploading((pending) => pending + valid.length);
    const uploaded = await Promise.all(valid.map(async (file) => {
      try {
        const dataUrl = await imageDataUrl(file);
        const result = await request<{ image: Omit<ImageAttachment, "preview"> }>("/api/attachments/images", { method: "POST", body: JSON.stringify({ dataUrl, name: file.name || "pasted image" }) });
        return { ...result.image, preview: dataUrl };
      } catch (cause) { onNotice(cause instanceof Error ? cause.message : "Could not attach image"); return null; }
      finally { setUploading((pending) => Math.max(0, pending - 1)); }
    }));
    setAttachments((current) => [...current, ...uploaded.filter((image): image is ImageAttachment => image != null)].slice(0, MAX_IMAGE_COUNT));
  }, [count, onNotice]);

  const pasteImages = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const images = [...event.clipboardData.items].filter((item) => item.type.startsWith("image/")).map((item) => item.getAsFile()).filter((file): file is File => Boolean(file));
    if (!images.length) return;
    event.preventDefault();
    void addImages(images);
  }, [addImages]);

  const removeImage = useCallback((path: string) => setAttachments((current) => current.filter((item) => item.path !== path)), []);

  return { attachments, uploading, inputRef, addImages, pasteImages, removeImage };
}

export function AttachmentStrip({ attachments, className = "", onRemove }: { attachments: ImageAttachment[]; className?: string; onRemove: (path: string) => void }) {
  if (!attachments.length) return null;
  return <div className={`attachment-strip worktree-attachments ${className}`.trim()}>{attachments.map((image) => <div key={image.path}>
    <img src={image.preview} alt={image.name} />
    <span>{image.name}</span>
    <button type="button" aria-label={`Remove ${image.name}`} onClick={() => onRemove(image.path)}>×</button>
  </div>)}</div>;
}

export function ImagePickerButton({ attachments, disabled, inputRef, label = "Choose images", onFiles }: { attachments: ImageAttachment[]; disabled: boolean; inputRef: React.RefObject<HTMLInputElement | null>; label?: string; onFiles: (files: File[]) => void }) {
  return <>
    <input ref={inputRef} className="image-input" aria-label={label} type="file" accept={ACCEPT} multiple onChange={(event) => { onFiles([...(event.currentTarget.files || [])]); event.currentTarget.value = ""; }} />
    <button type="button" className="worktree-add-images" disabled={disabled || attachments.length >= MAX_IMAGE_COUNT} onClick={() => inputRef.current?.click()}>＋ Image{attachments.length ? ` · ${attachments.length}/${MAX_IMAGE_COUNT}` : ""}</button>
  </>;
}
