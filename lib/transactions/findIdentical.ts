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
  supplierTaxId?: string | null; // CNPJ/CPF: mesmo documento = mesmo fornecedor, seja qual for o nome
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
    include: { supplier: { select: { name: true, taxId: true } } },
    orderBy: { createdAt: "asc" },
  });
  return (
    candidates.find(
      (c) =>
        c.supplierId === params.supplierId ||
        sameTaxId(c.supplier.taxId, params.supplierTaxId) ||
        sameSupplierName(c.supplier.name, params.supplierName)
    ) ?? null
  );
}

/** Mesmo CNPJ/CPF (só dígitos, 11 ou 14). Relação de pagamentos e extrato trazem o nome truncado, mas o documento é o mesmo. */
export function sameTaxId(a: string | null | undefined, b: string | null | undefined): boolean {
  const da = (a ?? "").replace(/\D/g, "");
  const db = (b ?? "").replace(/\D/g, "");
  return (da.length === 11 || da.length === 14) && da === db;
}

// Mesmo fornecedor mesmo com o nome abreviado: "SENSORMATIC" e "SENSORMATIC DO
// BRASIL ELETRONICA LTDA" (um começa com o outro, em fronteira de palavra).
export function sameSupplierName(a: string, b: string): boolean {
  const ka = supplierKey(a);
  const kb = supplierKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  const [short, long] = ka.length <= kb.length ? [ka, kb] : [kb, ka];
  if (short.length >= 5 && long.startsWith(short + " ")) return true;
  // Nome cortado pelo banco ("...SEGURANCA DO TRABA" x "...SEGURANCA DO TRABALHO"):
  // um é o começo do outro, com nome comprido o bastante pra não ser coincidência.
  return short.length >= 20 && long.startsWith(short);
}
