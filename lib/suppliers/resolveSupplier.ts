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
