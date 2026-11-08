const DEFAULT_SERVER_NAME = 'the media server';
const DEFAULT_ADMIN_NAME = 'the admin';

export function serverName() {
  return process.env.GARY_SERVER_NAME?.trim() || DEFAULT_SERVER_NAME;
}

export function serverNameTitle() {
  const name = serverName();
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function serverNamePattern() {
  return serverName().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function adminName() {
  return process.env.GARY_ADMIN_NAME?.trim() || DEFAULT_ADMIN_NAME;
}
