export function webChatPage(input: { serverName: string; chatPath: string }) {
  const config = JSON.stringify({ chatPath: input.chatPath }).replace(/</g, '\\u003c');
  const title = escapeHtml(`Gary for ${input.serverName}`);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
:root { color-scheme: light dark; --bg: #fafaf9; --fg: #1c1917; --muted: #57534e; --line: #d6d3d1; --me: #e7e5e4; --accent: #1d4ed8; }
@media (prefers-color-scheme: dark) { :root { --bg: #1c1917; --fg: #f5f5f4; --muted: #a8a29e; --line: #44403c; --me: #292524; --accent: #93c5fd; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, sans-serif; }
main { max-width: 44rem; margin: 0 auto; padding: 1rem; min-height: 100vh; display: flex; flex-direction: column; gap: 1rem; }
h1 { font-size: 1.25rem; margin: 0; }
form { display: flex; gap: .5rem; }
input { flex: 1; min-width: 0; font: inherit; color: inherit; background: transparent; border: 1px solid var(--line); border-radius: .5rem; padding: .6rem .75rem; }
button { font: inherit; border: 1px solid var(--accent); color: var(--accent); background: transparent; border-radius: .5rem; padding: .6rem 1rem; cursor: pointer; }
button:disabled { opacity: .5; cursor: progress; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
#log { flex: 1; display: flex; flex-direction: column; gap: .75rem; }
.msg { white-space: pre-wrap; padding: .6rem .8rem; border-radius: .6rem; border: 1px solid var(--line); }
.msg.user { background: var(--me); align-self: flex-end; max-width: 85%; }
.msg.error { border-color: #b91c1c; }
.hint, #status { color: var(--muted); font-size: .9rem; }
[hidden] { display: none !important; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
</style>
</head>
<body>
<main>
  <h1>${title}</h1>
  <section id="login" aria-labelledby="login-label" hidden>
    <p id="login-label">Sign in with the admin password or the invite code you were given.</p>
    <form id="login-form">
      <label class="sr-only" for="secret">Password or invite code</label>
      <input id="secret" name="secret" type="password" autocomplete="current-password" placeholder="Password or GARY- code" required>
      <button type="submit">Sign in</button>
    </form>
    <p id="login-error" class="hint" role="alert"></p>
  </section>
  <section id="chat" aria-label="Conversation with Gary" hidden>
    <div id="log" role="log" aria-live="polite"></div>
    <p id="status" aria-live="polite"></p>
    <form id="chat-form">
      <label class="sr-only" for="prompt">Message</label>
      <input id="prompt" name="prompt" autocomplete="off" placeholder="Ask about a movie or show" required>
      <button type="submit" id="send">Send</button>
    </form>
    <p class="hint"><button type="button" id="logout">Sign out</button></p>
  </section>
</main>
<script type="module">
const { chatPath } = ${config};
const $ = (id) => document.getElementById(id);
const messages = [];
let conversationId = sessionStorage.getItem('gary-conversation') || crypto.randomUUID();
sessionStorage.setItem('gary-conversation', conversationId);

function show(view) {
  $('login').hidden = view !== 'login';
  $('chat').hidden = view !== 'chat';
  (view === 'login' ? $('secret') : $('prompt')).focus();
}

function bubble(role, text) {
  const node = document.createElement('div');
  node.className = 'msg ' + role;
  node.textContent = text;
  $('log').append(node);
  node.scrollIntoView({ block: 'end' });
  return node;
}

async function send(text) {
  messages.push({ id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text }] });
  bubble('user', text);
  $('send').disabled = true;
  $('status').textContent = 'Gary is thinking…';
  const reply = bubble('assistant', '');
  let full = '';
  try {
    const response = await fetch(chatPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: conversationId, messages }),
    });
    if (response.status === 401) { reply.remove(); show('login'); return; }
    if (!response.ok || !response.body) throw new Error('HTTP ' + response.status);
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const events = buffer.split('\\n\\n');
      buffer = events.pop();
      for (const event of events) {
        const data = event.split('\\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('');
        if (!data || data === '[DONE]') continue;
        const chunk = JSON.parse(data);
        if (chunk.type === 'text-delta') { full += chunk.delta; reply.textContent = full; }
        if (chunk.type === 'text-end' && full && !full.endsWith('\\n')) { full += '\\n\\n'; }
        if (chunk.type === 'error') throw new Error(chunk.errorText);
      }
    }
    full = full.trim();
    reply.textContent = full || '(no reply)';
    messages.push({ id: crypto.randomUUID(), role: 'assistant', parts: [{ type: 'text', text: full }] });
  } catch (error) {
    reply.classList.add('error');
    reply.textContent = 'Something went wrong: ' + error.message;
  } finally {
    $('send').disabled = false;
    $('status').textContent = '';
  }
}

$('chat-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const text = $('prompt').value.trim();
  if (!text) return;
  $('prompt').value = '';
  void send(text);
});

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('login-error').textContent = '';
  const response = await fetch('/gary/web/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: $('secret').value }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) { $('login-error').textContent = body.error || 'Sign-in failed.'; return; }
  $('secret').value = '';
  if (body.welcome) bubble('assistant', body.welcome);
  show('chat');
});

$('logout').addEventListener('click', async () => {
  await fetch('/gary/web/session', { method: 'DELETE' });
  messages.length = 0;
  $('log').replaceChildren();
  conversationId = crypto.randomUUID();
  sessionStorage.setItem('gary-conversation', conversationId);
  show('login');
});

fetch('/gary/web/session').then((response) => show(response.ok ? 'chat' : 'login'));
</script>
</body>
</html>`;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}
