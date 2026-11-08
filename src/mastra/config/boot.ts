import { GaryConfigError, garyConfig, type GaryConfig } from './gary-config';

function loadConfigOrExit(): GaryConfig {
  try {
    return garyConfig();
  } catch (error) {
    if (!(error instanceof GaryConfigError)) throw error;
    console.error(error.message);
    process.exit(1);
  }
}

export const bootConfig = loadConfigOrExit();
