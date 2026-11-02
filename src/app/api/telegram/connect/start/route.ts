import { userRoute } from '@/server/http';
import { createLinkToken } from '@/server/telegram/pairing';

/** One-time pairing link (TTL 10 min). Only the sha256 of the token is stored. */
export const POST = userRoute(async ({ user }) => createLinkToken(user.id));
