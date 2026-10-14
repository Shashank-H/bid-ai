import { z } from 'zod';
import { createDatabaseClient } from '../db/client.js';
import { IdentityRepository } from '../db/identity.js';
import { databaseSettingsFromEnvironment } from '../env.js';
import { hashPassword, LoginInputSchema, verifyPassword } from '../auth/credentials.js';

export async function bootstrapUsers(
  env: NodeJS.ProcessEnv,
): Promise<{ created: number; unchanged: number }> {
  const passwords = z
    .object({
      DEMO_PASSWORD_A: LoginInputSchema.shape.password,
      DEMO_PASSWORD_B: LoginInputSchema.shape.password,
    })
    .parse(env);
  const settings = databaseSettingsFromEnvironment(env);
  const client = createDatabaseClient(settings);
  const repository = new IdentityRepository(client, settings.tablePrefix);
  let created = 0;
  let unchanged = 0;

  try {
    for (const [letter, password] of [
      ['a', passwords.DEMO_PASSWORD_A],
      ['b', passwords.DEMO_PASSWORD_B],
    ] as const) {
      const login = `demo.${letter}`;
      const userId = `demo-user-${letter}`;
      const publisherId = `publisher-${letter}`;
      const existing = await repository.findByLogin(login);

      if (existing) {
        const memberships = await repository.memberships(existing.userId);

        if (
          existing.userId !== userId ||
          existing.disabled ||
          memberships.length !== 1 ||
          memberships[0]?.publisherId !== publisherId ||
          !(await verifyPassword(existing.credentialHash, password))
        ) {
          throw new Error('BOOTSTRAP_CONFLICT: existing user was not replaced');
        }

        await repository.ensureDemoPublisher(letter);
        unchanged++;
        continue;
      }

      await repository.ensureDemoPublisher(letter);
      await repository.createUser(
        {
          userId,
          login,
          credentialHash: await hashPassword(password),
          createdAt: new Date().toISOString(),
          disabled: false,
        },
        { userId, publisherId, role: 'viewer' },
      );
      created++;
    }

    return { created, unchanged };
  } finally {
    client.destroy();
  }
}
