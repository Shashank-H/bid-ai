import { pathToFileURL } from 'node:url';
import { parseOptions } from '../../apps/api/src/commands/database.js';
import { DEFAULT_SEED, PUBLISHER_IDS, loadingDescriptor } from './configuration.js';
import { loadHistoricalData, verifyCandidate } from './load.js';

const help = `Phase 3 command-only data operations:
  data:generate [--seed <value>]   One-time configuration-first load; refuses occupied data
  data:verify [--seed <value>]     Offline candidate/scenario/sensitivity checks; no database writes

Only --seed is accepted. Database settings come from the existing local-only environment.
Run db:init and users:bootstrap explicitly first. No data is loaded at normal API startup.
Private operator output: PHASE3_OUTPUT_DIR (default /tmp/bid-phase3-output).
`;

export async function runDataCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  output: (message: string) => void = console.log,
  signal?: AbortSignal,
): Promise<number> {
  const [command, ...arguments_] = args;
  if (!command || (command === '--help' && !arguments_.length)) {
    output(help);
    return 0;
  }
  if (!['data:generate', 'data:verify'].includes(command)) {
    output('INVALID_ARGUMENTS: unknown data command; use --help');
    return 2;
  }
  if (arguments_.length === 1 && arguments_[0] === '--help') {
    output(help);
    return 0;
  }

  let seed: string;
  try {
    const options = parseOptions(arguments_, ['--seed']);
    seed = options['--seed'] ?? DEFAULT_SEED;
    for (const publisherId of PUBLISHER_IDS) loadingDescriptor(publisherId, seed);
  } catch {
    output('INVALID_ARGUMENTS: only one optional --seed with 1–128 characters is accepted');
    return 2;
  }

  try {
    signal?.throwIfAborted();
    if (command === 'data:verify') {
      const verified = await verifyCandidate(seed, signal);
      output(
        JSON.stringify({
          event: 'candidate-verified',
          datasets: verified.datasets.map((dataset) => dataset.descriptor),
          sensitivity: verified.sensitivity,
          scenarios: verified.scenarios,
        }),
      );
    } else {
      await loadHistoricalData(env, { seed, output, ...(signal ? { signal } : {}) });
    }
    return 0;
  } catch (error) {
    if (signal?.aborted) {
      output('CANCELLED: no automatic cleanup; inspect dataset status before further operations');
      return 1;
    }
    // Never print SDK/provider payloads or user credential records.
    output(
      error instanceof Error &&
        /^(INVALID_CONFIGURATION|INVALID_ARGUMENTS|INVALID_DATA|DATA_INVALID|DATA_CONFLICT|DATA_WRITE_FAILED|DATASET_NOT_READY|IDENTITY_REQUIRED|OUTPUT_CONFLICT):/.test(
          error.message,
        )
        ? error.message
        : 'DATA_COMMAND_FAILED: check local readiness, candidate invariants and operator output permissions',
    );
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  const cancel = (name: string) => controller.abort(new Error(name));
  process.once('SIGINT', () => cancel('SIGINT'));
  process.once('SIGTERM', () => cancel('SIGTERM'));
  process.exitCode = await runDataCli(
    process.argv.slice(2),
    process.env,
    console.log,
    controller.signal,
  );
}
