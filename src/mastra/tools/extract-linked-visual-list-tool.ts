import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

const inputSchema = z.object({ url: z.string().url(), query: z.string().min(1).max(500), maxItems: z.number().int().min(1).max(100).default(50) });
const outputSchema = z.object({
  status: z.enum(['resolved', 'partial', 'needs-user-upload', 'service-unavailable']), sourceUrl: z.string().url(),
  contentType: z.enum(['page-text', 'image', 'gallery', 'unknown']), mediaUrls: z.array(z.string().url()),
  items: z.array(z.object({ rawText: z.string(), normalizedText: z.string(), confidence: z.number(), evidence: z.array(z.enum(['visual-ocr', 'page-text', 'web-search'])) })),
  unresolvedItems: z.array(z.string()), warnings: z.array(z.string()), summary: z.string(), mutation: z.literal(false),
});

export const extractLinkedVisualListTool = createTool({
  id: 'extract-linked-visual-list',
  description: 'Read-only workflow for extracting a requested list from an image, gallery, infographic, or other visual content behind a shared public URL. Use after or instead of ordinary page fetch when the useful list is not present in page text.',
  inputSchema, outputSchema,
  mcp: { annotations: { title: 'Extract Linked Visual List', readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true } },
  execute: async (input, context) => {
    const workflow = context.mastra?.getWorkflow('garyLinkedVisualExtraction');
    if (!workflow) return { status: 'service-unavailable' as const, sourceUrl: input.url, contentType: 'unknown' as const, mediaUrls: [], items: [], unresolvedItems: [], warnings: ['The registered extraction workflow is unavailable.'], summary: 'Visual-list extraction is temporarily unavailable.', mutation: false as const };
    const run = await workflow.createRun();
    const result = await run.start({ inputData: input });
    if (result.status !== 'success') return { status: 'service-unavailable' as const, sourceUrl: input.url, contentType: 'unknown' as const, mediaUrls: [], items: [], unresolvedItems: [], warnings: [`Workflow ended with ${result.status}.`], summary: 'Visual-list extraction did not complete.', mutation: false as const };
    return outputSchema.parse(result.result);
  },
});

