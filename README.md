# Gary

Gary is a chat assistant for a self-hosted media server. The people you share your server with ask Gary in plain words whether a film or show is ready to watch, what to watch next, or to request something new. Gary checks Plex, files the request through Seerr, follows Sonarr and Radarr until the download lands, and tells the person when it is ready.

Gary runs as one Docker container next to your media stack. People reach it from a web chat, Telegram, or WhatsApp. Each person enrolls once with an invite code. Gary keeps each person's history, lists, and taste separate, and the same history follows them across chat apps. Gary is built on [Mastra](https://mastra.ai).

## What you need

- Docker with the Compose plugin.
- [Seerr](https://github.com/seerr-team/seerr) and its API key. Gary sends every request through it.
- An API key for OpenAI, or any OpenAI-compatible endpoint such as Ollama.
- Optional: Plex, Sonarr, Radarr, Tautulli, Prowlarr, and SABnzbd URLs and API keys. Gary uses only the services you configure.
- Optional: a Telegram bot token, or WhatsApp Cloud API credentials.

## Quickstart

1. Get the code and create your settings file.

	```sh
	git clone https://github.com/<owner>/gary.git
	cd gary
	cp .env.example .env
	mkdir -p data
	```

2. Edit `.env`. Fill in `LLM_API_KEY`, `SEERR_URL`, and `SEERR_API_KEY`, plus any other service you run. Set `GARY_ADMIN_PASSWORD` if you want to sign in to the web chat with a password. Every variable has a one-line comment in `.env.example`.

	The container runs as user ID 1000. If your user has a different ID, run `sudo chown 1000:1000 data`.

3. Start Gary.

	```sh
	docker compose up -d
	```

4. Check that Gary can reach every service you configured.

	```sh
	docker compose exec gary node doctor.mjs
	```

	The doctor prints one line per service and one for the model, and exits with code 1 if any of them fails. It sends only read requests and a one-word prompt to the model:

	```text
	seerr                      ok    3.3.0
	sonarr                     ok    4.0.19.2979
	radarr                     ok    6.3.0.10514
	plex                       ok    1.43.1.10611-1e34174b1
	tautulli                   ok    v2.17.2
	llm (openai/gpt-5.6-luna)  ok    replied "OK"
	not configured: prowlarr, sabnzbd
	```

5. Open the web chat at `http://<your-host>:4111/` and sign in with `GARY_ADMIN_PASSWORD`. Without a password, use the one-time admin code that Gary prints on first boot:

	```sh
	docker compose logs gary | grep "Gary admin setup"
	```

6. Invite people and connect chat apps from the chat itself.
	- To invite someone, ask Gary "invite Alice". Gary replies with a `GARY-` code. Alice enters it on the web chat sign-in page, or sends it to Gary on Telegram or WhatsApp.
	- To connect another chat app to your own account, ask Gary for a link code and send that code from the other app.

	Each code works once. An invite expires after 72 hours and a link code after one hour.

To join the network your media stack already uses, so that `.env` can name containers such as `http://seerr:5055`, uncomment the `networks:` block in `compose.yaml`.

## Channels

The web chat is always on. Telegram and WhatsApp start when their credentials are set. Gary answers direct messages only. It ignores group chats.

| Channel | How people reach Gary | What you set up | Gary can message first |
| --- | --- | --- | --- |
| Web chat | A browser at port 4111. Sign-ins last 30 days. | Nothing. | No. It replies only while the page is open. |
| Telegram | A direct message to your bot. | `TELEGRAM_BOT_TOKEN` from @BotFather. Gary polls Telegram, so it needs no public URL. | Yes. |
| WhatsApp | A message to your WhatsApp Business number. | Cloud API credentials and a public HTTPS URL. See [Channels](docs/channels.md). | Yes. Outside the 24-hour reply window it uses approved templates. |

"Gary can message first" covers notices such as "Arrival is ready to watch". Gary sends a notice to the person's preferred linked chat that can receive one.

## Model providers

Gary talks to models through Mastra's model router.

- **OpenAI.** Set `LLM_API_KEY` and leave `LLM_BASE_URL` unset. `LLM_MODEL` takes a router id such as `openai/gpt-5.6-luna`, the default.
- **Any OpenAI-compatible endpoint.** Set `LLM_BASE_URL` to the endpoint's `/v1` URL and `LLM_MODEL` to the model name that endpoint expects. Set `LLM_API_KEY` if the endpoint needs one. Voice notes need `LLM_TRANSCRIBE_MODEL` on these endpoints. Without it, Gary asks people to type instead.
- **Ollama.** Use `LLM_BASE_URL=http://ollama:11434/v1`. Gary's instructions and tool definitions come to about 63,000 characters, roughly 16,000 tokens, before any conversation. Ollama's default context window is far smaller and cuts the start of the prompt without an error. Start Ollama with `OLLAMA_CONTEXT_LENGTH=32768` or larger, and pick a model that supports tool calling.

## Safety model

Gary acts on a real server for people who are not admins, so it limits what any one person can do.

- **Identity first.** A message from a chat that no invite code has linked gets only the enrollment prompt. The model never sees it.
- **Previews before changes.** Gary files a request only after the person asks for it and Plex and Seerr show the title is missing. A batch request, such as a whole franchise, is planned as a fixed preview first. Quality upgrades, collection repairs, and publishing a list to Plex each wait for the person to approve a preview. Deleting your data needs an exact confirmation phrase within `GARY_CONFIRMATION_TTL_MINUTES`.
- **Admin-only actions.** Only admins can invite people, change household rules, and run collection repairs.
- **Quotas.** Each member gets `GARY_DAILY_MUTATION_LIMIT` requests and changes per day, `GARY_DAILY_LIST_LIMIT` list edits, and `GARY_HOURLY_WEB_LIMIT` web searches per hour. Admins are exempt from the daily limits. Bursts beyond `GARY_HOURLY_INBOUND_LIMIT` messages per hour get a "slow down" reply. Ten failed web sign-ins from one address block that address for an hour.
- **Read-only mode.** With `GARY_READ_ONLY=true`, Gary answers questions but refuses every request, server change, and outgoing message, and it does not start Telegram, WhatsApp, or scheduled jobs. Use it to try Gary against your real services. `GARY_ALLOW_REQUESTS=false` stops new requests only.
- **The Mastra API is locked.** Mastra's REST API under `/api/*`, which Mastra Studio uses, can read any person's memory and run the agent outside these checks. Gary answers it only for requests that carry `Authorization: Bearer <GARY_ADMIN_TOKEN>`, and returns 404 to everything else. With `GARY_ADMIN_TOKEN` unset, the API stays closed. The channel webhooks under `/api/agents/gary/channels/` stay open because the chat platforms call them. Each one checks the sender itself.
- **Your data.** Anyone can ask Gary to export or delete their data. Deletion removes their conversations, lists, watches, and history, and disconnects every chat app and browser linked to them.

Behind a reverse proxy, set `GARY_PUBLIC_URL` to the public `https://` address and `GARY_TRUST_PROXY=true`.

## Development

```sh
npm ci
npm run dev      # Mastra dev server with Studio
npm run check    # typecheck, tests, and the scrub gate
npm run doctor   # the doctor, from source
```

See [CONTRIBUTING.md](CONTRIBUTING.md). To report a security problem, see [SECURITY.md](SECURITY.md).

## License

Apache License 2.0. See [LICENSE](LICENSE).

Gary is not affiliated with Plex, Sonarr, Radarr, or Seerr.
