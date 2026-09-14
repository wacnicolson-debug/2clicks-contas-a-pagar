import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { verifyPassword, createSession } from "@/lib/auth/session";

export async function POST(request: NextRequest) {
  const { username, password } = await request.json();

  if (!username || !password) {
    return NextResponse.json(
      { error: "Informe usuário e senha." },
      { status: 400 }
    );
  }

  // Login simples: usuário pode existir em mais de uma empresa com o mesmo
  // nome de usuário (unicidade é por empresa) — por ora tentamos todas as
  // combinações até achar uma senha válida. Usuário não é sensível a
  // maiúscula/minúscula (só a senha é) — evita erro de digitação/confusão
  // com o CSS que deixa o campo visualmente em caixa alta.
  const candidates = await prisma.user.findMany({
    where: { username: { equals: username, mode: "insensitive" } },
  });

  for (const candidate of candidates) {
    const valid = await verifyPassword(password, candidate.passwordHash);
    if (valid) {
      await createSession({
        userId: candidate.id,
        companyId: candidate.companyId,
        username: candidate.username,
      });
      return NextResponse.json({ ok: true });
    }
  }

  return NextResponse.json(
    { error: "Usuário ou senha inválidos." },
    { status: 401 }
  );
}
