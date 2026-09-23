export interface GmailPubSubNotification {
  emailAddress: string;
  historyId: string;
  messageId?: string;
}

interface PubSubEnvelope {
  message?: {
    data?: string;
  };
}

function decodeBase64Url(input: string): string {
  const normalized = input
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(Math.ceil(input.length / 4) * 4, '=');
  const binary = atob(normalized);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export async function parseGmailPubSubPush(request: Request): Promise<GmailPubSubNotification> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Pub/Sub body is missing');
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 16384) { await reader.cancel(); throw new Error('Pub/Sub body is too large'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const envelope = JSON.parse(new TextDecoder().decode(bytes)) as PubSubEnvelope;
  const data = envelope.message?.data;
  if (typeof data !== 'string' || !data) throw new Error('Pub/Sub message.data is missing');

  const payload = JSON.parse(decodeBase64Url(data)) as { emailAddress?: unknown; historyId?: unknown } | null;
  // Some Gmail notifications serialize historyId as a JSON number. Never
  // normalize unsafe integers: rounding an opaque cursor would skip history.
  const historyId = typeof payload?.historyId === 'number' && Number.isSafeInteger(payload.historyId)
    ? String(payload.historyId) : payload?.historyId;
  if (typeof payload?.emailAddress !== 'string' || !payload.emailAddress.includes('@') || typeof historyId !== 'string' || !/^[0-9]{1,30}$/.test(historyId)) {
    console.warn(JSON.stringify({ event: 'invalid_gmail_notification_fields', emailType: typeof payload?.emailAddress, historyType: typeof payload?.historyId }));
    throw new Error('Gmail Pub/Sub notification is missing emailAddress or historyId');
  }

  return {
    emailAddress: payload.emailAddress,
    historyId,
  };
}
