import argon2 from 'argon2';
import { z } from 'zod';

export const LoginInputSchema = z.strictObject({
  login: z
    .string()
    .trim()
    .toLowerCase()
    .min(1)
    .max(254)
    .regex(/^[a-z0-9@._+-]+$/),
  password: z.string().min(12).max(256),
});

export async function hashPassword(password: string): Promise<string> {
  LoginInputSchema.shape.password.parse(password);

  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  if (!LoginInputSchema.shape.password.safeParse(password).success) return false;

  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}
