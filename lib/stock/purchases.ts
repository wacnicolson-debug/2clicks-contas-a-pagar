import { prisma } from "@/lib/db/prisma";
import { getGoogleClientsForCompany } from "@/lib/sheets/client";
import { MONTHS } from "@/lib/sheets/provisionCompanySheet";
import { inngest } from "@/lib/inngest/client";
import { sameSupplierName } from "@/lib/transactions/findIdentical";
import type { PurchaseItem } from "@/lib/ai/extractPurchaseItems";
import { COMPRAS_TAB, ESTOQUE_TAB, getOrCreateStockSheetForYear } from "./stockSheet";
import { STOCK_KIND_LABEL, stockKindForCategory, type StockKind } from "./stockRules";

const ID_COL: Record<string, { letter: string; last: string }> = {
  [COMPRAS_TAB]: { letter: "I", last: "I" },
  [ESTOQUE_TAB]: { letter: "L", last: "L" },
};

// Duas notas gravando na mesma aba ao mesmo tempo não podem escolher a mesma
// linha livre — trava no banco por planilha+aba enquanto lê a próxima linha e grava.
async function withTabLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
      return fn();
    },
    { timeout: 90000, maxWait: 60000 }
  );
}

async function readIds(spreadsheetId: string, tab: string, token: string): Promise<string[]> {
  const { sheets } = getGoogleClientsForCompany(token);
  const col = ID_COL[tab].letter;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${tab}'!${col}1:${col}${25000}` });
  return (res.data.values ?? []).map((r) => String(r?.[0] ?? ""));
}

async function appendRows(
  spreadsheetId: string,
  tab: string,
  token: string,
  rows: (string | number)[][]
): Promise<void> {
  if (rows.length === 0) return;
  await withTabLock(`stock:${spreadsheetId}:${tab}`, async () => {
    const ids = await readIds(spreadsheetId, tab, token);
    const next = Math.max(ids.length, 2) + 1; // cabeçalho na linha 2
    const { sheets } = getGoogleClientsForCompany(token);
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${tab}'!A${next}:${ID_COL[tab].last}${next + rows.length - 1}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: rows },
    });
  });
}

/** Apaga (subindo o resto da tabela) as linhas de uma nota numa aba, achadas pela coluna ID. */
async function removeRowsById(spreadsheetId: string, tab: string, token: string, id: string): Promise<number> {
  return withTabLock(`stock:${spreadsheetId}:${tab}`, async () => {
    const ids = await readIds(spreadsheetId, tab, token);
    const rows: number[] = [];
    ids.forEach((v, i) => {
      if (v === id && i >= 2) rows.push(i); // 0-based
    });
    if (rows.length === 0) return 0;
    const { sheets } = getGoogleClientsForCompany(token);
    const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets(properties(sheetId,title))" });
    const sheetId = meta.data.sheets?.find((s) => s.properties?.title === tab)?.properties?.sheetId;
    if (sheetId === undefined || sheetId === null) return 0;
    // de baixo pra cima, juntando linhas seguidas num pedido só
    const ranges: { start: number; end: number }[] = [];
    for (const r of rows.sort((a, b) => b - a)) {
      const last = ranges[ranges.length - 1];
      if (last && last.start === r + 1) last.start = r;
      else ranges.push({ start: r, end: r + 1 });
    }
    const tableCols = tab === COMPRAS_TAB ? 9 : 12;
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        // Só as colunas da tabela sobem (o resumo mensal ao lado, colunas N:R,
        // ficaria deslocado se a linha inteira fosse apagada).
        requests: ranges.map((g) => ({
          deleteRange: {
            range: { sheetId, startRowIndex: g.start, endRowIndex: g.end, startColumnIndex: 0, endColumnIndex: tableCols },
            shiftDimension: "ROWS",
          },
        })),
      },
    });
    return rows.length;
  });
}

function brDate(d: Date | null): string {
  if (!d) return "";
  return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
}

function noteKey(n: string | null | undefined): string | null {
  const k = (n ?? "").replace(/[^0-9a-z]/gi, "").toLowerCase().replace(/^0+/, "");
  return k || null;
}

async function companyToken(companyId: string): Promise<string> {
  const c = await prisma.company.findUniqueOrThrow({ where: { id: companyId } });
  if (!c.googleRefreshToken) throw new Error(`Empresa ${companyId} ainda não conectou o Google Sheets.`);
  return c.googleRefreshToken;
}

/**
 * Chamada depois que um lançamento de nota entra na planilha de contas a
 * pagar. Garante UMA linha por NOTA na aba Compras (valor total da nota, não
 * por parcela) e, se a categoria for de estoque (matéria-prima ou produto
 * químico), agenda a leitura dos itens pra aba Estoque. Idempotente.
 */
export async function capturePurchaseForTransaction(transactionId: string): Promise<void> {
  const t = await prisma.transaction.findUnique({
    where: { id: transactionId },
    include: { supplier: true, category: true, document: { select: { kind: true } } },
  });
  if (!t || t.kind !== "PAYABLE" || !t.documentPageId || t.document?.kind !== "INVOICES") return;

  const stockKind = stockKindForCategory(t.category?.name);
  const existing = await prisma.purchaseNote.findUnique({ where: { documentPageId: t.documentPageId } });
  if (existing) {
    // A categoria virou de estoque depois (edição): passa a ler os itens.
    if (stockKind && existing.itemsStatus === "NONE") {
      await prisma.purchaseNote.update({ where: { id: existing.id }, data: { stockKind, itemsStatus: "PENDING" } });
      await queueItems(existing.id);
    }
    return;
  }

  const page = await prisma.documentPage.findUnique({ where: { id: t.documentPageId } });
  const raw = (page?.rawExtraction ?? {}) as {
    noteNumber?: string | null;
    issueDate?: string | null;
    installments?: { amount?: number; dueDate?: string | null }[];
  };
  const installments = Array.isArray(raw.installments) ? raw.installments : [];
  let total = installments.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  if (!(total > 0)) {
    const sum = await prisma.transaction.aggregate({ where: { documentPageId: t.documentPageId }, _sum: { amount: true } });
    total = Number(sum._sum.amount ?? t.amount);
  }
  const installmentCount = Math.max(1, installments.length || 1);
  const noteNumber = (raw.noteNumber ?? t.noteNumber ?? null) || null;

  // Mesma nota chegando em outro arquivo: não entra de novo.
  const key = noteKey(noteNumber);
  if (key) {
    const sameNotes = await prisma.purchaseNote.findMany({
      where: { companyId: t.companyId, noteNumber: { not: null } },
      include: { supplier: { select: { name: true } } },
    });
    if (sameNotes.some((n) => noteKey(n.noteNumber) === key && (n.supplierId === t.supplierId || sameSupplierName(n.supplier.name, t.supplier.name)))) {
      return;
    }
  }

  const issueDate = raw.issueDate && /^\d{4}-\d{2}-\d{2}$/.test(raw.issueDate) ? new Date(`${raw.issueDate}T00:00:00Z`) : null;
  const firstDue = installments.map((i) => i.dueDate).filter((d): d is string => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d)).sort()[0];
  const base = issueDate ?? (firstDue ? new Date(`${firstDue}T00:00:00Z`) : t.dueDate);
  const monthDate = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), 1));
  const remark = issueDate ? null : "Mês pelo vencimento (a nota não trouxe data de emissão legível)";

  const note = await prisma.purchaseNote.create({
    data: {
      companyId: t.companyId,
      documentPageId: t.documentPageId,
      documentId: t.documentId!,
      supplierId: t.supplierId,
      noteNumber,
      issueDate,
      monthDate,
      year: monthDate.getUTCFullYear(),
      categoryName: t.category?.name ?? null,
      stockKind,
      totalAmount: total,
      installmentCount,
      remark,
      itemsStatus: stockKind ? "PENDING" : "NONE",
    },
  });

  try {
    const token = await companyToken(t.companyId);
    const spreadsheetId = await getOrCreateStockSheetForYear(t.companyId, note.year);
    await appendRows(spreadsheetId, COMPRAS_TAB, token, [
      [
        MONTHS[monthDate.getUTCMonth()],
        brDate(issueDate),
        t.supplier.name,
        noteNumber ?? "",
        t.category?.name ?? "",
        total,
        installmentCount,
        remark ?? "",
        note.id,
      ],
    ]);
  } catch (err) {
    await prisma.purchaseNote.delete({ where: { id: note.id } }).catch(() => {});
    throw err;
  }

  if (stockKind) await queueItems(note.id);
}

async function queueItems(purchaseNoteId: string): Promise<void> {
  try {
    await inngest.send({ id: `purchase-items-${purchaseNoteId}`, name: "purchase/items", data: { purchaseNoteId } });
  } catch (err) {
    console.error(`Não consegui agendar a leitura dos itens da nota ${purchaseNoteId}:`, err);
  }
}

/** Grava (ou regrava) as linhas de itens de uma nota na aba Estoque. */
export async function writeEstoqueRows(purchaseNoteId: string): Promise<void> {
  const note = await prisma.purchaseNote.findUnique({ where: { id: purchaseNoteId }, include: { supplier: true } });
  if (!note || !note.stockKind) return;
  const token = await companyToken(note.companyId);
  const spreadsheetId = await getOrCreateStockSheetForYear(note.companyId, note.year);
  await removeRowsById(spreadsheetId, ESTOQUE_TAB, token, note.id);

  const items = (Array.isArray(note.items) ? note.items : []) as unknown as PurchaseItem[];
  const month = MONTHS[note.monthDate.getUTCMonth()];
  const label = STOCK_KIND_LABEL[note.stockKind as StockKind];
  const common = [month, brDate(note.issueDate), note.supplier.name, note.noteNumber ?? "", label];
  const rows: (string | number)[][] =
    items.length === 0
      ? [[...common, "NÃO FOI POSSÍVEL LER OS ITENS — conferir a nota", "", "", "", "", note.remark ?? "", note.id]]
      : items.map((it, i) => [
          ...common,
          it.code ? `${it.description} (cód. ${it.code})` : it.description,
          it.quantity ?? "",
          it.unit ?? "",
          it.unitPrice ?? "",
          it.totalPrice ?? "",
          i === 0 ? (note.remark ?? "") : "",
          note.id,
        ]);
  await appendRows(spreadsheetId, ESTOQUE_TAB, token, rows);
}

/** Apaga a nota das duas abas e do banco (usado quando a nota é excluída). */
export async function removePurchaseForPage(documentPageId: string): Promise<void> {
  const note = await prisma.purchaseNote.findUnique({ where: { documentPageId } });
  if (!note) return;
  try {
    const stock = await prisma.stockSheet.findUnique({ where: { companyId_year: { companyId: note.companyId, year: note.year } } });
    if (stock) {
      const token = await companyToken(note.companyId);
      await removeRowsById(stock.spreadsheetId, COMPRAS_TAB, token, note.id);
      await removeRowsById(stock.spreadsheetId, ESTOQUE_TAB, token, note.id);
    }
  } catch (err) {
    console.error(`Falha ao limpar a nota ${note.id} da planilha de Compras e Estoque:`, err);
  }
  await prisma.purchaseNote.delete({ where: { id: note.id } }).catch(() => {});
}

/** Só remove se a nota não tem mais nenhum lançamento (excluir 1 parcela não apaga a compra). */
export async function removePurchaseIfOrphan(documentPageId: string | null | undefined): Promise<void> {
  if (!documentPageId) return;
  const left = await prisma.transaction.count({ where: { documentPageId } });
  if (left === 0) await removePurchaseForPage(documentPageId);
}

/**
 * A nota não tinha data de emissão no lançamento (leitura antiga) e a leitura
 * dos itens achou: acerta a data e o mês da nota no banco e na aba Compras
 * (tirando a linha da planilha do ano antigo e regravando no ano certo).
 */
export async function applyIssueDate(purchaseNoteId: string, issueDateIso: string): Promise<void> {
  const note = await prisma.purchaseNote.findUnique({ where: { id: purchaseNoteId }, include: { supplier: true } });
  if (!note || note.issueDate || !/^\d{4}-\d{2}-\d{2}$/.test(issueDateIso)) return;
  const issueDate = new Date(`${issueDateIso}T00:00:00Z`);
  const monthDate = new Date(Date.UTC(issueDate.getUTCFullYear(), issueDate.getUTCMonth(), 1));
  const oldYear = note.year;
  const token = await companyToken(note.companyId);

  const oldStock = await prisma.stockSheet.findUnique({ where: { companyId_year: { companyId: note.companyId, year: oldYear } } });
  if (oldStock) await removeRowsById(oldStock.spreadsheetId, COMPRAS_TAB, token, note.id);

  const remark = note.remark?.replace(/Mês pelo vencimento \([^)]*\);?\s*/g, "").trim() || null;
  const updated = await prisma.purchaseNote.update({
    where: { id: note.id },
    data: { issueDate, monthDate, year: monthDate.getUTCFullYear(), remark },
  });
  const spreadsheetId = await getOrCreateStockSheetForYear(updated.companyId, updated.year);
  await appendRows(spreadsheetId, COMPRAS_TAB, token, [
    [
      MONTHS[monthDate.getUTCMonth()],
      brDate(issueDate),
      note.supplier.name,
      note.noteNumber ?? "",
      note.categoryName ?? "",
      Number(note.totalAmount),
      note.installmentCount,
      remark ?? "",
      note.id,
    ],
  ]);
}
