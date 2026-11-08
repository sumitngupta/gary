import { garyConfig } from './gary-config';

export function serverName() {
  return garyConfig().serverName;
}

export function serverNameTitle() {
  const name = serverName();
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function serverNamePattern() {
  return serverName().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function adminName() {
  return garyConfig().adminName;
}
