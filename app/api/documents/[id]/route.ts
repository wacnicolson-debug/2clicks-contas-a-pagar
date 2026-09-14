import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import type { ExtractedPage } from "@/lib/ai/extractDocument";

export async function GET(
  _request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Não autenticado." }, { status: 401 });
  }

  const { id } = await ctx.params;

  const document = await prisma.document.findFirst({
    where: { id, companyId: session.companyId },
    include: {
      pages: { include: { supplier: true }, orderBy: { pageNumber: "asc" } },
    },
  });

  if (!document) {
    return NextResponse.json({ error: "Documento não encontrado." }, { status: 404 });
  }

  // Linhas do extrato que bateram com uma nota já lançada não geram
  // DocumentPage nenhuma — só aparecem aqui, pra ficar visível que foram
  // conferidas (as órfãs já aparecem via `pages`, criadas pra elas).
  const matchedLines =
    document.kind === "BANK_STATEMENT"
      ? await prisma.bankStatementLine.findMany({
          where: { documentId: id, status: "MATCHED" },
          orderBy: { date: "asc" },
        })
      : [];

  return NextResponse.json({
    id: document.id,
    status: document.status,
    originalFilename: document.originalFilename,
    pages: document.pages.map((p) => {
      const extraction = p.rawExtraction as unknown as ExtractedPage;
      return {
        id: p.id,
        pageNumber: p.pageNumber,
        status: p.status,
        supplierName: p.supplier?.name ?? null,
        duplicateOfPageNumber: extraction?.duplicateOfPageNumber ?? null,
      };
    }),
    matchedLines: matchedLines.map((l) => ({
      id: l.id,
      description: l.rawDescription,
      amount: Number(l.amount),
      date: l.date.toISOString().slice(0, 10),
    })),
  });
}
