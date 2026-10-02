import { prisma } from "@/lib/db/prisma";
import type { Supplier } from "@prisma/client";
import { normalizeText as normalizeName } from "@/lib/utils/normalizeText";

/**
 * Identifica o fornecedor/cliente a partir do que a IA leu no documento.
 * Casa primeiro por CNPJ/CPF (mais confiável), depois por nome normalizado.
 * Se não encontrar, cria um cadastro novo (ainda sem "perfil aprendido" —
 * isso é preenchido na tela de perguntas da primeira nota).
 */
export async function resolveSupplier(params: {
  companyId: string;
  nameRaw: string;
  taxId: string | null;
}): Promise<Supplier> {
  const normalizedName = normalizeName(params.nameRaw);
  let taxId = params.taxId;

  if (taxId) {
    const byTaxId = await prisma.supplier.findFirst({
      where: { companyId: params.companyId, taxId },
    });
    if (byTaxId) {
      if (namesShareWord(byTaxId.normalizedName, normalizedName)) return byTaxId;
      // O CNPJ bateu com um cadastro de nome nada a ver com o lido: a IA pegou
      // o CNPJ da outra parte da nota (ex: o da GLM destinatária numa nota da
      // TEAR). Confia no nome e descarta esse CNPJ, senão a nota caía no
      // cadastro errado.
      taxId = null;
    }
  }

  const byName = await prisma.supplier.findUnique({
    where: {
      companyId_normalizedName: {
        companyId: params.companyId,
        normalizedName,
      },
    },
  });
  if (byName) {
    // Se já existia sem CNPJ registrado e agora lemos um, completa o cadastro.
    if (taxId && !byName.taxId) {
      return prisma.supplier.update({
        where: { id: byName.id },
        data: { taxId },
      });
    }
    return byName;
  }

  return prisma.supplier.create({
    data: {
      companyId: params.companyId,
      // Maiúsculo por padrão estético — a maioria já vem assim da nota
      // (CNPJ/razão social), então isso deixa tudo consistente na planilha.
      name: params.nameRaw.toUpperCase(),
      taxId,
      normalizedName,
    },
  });
}

// Palavras genéricas de razão social — não servem pra dizer que dois nomes são
// da mesma empresa.
const GENERIC_WORDS = new Set([
  "ltda", "eireli", "epp", "cia", "industria", "comercio", "servicos", "servico",
  "dos", "das", "importacao", "exportacao", "distribuidora", "participacoes",
]);

function significantWords(normalized: string): string[] {
  return normalized.split(" ").filter((w) => w.length >= 3 && !GENERIC_WORDS.has(w));
}

function namesShareWord(a: string, b: string): boolean {
  const wordsA = new Set(significantWords(a));
  return significantWords(b).some((w) => wordsA.has(w));
}

/** true quando este fornecedor ainda não tem o "perfil aprendido" — primeira nota dele. */
export function needsOnboardingQuestions(supplier: Supplier): boolean {
  return supplier.kind === null;
}
