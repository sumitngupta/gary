import { Agent } from '@mastra/core/agent';
import { noopLogger } from '@mastra/core/logger';
import { GaryConfigError, MEDIA_SERVICES, parseGaryConfig, type GaryConfig, type MediaServiceName } from '../src/mastra/config/gary-config';
import { describeModelError, garyLanguageModel, garyProviderOptions } from '../src/mastra/config/model';
import { probeService } from '../src/mastra/services/media-service-probes';

type Line = { name: string; ok: boolean; detail: string };

async function checkModel(config: GaryConfig): Promise<Line> {
  const name = `llm (${config.model.model}${config.model.baseUrl ? ' via LLM_BASE_URL' : ''})`;
  try {
    const agent = new Agent({ id: 'gary-doctor', name: 'Gary doctor', instructions: 'Reply with exactly OK.', model: garyLanguageModel(config.model) });
    agent.__setLogger(noopLogger);
    // OpenAI-compatible servers disagree on max_tokens (OpenAI's reasoning
    // models reject it), so the token cap applies only to the router path.
    const result = await agent.generate('Reply with OK', {
      modelSettings: config.model.baseUrl ? {} : { maxOutputTokens: 64 },
      providerOptions: garyProviderOptions(config.model),
    });
    const reply = result.text.trim().slice(0, 40);
    return reply ? { name, ok: true, detail: `replied "${reply}"` } : { name, ok: false, detail: 'empty reply' };
  } catch (error) {
    return { name, ok: false, detail: describeModelError(error) };
  }
}

async function main() {
  let config: GaryConfig;
  try {
    config = parseGaryConfig(process.env);
  } catch (error) {
    if (!(error instanceof GaryConfigError)) throw error;
    console.log(error.message);
    return 1;
  }

  const services = (Object.keys(MEDIA_SERVICES) as MediaServiceName[]).filter((name) => config.services[name]);
  const lines: Line[] = await Promise.all([
    ...services.map(async (name) => {
      const result = await probeService(name, config.services[name]!);
      return { name, ok: result.ok, detail: result.ok ? result.version : result.error };
    }),
    checkModel(config),
  ]);

  const width = Math.max(...lines.map((line) => line.name.length));
  for (const line of lines) console.log(`${line.name.padEnd(width)}  ${line.ok ? 'ok  ' : 'fail'}  ${line.detail}`);
  const skipped = (Object.keys(MEDIA_SERVICES) as MediaServiceName[]).filter((name) => !config.services[name]);
  if (skipped.length) console.log(`not configured: ${skipped.join(', ')}`);
  if (config.readOnly) console.log('mode: read-only (GARY_READ_ONLY=true)');
  return lines.every((line) => line.ok) ? 0 : 1;
}

process.exitCode = await main();
