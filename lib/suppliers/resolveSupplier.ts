import { prisma } from "@/lib/db/prisma";
import type { Supplier } from "@prisma/client";
import { normalizeText as normalizeName } from "@/lib/utils/normalizeText";

function firstWords(normalized: string, count: number): string {
  return normalized.split(" ").slice(0, count).join(" ");
}

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

  if (params.taxId) {
    const byTaxId = await prisma.supplier.findFirst({
      where: { companyId: params.companyId, taxId: params.taxId },
    });
    if (byTaxId) return byTaxId;
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
    if (params.taxId && !byName.taxId) {
      return prisma.supplier.update({
        where: { id: byName.id },
        data: { taxId: params.taxId },
      });
    }
    return byName;
  }

  // Nome não bateu exato — mas a razão social do mesmo fornecedor costuma vir
  // escrita de jeitos diferentes de documento pra documento ("Tear Têxtil
  // Ltda" vs "TEAR TEXTIL INDUSTRIA E COMERCIO LTDA"). Casa pelas 2
  // primeiras palavras do nome normalizado — geralmente já identifica a
  // empresa sozinho — em vez de criar um cadastro duplicado.
  const prefix = firstWords(normalizedName, 2);
  if (prefix) {
    const candidates = await prisma.supplier.findMany({
      where: { companyId: params.companyId },
    });
    const byPrefix = candidates.find((c) => firstWords(c.normalizedName, 2) === prefix);
    if (byPrefix) {
      if (params.taxId && !byPrefix.taxId) {
        return prisma.supplier.update({
          where: { id: byPrefix.id },
          data: { taxId: params.taxId },
        });
      }
      return byPrefix;
    }
  }

  return prisma.supplier.create({
    data: {
      companyId: params.companyId,
      // Maiúsculo por padrão estético — a maioria já vem assim da nota
      // (CNPJ/razão social), então isso deixa tudo consistente na planilha.
      name: params.nameRaw.toUpperCase(),
      taxId: params.taxId,
      normalizedName,
    },
  });
}

/** true quando este fornecedor ainda não tem o "perfil aprendido" — primeira nota dele. */
export function needsOnboardingQuestions(supplier: Supplier): boolean {
  return supplier.kind === null;
}
