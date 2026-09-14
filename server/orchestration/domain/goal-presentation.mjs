import { text } from './contracts.mjs';
/** Stable readable code; project settings need no extra required field. @param {unknown} value */
export function projectCode(value) {
  return text(value, 500).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'PROJECT';
}
/** Keep the full request separately; URLs must not dominate the card title. @param {string} request */
export function shortGoalTitle(request) {
  const clean = request.replace(/https?:\/\/\S+/g, '').replace(/^\s*do you see that\s*\?\s*/i, '').replace(/\s+/g, ' ').trim() || 'New goal';
  const sentence = clean.split(/(?<=[.!?])\s/)[0];
  if (sentence.length <= 96) return sentence;
  const prefix = sentence.slice(0, 93); return `${prefix.slice(0, prefix.lastIndexOf(' ') > 50 ? prefix.lastIndexOf(' ') : 93)}…`;
}
/** @param {string} code @param {string} title */
export function planningName(code, title) { return `${code} Planning ${title}`; }
