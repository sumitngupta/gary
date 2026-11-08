# Channels

Gary reaches people through [Chat SDK](https://www.npmjs.com/package/chat) adapters that Mastra Channels runs. Gary owns a thin layer on top. That layer decides who a sender is, whether the agent may run, and which chat a notice goes to. This page explains that layer, how to add a channel to it, and how to connect WhatsApp.

## How a message reaches the agent

Every platform calls one handler, `garyInboundHandler` in `src/mastra/channels/gary-channels.ts`. For each direct message it does the following:

1. It drops any thread that is not a direct message. Mastra fixes a thread's memory owner when it creates the thread, so in a group every later speaker would act as the first one.
2. It turns the platform sender id into an identity key `(channel, externalId)` and looks the key up in the people store, `src/mastra/channels/people.ts`.
3. If no person has that identity, the message can only redeem a `GARY-` code. Anything else gets the enrollment prompt. The agent never sees the message.
4. For a known person, it queues the turn behind that person's other turns on every channel. When the turn starts, it records the event for replay protection and the hourly limit, then runs the agent.

Memory belongs to the person, not to the chat. `resolveResourceId` maps every identity to `gary-user:<id>`, so a person who links Telegram and the web chat sees one history in both.

Proactive notices go through `deliverToUser`. It tries the preferred channel first, then every other linked channel that can start a conversation. It refuses to send anything in read-only mode.

## Add a channel

A channel is one row in the `CHANNELS` table in `gary-channels.ts` plus its name in `CHANNEL_NAMES` in `people.ts`. The type checker then points at every place that needs the new name.

1. Install the Chat SDK adapter for the platform, for example `@chat-adapter/discord`, with an exact version.
2. Add the credentials to the zod schema in `src/mastra/config/gary-config.ts`, expose them on `GaryConfig`, and document each variable in `.env.example`. The config test fails if a variable is missing from `.env.example`.
3. If the adapter can send without going through `deliverToUser`, subclass it and call `assertMutationAllowed('message')` before every write call, as `GaryTelegramAdapter` does in `telegram-adapter.ts`.
4. Add the name to `CHANNEL_NAMES` and a row to `CHANNELS`:
	- `create(config)` returns the adapter, or `undefined` when the channel is not configured. Return `undefined` in read-only mode if starting the adapter consumes real events, as Telegram long polling does.
	- `mastra` holds the Mastra channel options, such as `streaming`.
	- `externalId(authorUserId)` normalizes the platform sender id into the stable identity key, or returns `undefined` to reject the sender.
	- `proactive(adapter, externalId, notice)` sends a notice and returns the message id. Leave it out if the platform cannot message a person first.
5. Mastra serves a webhook for the channel at `/api/agents/gary/channels/<name>/webhook`. The admin-token guard in `src/mastra/index.ts` leaves that path open, so the adapter must verify the platform's signature itself.
6. Add tests to `gary-channels.test.ts`: an unknown sender gets only the enrollment prompt, and a group thread never reaches the agent.

## Set up WhatsApp

Gary uses the WhatsApp Business Cloud API. You need a Meta developer account, a Meta app with the WhatsApp product, and a phone number registered to it. Meta must be able to reach Gary over public HTTPS.

1. In the Meta app, open **WhatsApp > API Setup** and copy the phone number id into `GARY_WHATSAPP_PHONE_NUMBER_ID`.
2. Create a permanent access token for a system user with the `whatsapp_business_messaging` permission. Put it in `GARY_WHATSAPP_ACCESS_TOKEN`.
3. Copy the app secret from **App settings > Basic** into `GARY_WHATSAPP_APP_SECRET`. The adapter uses it to check the signature on every webhook call.
4. Choose any random string for `GARY_WHATSAPP_VERIFY_TOKEN`.
5. Restart Gary with `docker compose up -d`. Gary ignores WhatsApp while `GARY_READ_ONLY=true`.
6. In **WhatsApp > Configuration**, set the callback URL to `https://<your-public-host>/gary/webhooks/whatsapp` and the verify token to the same string. Subscribe to the `messages` webhook field.
7. Create two message templates in WhatsApp Manager. Gary uses them to tell people a title is ready when the 24-hour reply window has closed.
	- `gary_media_available`, in English (`en_US`), with one body variable for the title.
	- `gary_tracked_titles_available`, in English (`en_US`), with one body variable for the list of titles.

	To use other names, set `GARY_WHATSAPP_MEDIA_AVAILABLE_TEMPLATE` and `GARY_WHATSAPP_MEDIA_BATCH_TEMPLATE`.
8. Ask Gary for a link code in the web chat and send that code to your WhatsApp number. Gary replies with a welcome.

All four `GARY_WHATSAPP_*` credentials must be set together. Gary refuses to start with only some of them.

Gary drops WhatsApp group messages before they reach the handler.
