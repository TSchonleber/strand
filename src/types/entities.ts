import { z } from "zod";

export const XUserSchema = z.object({
  id: z.string(),
  handle: z.string(),
  name: z.string().optional(),
  verified: z.boolean().optional(),
  followers: z.number().int().nonnegative().optional(),
  following: z.number().int().nonnegative().optional(),
  description: z.string().optional(),
});

export type XUser = z.infer<typeof XUserSchema>;

export const EntityRefSchema = z.object({
  brainctlId: z.string(),
  xUserId: z.string().optional(),
  kind: z.enum(["person", "org", "topic", "other"]),
});

export type EntityRef = z.infer<typeof EntityRefSchema>;
