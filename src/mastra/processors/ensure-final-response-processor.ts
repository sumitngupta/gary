import type { Processor, ProcessInputStepArgs } from '@mastra/core/processors';

export class EnsureFinalResponseProcessor implements Processor {
  readonly id = 'gary-ensure-final-response';
  readonly name = 'Gary Ensure Final Response';

  constructor(private readonly maxSteps: number) {}

  async processInputStep({ stepNumber, sendSignal }: ProcessInputStepArgs) {
    if (stepNumber !== this.maxSteps - 1) return;
    await sendSignal?.({
      type: 'reactive',
      contents: `This is the final step (${stepNumber + 1} of ${this.maxSteps}). Do not call another tool. Give the user a concise final answer grounded in the tool results already returned.`,
      attributes: { reason: 'max-steps-reached', step: stepNumber + 1 },
    });
  }
}
