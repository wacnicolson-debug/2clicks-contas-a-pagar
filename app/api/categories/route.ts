import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Não autenticado." }, { status: 401 });
  }

  const categories = await prisma.category.findMany({
    where: { companyId: session.companyId },
    orderBy: { name: "asc" },
    select: { name: true },
  });

  return NextResponse.json({ names: categories.map((c) => c.name) });
}
