import "server-only";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  signSession,
  verifySession,
} from "@/lib/session";

export async function createSession(userId: string) {
  const token = await signSession({ userId });
  cookies().set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
}

export function destroySession() {
  cookies().delete(SESSION_COOKIE);
}

/** Returns the signed-in user, or null. */
export async function getCurrentUser() {
  const session = await verifySession(cookies().get(SESSION_COOKIE)?.value);
  if (!session) return null;
  return prisma.user.findUnique({ where: { id: session.userId } });
}

export function hasActiveSubscription(user: { subscriptionStatus: string | null }) {
  return user.subscriptionStatus === "active" || user.subscriptionStatus === "trialing";
}
