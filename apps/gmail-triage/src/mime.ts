import type { GmailMessagePart } from './types';

function decodeBase64Url(input: string): string {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(input.length / 4) * 4, '=');
  const binary = atob(normalized);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function collectTextParts(part: GmailMessagePart, output: string[]): void {
  // A textual attachment is not the message body.
  if (part.filename) return;
  const mimeType = part.mimeType?.toLowerCase();
  if (mimeType === 'multipart/alternative') {
    const alternatives = part.parts ?? [];
    const preferred = alternatives.find(child => child.mimeType?.toLowerCase() === 'text/plain' && child.body?.data)
      ?? alternatives.find(child => child.mimeType?.toLowerCase() === 'text/html' && child.body?.data)
      ?? alternatives[0];
    if (preferred) collectTextParts(preferred, output);
    return;
  }
  if (part.body?.data && mimeType === 'text/plain') {
    output.push(decodeBase64Url(part.body.data));
  } else if (part.body?.data && mimeType === 'text/html') {
    output.push(stripHtml(decodeBase64Url(part.body.data)));
  }

  for (const child of part.parts ?? []) collectTextParts(child, output);
}

export function extractBodyText(payload: GmailMessagePart | undefined, limit = 6000): string {
  if (!payload) return '';
  const parts: string[] = [];
  collectTextParts(payload, parts);
  return parts.join('\n').replace(/\s+/g, ' ').trim().slice(0, limit);
}
