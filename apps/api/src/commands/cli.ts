import { pathToFileURL } from 'node:url';
import { ConfigurationError, readModelSettings, readTracingSettings } from '../env.js';
import { executeDatabaseCommand, parseOptions } from './database.js';
import { deferredCommands, executeDeferredCommand, NotImplementedError } from './deferred.js';

const help = `Foundation commands:
  db:init                         Non-destructive empty-table initialization
  db:verify                       Read table counts
  db:verify --record write         Write unique persistence-check record
  db:verify --record read|delete --token <uuid>
  db:reset --endpoint <local-url> --prefix <configured-prefix> --confirm "DELETE <prefix>"
  model:probe                     Probe configured streaming and function-call support
  users:bootstrap                 Explicit repeat-safe development-user initialization
  postgres:init                   Apply application and LangGraph saver migrations
  data:seed | data:reconcile       Phase 2 placeholders; return NOT_IMPLEMENTED
  data:generate                   Phase 3 placeholder; returns NOT_IMPLEMENTED

No data is loaded during ordinary startup. Model settings stay server-side.
`;

const commands = [
  'db:init',
  'db:verify',
  'db:reset',
  'model:probe',
  'users:bootstrap',
  'postgres:init',
  ...Object.keys(deferredCommands),
];

export async function runCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  output: (message: string) => void = console.log,
): Promise<number> {
  const [command, ...options] = args;

  if (!command || (command === '--help' && options.length === 0)) {
    output(help);

    return 0;
  }

  if (!commands.includes(command)) {
    output('INVALID_ARGUMENTS: unknown command; use --help');

    return 2;
  }

  if (options.length === 1 && options[0] === '--help') {
    output(help);

    return 0;
  }

  try {
    if (command in deferredCommands) {
      parseOptions(options, []);
      executeDeferredCommand(command as keyof typeof deferredCommands);
    }

    if (command === 'model:probe') {
      parseOptions(options, []);

      const model = readModelSettings(env);
      const settings = readTracingSettings(env);
      const { initializeTracing } = await import('../observability/tracing.js');
      const tracing = initializeTracing(settings, { secrets: [model.apiKey] });

      try {
        // Initialize telemetry before importing/constructing the LLM client.
        const { runModelProbe } = await import('./model-probe.js');
        const result = await runModelProbe({ ...model, tracing });
        output(
          JSON.stringify({ ...result, ...(tracing.traceId ? { traceId: tracing.traceId } : {}) }),
        );
      } catch (error) {
        if (tracing.traceId) output(JSON.stringify({ traceId: tracing.traceId, status: 'failed' }));

        throw error;
      } finally {
        // Short-lived commands must flush queued observations before they exit.
        await tracing.shutdown();
      }
    } else if (command === 'postgres:init') {
      parseOptions(options, []);

      const { initializePostgres } = await import('./postgres-init.js');
      output(JSON.stringify(await initializePostgres(env)));
    } else if (command === 'users:bootstrap') {
      parseOptions(options, []);

      const { bootstrapUsers } = await import('./users-bootstrap.js');
      output(JSON.stringify(await bootstrapUsers(env)));
    } else {
      output(JSON.stringify(await executeDatabaseCommand(command, options, env)));
    }

    return 0;
  } catch (error) {
    if (error instanceof ConfigurationError || error instanceof NotImplementedError) {
      output(error.message);

      return 1;
    }

    if (command === 'model:probe') {
      const { ModelProbeError } = await import('./model-probe.js');

      if (error instanceof ModelProbeError) {
        output(error.code);

        return 1;
      }
    }

    // SDK/provider payloads are intentionally never printed by operational commands.
    const message =
      error instanceof Error &&
      /^(RESET_REFUSED|INVALID_ARGUMENTS|INCOMPATIBLE_SCHEMA|INCOMPATIBLE_TTL|TTL_TRANSITION_PENDING|INVALID_VERIFICATION_TOKEN|BOOTSTRAP_CONFLICT|DATABASE_NOT_READY):?/.test(
        error.message,
      )
        ? error.message
        : 'COMMAND_FAILED: check local configuration and dependency readiness';
    output(message);

    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const status = await runCli(process.argv.slice(2));

  // Exporter sockets can outlive a bounded shutdown (for example a trickling peer).
  // Only the executable entrypoint exits explicitly; importing runCli remains safe.
  await Promise.all(
    [process.stdout, process.stderr].map(
      (stream) =>
        new Promise<void>((resolve) => {
          stream.write('', () => resolve());
        }),
    ),
  );
  process.exit(status);
}
