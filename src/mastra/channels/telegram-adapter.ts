import { TelegramAdapter, type TelegramAdapterConfig } from '@chat-adapter/telegram';
import { assertMutationAllowed } from '../config/gary-config';

const READ_METHODS = new Set(['getMe', 'getChat', 'getChatMemberCount', 'getFile', 'getUpdates', 'getWebhookInfo']);

export class GaryTelegramAdapter extends TelegramAdapter {
  constructor(config: TelegramAdapterConfig & { botToken: string }) {
    super(config);
  }

  protected override telegramFetch<TResult>(method: string, payload?: Record<string, unknown> | FormData, request?: { signal?: AbortSignal }) {
    if (!READ_METHODS.has(method)) assertMutationAllowed('message');
    return super.telegramFetch<TResult>(method, payload, request);
  }
}
