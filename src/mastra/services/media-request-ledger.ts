import { mkdir, appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { MediaRequestCreateInput, MediaRequestCreateOutput } from '../schemas/media-request';

function ledgerPath() {
  return join(process.env.GARY_DATA_DIR || './data', 'media-requests.jsonl');
}

export async function appendMediaRequestLedger(input: MediaRequestCreateInput, output: MediaRequestCreateOutput) {
  const path = ledgerPath();
  await mkdir(dirname(path), { recursive: true });
  await appendFile(
    path,
    `${JSON.stringify({
      recordedAt: new Date().toISOString(),
      requester: input.requester,
      title: output.title,
      mediaType: input.mediaType,
      year: output.year,
      tmdbId: output.tmdbId,
      requestId: output.requestId,
      requestStatus: output.requestStatus,
      notifyWhenAvailable: input.notifyWhenAvailable,
      notificationChannel: input.notificationChannel,
      notes: input.notes,
      status: output.status,
    })}\n`,
    'utf8',
  );

  return path;
}
