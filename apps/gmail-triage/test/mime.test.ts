import { describe, expect, it } from 'vitest';
import { extractBodyText } from '../src/mime';
const body = (data: string) => ({ data: btoa(data) });
describe('email body extraction', () => {
  it('uses plain text instead of duplicating multipart alternative', () => {
    expect(extractBodyText({ mimeType: 'multipart/alternative', parts: [
      { mimeType: 'text/plain', body: body('Reply today') },
      { mimeType: 'text/html', body: body('<p>Reply today</p>') },
    ] })).toBe('Reply today');
  });
  it('falls back to HTML and ignores textual attachments', () => {
    expect(extractBodyText({ mimeType: 'multipart/mixed', parts: [
      { mimeType: 'text/html', body: body('<p>Reply &amp; confirm</p>') },
      { mimeType: 'text/plain', filename: 'private.txt', body: body('Attachment is not the email') },
    ] })).toBe('Reply & confirm');
  });
  it('limits extracted text', () => { expect(extractBodyText({ mimeType: 'text/plain', body: body('abcdef') }, 3)).toBe('abc'); });
});
