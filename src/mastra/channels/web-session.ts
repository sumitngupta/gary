import { randomBytes } from 'node:crypto';
import { getConnInfo } from '@hono/node-server/conninfo';
import { registerApiRoute } from '@mastra/core/server';
import type { WebUser } from '@chat-adapter/web';
import { serverName } from '../config/branding';
import { garyConfig } from '../config/gary-config';
import { enroll, identify, unlink, WEB_SESSION_DAYS, webSubject } from './people';
import { webChatPage } from './web-chat-page';

const COOKIE = 'gary_session';
const MAX_AGE_SECONDS = WEB_SESSION_DAYS * 86_400;
const FAILURE_WINDOW_MS = 3_600_000;
const FAILURES_PER_ADDRESS = 10;
const FAILURES_ACROSS_ADDRESSES = 1_000;
const failedSignIns: Array<{ address: string; at: number }> = [];

function sessionToken(request: Request) {
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === COOKIE) return value.join('=') || undefined;
  }
  return undefined;
}

function cookie(token: string, maxAge: number) {
  const secure = garyConfig().publicUrl?.startsWith('https://') ? '; Secure' : '';
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

/** Web adapter `getUser`: the session cookie is the browser's channel identity. */
export async function webUserFromRequest(request: Request): Promise<WebUser | null> {
  const token = sessionToken(request);
  if (!token) return null;
  const externalId = webSubject(token);
  const person = await identify({ channel: 'web', externalId });
  return person ? { id: externalId, name: person.displayName } : null;
}

export function resetWebSignInFailuresForTests() {
  failedSignIns.length = 0;
}

/**
 * Behind a trusted reverse proxy the socket peer is the proxy, so the client
 * is the last x-forwarded-for hop: the one the proxy itself appended. Earlier
 * hops are whatever the client chose to send.
 */
function clientAddress(c: Parameters<typeof getConnInfo>[0]) {
  const forwarded = garyConfig().web.trustProxy ? c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim() : undefined;
  return forwarded || getConnInfo(c).remote.address || 'unknown';
}

function signInBlocked(address: string, now = Date.now()) {
  while (failedSignIns.length && failedSignIns[0].at < now - FAILURE_WINDOW_MS) failedSignIns.shift();
  return failedSignIns.length >= FAILURES_ACROSS_ADDRESSES
    || failedSignIns.filter((failure) => failure.address === address).length >= FAILURES_PER_ADDRESS;
}

export const webChatPageRoute = registerApiRoute('/', {
  method: 'GET',
  requiresAuth: false,
  handler: (c) => c.html(webChatPage({ serverName: serverName(), chatPath: '/api/agents/gary/channels/web/webhook' })),
});

export const webSessionStatusRoute = registerApiRoute('/gary/web/session', {
  method: 'GET',
  requiresAuth: false,
  handler: async (c) => {
    const user = await webUserFromRequest(c.req.raw);
    return user ? c.json({ name: user.name }) : c.json({ error: 'Not signed in' }, 401);
  },
});

export const webSignInRoute = registerApiRoute('/gary/web/session', {
  method: 'POST',
  requiresAuth: false,
  handler: async (c) => {
    const address = clientAddress(c as never);
    if (signInBlocked(address)) return c.json({ error: 'Too many failed sign-ins. Try again in an hour.' }, 429);
    const body = await c.req.json().catch(() => ({})) as { secret?: unknown };
    const secret = typeof body.secret === 'string' ? body.secret.trim() : '';
    const token = randomBytes(32).toString('base64url');
    const key = { channel: 'web' as const, externalId: webSubject(token) };
    const outcome = /^GARY-/i.test(secret)
      ? await enroll(key, { kind: 'code', text: secret })
      : await enroll(key, { kind: 'owner-password', password: secret });
    if (outcome.status === 'refused') {
      failedSignIns.push({ address, at: Date.now() });
      return c.json({ error: 'That password or invite code did not work.' }, 401);
    }
    c.header('Set-Cookie', cookie(token, MAX_AGE_SECONDS));
    return c.json({ name: outcome.person.displayName, welcome: `You are signed in as ${outcome.person.displayName}. Ask me about anything to watch on ${serverName()}.` });
  },
});

export const webSignOutRoute = registerApiRoute('/gary/web/session', {
  method: 'DELETE',
  requiresAuth: false,
  handler: async (c) => {
    const token = sessionToken(c.req.raw);
    if (token) await unlink({ channel: 'web', externalId: webSubject(token) });
    c.header('Set-Cookie', cookie('', 0));
    return c.json({ ok: true });
  },
});

export const webRoutes = [webChatPageRoute, webSessionStatusRoute, webSignInRoute, webSignOutRoute];
