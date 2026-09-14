import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getGoogleAuthUrl } from "@/lib/sheets/client";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.redirect(new URL("/login", process.env.APP_BASE_URL));
  }

  const url = getGoogleAuthUrl(session.companyId);
  return NextResponse.redirect(url);
}
