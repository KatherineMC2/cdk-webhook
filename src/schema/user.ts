import { z } from 'zod';

export const userSchema = z.object({
  name: z.string(), // Name must be a string
  age: z.number().int().min(18), // User's age must be an integer greater than 18
  email: z.string().email(), // Must be a valid email
});

export type UserEventType = z.infer<typeof userSchema>;
