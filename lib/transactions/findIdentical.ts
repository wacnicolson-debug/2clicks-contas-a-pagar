import { prisma } from "@/lib/db/prisma";
import { normalizeText } from "@/lib/utils/normalizeText";
import type { Prisma } from "@prisma/client";

// Chave de fornecedor tolerante a grafia: "VICUNHA TÊXTIL S/A" e "VICUNHA
// TEXTIL SA" são o mesmo fornecedor pra efeito de duplicata.
export function supplierKey(name: string): string {
  return normalizeText(name)
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\b(ltda|s a|sa|me|eireli|epp)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * REGRA DA CASA: no mesmo dia, mesmo fornecedor e mesmo valor só pode existir
 * UM lançamento — não importa por onde ele entrou (nota, perguntas, relação
 * de pagamentos, extrato, manual, repetir, edição). Devolve o lançamento que
 * já existe, se houver.
 */
export async function findIdenticalTransaction(params: {
  companyId: string;
  kind: "PAYABLE" | "RECEIVABLE";
  dueDate: Date;
  amount: number | Prisma.Decimal;
  supplierId: string;
  supplierName: string;
  excludeId: string;
  // true = só conta quem já foi gravado na planilha (usado na entrada de
  // lançamento novo, pra dois lançamentos novos não descartarem um ao outro).
  onlyInSheet?: boolean;
}) {
  const candidates = await prisma.transaction.findMany({
    where: {
      companyId: params.companyId,
      kind: params.kind,
      dueDate: params.dueDate,
      amount: params.amount,
      id: { not: params.excludeId },
      ...(params.onlyInSheet ? { sheetCellRef: { not: null } } : {}),
    },
    include: { supplier: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
  });
  return (
    candidates.find((c) => c.supplierId === params.supplierId || sameSupplierName(c.supplier.name, params.supplierName)) ?? null
  );
}

// Mesmo fornecedor mesmo com o nome abreviado: "SENSORMATIC" e "SENSORMATIC DO
// BRASIL ELETRONICA LTDA" (um começa com o outro, em fronteira de palavra).
export function sameSupplierName(a: string, b: string): boolean {
  const ka = supplierKey(a);
  const kb = supplierKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  const [short, long] = ka.length <= kb.length ? [ka, kb] : [kb, ka];
  return short.length >= 5 && long.startsWith(short + " ");
}
