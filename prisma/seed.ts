import "dotenv/config";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/db/prisma";
import { DEFAULT_CATEGORIES } from "../lib/sheets/provisionCompanySheet";
import { normalizeText } from "../lib/utils/normalizeText";

async function main() {
  const companyName = process.env.SEED_COMPANY_NAME ?? "Empresa Teste";

  const company = await prisma.company.upsert({
    where: { id: "seed-company" },
    update: {},
    create: { id: "seed-company", name: companyName },
  });

  const passwordHash = await bcrypt.hash(
    process.env.SEED_USER_PASSWORD ?? "123456",
    10
  );

  await prisma.user.upsert({
    where: { companyId_username: { companyId: company.id, username: "admin" } },
    update: {},
    create: {
      companyId: company.id,
      username: "admin",
      passwordHash,
    },
  });

  for (const name of DEFAULT_CATEGORIES) {
    const normalizedName = normalizeText(name);
    await prisma.category.upsert({
      where: { companyId_normalizedName: { companyId: company.id, normalizedName } },
      update: {},
      create: { companyId: company.id, name, normalizedName },
    });
  }

  // A planilha não é criada aqui — a conta de serviço não tem espaço no Drive
  // para criar arquivos novos (limitação do Google). Ela é criada ao logar e
  // clicar em "Conectar Google Sheets", que autoriza como o usuário real e
  // provisiona a planilha direto no Drive dele (ver /api/auth/google/connect).
  console.log(
    `Empresa "${company.name}" pronta. Login: admin / ${process.env.SEED_USER_PASSWORD ?? "123456"}`
  );
  console.log('Depois de logar, clique em "Conectar Google Sheets" no painel principal.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
