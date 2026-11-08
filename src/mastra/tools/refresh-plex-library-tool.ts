import { createTool } from '@mastra/core/tools';
import {
  plexLibraryRefreshInputSchema,
  plexLibraryRefreshOutputSchema,
  type PlexLibraryRefreshOutput,
} from '../schemas/media-service-status';
import { refreshPlexLibrary } from '../services/plex-readonly-client';
import { serverName } from '../config/branding';

export async function refreshPlexLibrarySection(input: unknown): Promise<PlexLibraryRefreshOutput> {
  const request = plexLibraryRefreshInputSchema.parse(input);

  try {
    const result = await refreshPlexLibrary(request.mediaType);
    if (!result) {
      return {
        status: 'library-not-found',
        mediaType: request.mediaType,
        summary: `I could not find ${serverName()} ${request.mediaType === 'tv' ? 'TV Shows' : 'Movies'} library, so I did not start a refresh.`,
      };
    }

    return {
      status: 'started',
      mediaType: request.mediaType,
      library: result.library,
      sectionKey: result.sectionKey,
      summary: `Started a ${result.library} library refresh on ${serverName()}. New or changed files should appear after Plex finishes scanning.`,
    };
  } catch (error) {
    return {
      status: 'service-unavailable',
      mediaType: request.mediaType,
      summary: `I could not start ${serverName()} library refresh: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export const refreshPlexLibraryTool = createTool({
  id: 'refresh-plex-library',
  description:
    `Repair action that asks Plex to scan either ${serverName()} Movies or TV Shows library for new or changed files. Use when the user explicitly asks to refresh/scan the library or files are present in media repair but missing from Plex.`,
  inputSchema: plexLibraryRefreshInputSchema,
  outputSchema: plexLibraryRefreshOutputSchema,
  execute: refreshPlexLibrarySection,
});
