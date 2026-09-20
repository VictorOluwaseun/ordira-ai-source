import {
  customerAiEvalCommandHelp,
  executeCustomerAiEvalCommand,
  parseCustomerAiEvalCommandArgs,
} from '@modules/customer-ai/evals/customer-ai-eval-command';

async function main(): Promise<void> {
  const options = parseCustomerAiEvalCommandArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${customerAiEvalCommandHelp()}\n`);
    return;
  }

  const result = await executeCustomerAiEvalCommand(options);
  process.stdout.write(`${JSON.stringify(result.summary, null, 2)}\n`);
  process.exitCode = result.exitCode;
}

void main().catch((error: unknown) => {
  // The CLI prints only the stable error message. Provider response bodies and
  // fixture turns must never be included in command logs.
  const message =
    error instanceof Error ? error.message : 'Unknown evaluation failure';
  process.stderr.write(`Customer AI evaluation failed: ${message}\n`);
  process.exitCode = 1;
});
