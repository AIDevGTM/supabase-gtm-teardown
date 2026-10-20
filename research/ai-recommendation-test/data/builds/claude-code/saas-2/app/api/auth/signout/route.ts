import { NextResponse } from "next/server";
import { destroySession } from "@/lib/auth";

export const dynamic = "force-dynamic";

// POST from the dashboard's "Sign out" button.
// GET is used to clear stale cookies (e.g. a valid token for a deleted user).
function signOut(req: Request) {
  destroySession();
  return NextResponse.redirect(new URL("/login", req.url), 303);
}

export const GET = signOut;
export const POST = signOut;
