import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";

export async function DELETE(
  _request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Não autenticado." }, { status: 401 });
  }

  const { id } = await ctx.params;

  const sheet = await prisma.companySheet.findFirst({
    where: { id, companyId: session.companyId },
  });

  if (!sheet) {
    return NextResponse.json({ error: "Planilha não encontrada." }, { status: 404 });
  }

  // Só remove o vínculo no banco — quem excluiu a planilha em si foi o
  // usuário direto no Google Drive. Se algum lançamento futuro cair de novo
  // nesse ano, uma planilha nova é criada automaticamente (ver
  // getOrCreateCompanySheetForYear).
  await prisma.companySheet.delete({ where: { id: sheet.id } });

  return NextResponse.json({ ok: true });
}
