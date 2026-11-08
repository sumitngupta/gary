import { readFile } from 'node:fs/promises';

export async function readDockerEnvValue(name: string) {
  const envPath = process.env.GARY_DOCKER_ENV_PATH;
  if (!envPath) return undefined;
  const text = await readFile(envPath, 'utf8');
  const line = text
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith(`${name}=`));

  if (!line) {
    return undefined;
  }

  return line.slice(name.length + 1).trim().replace(/^"(.*)"$/, '$1');
}

export async function readXmlTag(path: string, tagName: string) {
  const text = await readFile(path, 'utf8');
  const match = text.match(new RegExp(`<${tagName}>([^<]+)</${tagName}>`));
  return match?.[1]?.trim();
}


export async function readConfiguredXmlTag(pathEnvName: string, tagName: string) {
  const path = process.env[pathEnvName];
  return path ? readXmlTag(path, tagName) : undefined;
}
