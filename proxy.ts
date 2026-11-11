import { NextRequest, NextResponse } from "next/server";
import { verifyToken, renewedSessionToken, SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS } from "@/lib/auth/session";

export async function proxy(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = token ? await verifyToken(token) : null;

  const isAuthRoute = request.nextUrl.pathname.startsWith("/login");

  if (!session && !isAuthRoute) {
    const loginUrl = new URL("/login", request.url);
    return NextResponse.redirect(loginUrl);
  }

  if (session && isAuthRoute) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  const response = NextResponse.next();
  // Quem está usando continua logado: renova o login (mais 7 dias) a cada meio dia de uso.
  if (session) {
    const renewed = await renewedSessionToken(session);
    if (renewed) response.cookies.set(SESSION_COOKIE_NAME, renewed, SESSION_COOKIE_OPTIONS);
  }
  return response;
}

export const config = {
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico|manifest.json|icon.png|apple-icon.png|sw.js|icons/).*)",
  ],
};
