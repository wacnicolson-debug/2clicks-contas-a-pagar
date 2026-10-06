import { NextRequest, NextResponse } from "next/server";
import { getSession, hashPassword } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";

// Cria uma empresa nova (ex: outra empresa do grupo) com seu próprio login —
// protegido por sessão: só quem já está logado numa empresa existente pode
// criar outra (não é cadastro público). Login separado por empresa, do
// mesmo jeito que o login já suporta (mesmo usuário pode existir em mais de
// uma empresa).
export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Não autenticado." }, { status: 401 });
  }

  const { companyName, username, password } = await request.json();
  if (!companyName?.trim() || !username?.trim() || !password) {
    return NextResponse.json(
      { error: "Preencha o nome da empresa, usuário e senha." },
      { status: 400 }
    );
  }

  const company = await prisma.company.create({
    data: { name: companyName.trim() },
  });

  const passwordHash = await hashPassword(password);
  await prisma.user.create({
    data: {
      companyId: company.id,
      username: username.trim(),
      passwordHash,
    },
  });

  // Categorias não vêm pré-cadastradas — as da GLM são de confecção
  // (matéria-prima, tecidos...), não fazem sentido pra fazenda/imobiliária.
  // Cada categoria é criada sozinha na primeira vez que aparecer, igual já
  // acontece hoje na tela de perguntas.

  return NextResponse.json({ ok: true, companyId: company.id });
}
