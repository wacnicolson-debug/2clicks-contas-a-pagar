import { prisma } from "@/lib/db/prisma";
import { getGoogleClientsForCompany } from "@/lib/sheets/client";
import { MONTHS } from "@/lib/sheets/provisionCompanySheet";
import { inngest } from "@/lib/inngest/client";
import { sameSupplierName } from "@/lib/transactions/findIdentical";
import { downloadDocumentFile } from "@/lib/storage/supabase";
import type { PurchaseItem } from "@/lib/ai/extractPurchaseItems";
import { extractPurchaseHeader, type PurchaseHeader } from "@/lib/ai/extractPurchaseHeader";
import { buildItemRows, knownItemNamesFor } from "./itens";
import { COMPRAS_TABLE_COLS, ESTOQUE_HEADERS, ESTOQUE_TAB, ITENS_HEADERS, ITENS_TAB, getOrCreateStockSheetForYear, isMonthTab } from "./stockSheet";
import { lancamentoAutomaticoParaFornecedor } from "./lancAutomatico";
import { STOCK_KIND_LABEL, stockKindForCategory, type StockKind } from "./stockRules";

const MAX_ROWS = 20000;

// A coluna ID (oculta) é a última da tabela: U nas abas de mês, M no Estoque.
function idColLetter(tab: string): string {
  return isMonthTab(tab) ? "U" : "M";
}
function tableCols(tab: string): number {
  return isMonthTab(tab) ? COMPRAS_TABLE_COLS : ESTOQUE_HEADERS.length;
}

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
  const col = idColLetter(tab);
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${tab}'!${col}1:${col}${25000}` });
  return (res.data.values ?? []).map((r) => String(r?.[0] ?? ""));
}

async function sheetIdOf(spreadsheetId: string, tab: string, token: string): Promise<number | null> {
  const { sheets } = getGoogleClientsForCompany(token);
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets(properties(sheetId,title))" });
  const id = meta.data.sheets?.find((s) => s.properties?.title === tab)?.properties?.sheetId;
  return id === undefined || id === null ? null : id;
}

async function appendRows(
  spreadsheetId: string,
  tab: string,
  token: string,
  rows: (string | number | boolean)[][]
): Promise<void> {
  if (rows.length === 0) return;
  await withTabLock(`stock:${spreadsheetId}:${tab}`, async () => {
    const ids = await readIds(spreadsheetId, tab, token);
    const next = Math.max(ids.length, 2) + 1; // cabeçalho na linha 2
    const { sheets } = getGoogleClientsForCompany(token);
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${tab}'!A${next}:${idColLetter(tab)}${next + rows.length - 1}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: rows },
    });
    if (isMonthTab(tab)) {
      // Aba de mês: sempre em ordem de emissão (a coluna ID acompanha a linha).
      const sheetId = await sheetIdOf(spreadsheetId, tab, token);
      if (sheetId !== null) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [
              {
                sortRange: {
                  range: { sheetId, startRowIndex: 2, endRowIndex: MAX_ROWS, startColumnIndex: 0, endColumnIndex: COMPRAS_TABLE_COLS },
                  sortSpecs: [
                    { dimensionIndex: 0, sortOrder: "ASCENDING" },
                    { dimensionIndex: 1, sortOrder: "ASCENDING" },
                  ],
                },
              },
            ],
          },
        });
      }
    }
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
    const sheetId = await sheetIdOf(spreadsheetId, tab, token);
    if (sheetId === null) return 0;
    // de baixo pra cima, juntando linhas seguidas num pedido só
    const ranges: { start: number; end: number }[] = [];
    for (const r of rows.sort((a, b) => b - a)) {
      const last = ranges[ranges.length - 1];
      if (last && last.start === r + 1) last.start = r;
      else ranges.push({ start: r, end: r + 1 });
    }
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        // Só as colunas da tabela sobem (o resumo ao lado ficaria deslocado se a
        // linha inteira fosse apagada).
        requests: ranges.map((g) => ({
          deleteRange: {
            range: { sheetId, startRowIndex: g.start, endRowIndex: g.end, startColumnIndex: 0, endColumnIndex: tableCols(tab) },
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

/** CFOP de ENTRADA a partir do CFOP impresso na nota do fornecedor (5→1, 6→2, 7→3). */
export function entryCfop(cfop: string): string {
  const map: Record<string, string> = { "5": "1", "6": "2", "7": "3" };
  return map[cfop[0]] ? map[cfop[0]] + cfop.slice(1) : cfop;
}

/** Lê se a nota já está marcada como "Lançado" (coluna T) na aba. */
async function readLancadoRow(spreadsheetId: string, tab: string, token: string, id: string): Promise<boolean> {
  const { sheets } = getGoogleClientsForCompany(token);
  const ids = await readIds(spreadsheetId, tab, token);
  const row = ids.findIndex((v, i) => v === id && i >= 2);
  if (row < 0) return false;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${tab}'!T${row + 1}`, valueRenderOption: "UNFORMATTED_VALUE" });
  return res.data.values?.[0]?.[0] === true;
}

function formatCnpj(d: string | null | undefined): string {
  const x = (d ?? "").replace(/\D/g, "");
  return x.length === 14 ? `${x.slice(0, 2)}.${x.slice(2, 5)}.${x.slice(5, 8)}/${x.slice(8, 12)}-${x.slice(12)}` : x;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Chamada depois que um lançamento de nota entra na planilha de contas a
 * pagar. Cria UMA nota de compra por NOTA (não por parcela) e agenda a leitura
 * do cabeçalho fiscal. A linha só entra na planilha de Compras depois dessa
 * leitura (é ela que diz se é nota fiscal e em que mês/dia a nota cai).
 * Idempotente.
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
    // Categoria mudou depois (edição): atualiza a nota, a linha de Compras e,
    // se virou de estoque, passa a ler os itens.
    const categoryName = t.category?.name ?? null;
    if (existing.categoryName !== categoryName || (stockKind && !existing.stockKind)) {
      const becameStock = !!stockKind && !existing.stockKind;
      const updated = await prisma.purchaseNote.update({
        where: { id: existing.id },
        data: {
          categoryName,
          ...(becameStock ? { stockKind, itemsStatus: existing.headerStatus === "SKIPPED" ? "NONE" : "PENDING" } : {}),
        },
      });
      if (updated.headerStatus === "DONE") {
        await writeComprasRow(updated.id);
        if (becameStock) await queueItems(updated.id);
      }
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

  // Mês provisório (a leitura do cabeçalho acerta pela data de emissão).
  const issueDate = raw.issueDate && ISO.test(raw.issueDate) ? new Date(`${raw.issueDate}T00:00:00Z`) : null;
  const firstDue = installments.map((i) => i.dueDate).filter((d): d is string => !!d && ISO.test(d)).sort()[0];
  const base = issueDate ?? (firstDue ? new Date(`${firstDue}T00:00:00Z`) : t.dueDate);
  const monthDate = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), 1));

  let note;
  try {
    note = await prisma.purchaseNote.create({
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
        headerStatus: "PENDING",
        itemsStatus: stockKind ? "PENDING" : "NONE",
      },
    });
  } catch (err) {
    // outra parcela da mesma nota criou primeiro
    if ((err as { code?: string }).code === "P2002") return;
    throw err;
  }
  await queueHeader(note.id);
}

async function queueHeader(purchaseNoteId: string): Promise<void> {
  try {
    await inngest.send({ id: `purchase-header-${purchaseNoteId}`, name: "purchase/header", data: { purchaseNoteId } });
  } catch (err) {
    console.error(`Não consegui agendar a leitura fiscal da nota ${purchaseNoteId}:`, err);
  }
}

async function queueItems(purchaseNoteId: string): Promise<void> {
  try {
    await inngest.send({ id: `purchase-items-${purchaseNoteId}`, name: "purchase/items", data: { purchaseNoteId } });
  } catch (err) {
    console.error(`Não consegui agendar a leitura dos itens da nota ${purchaseNoteId}:`, err);
  }
}

/** Lê o cabeçalho fiscal da nota (página + folhas de continuação). */
export async function readPurchaseHeader(purchaseNoteId: string): Promise<PurchaseHeader> {
  const note = await prisma.purchaseNote.findUniqueOrThrow({ where: { id: purchaseNoteId } });
  try {
    const page = await prisma.documentPage.findUniqueOrThrow({ where: { id: note.documentPageId } });
    const document = await prisma.document.findUniqueOrThrow({ where: { id: note.documentId } });
    const siblings = await prisma.documentPage.findMany({ where: { documentId: note.documentId } });
    const continuation = siblings
      .filter((p) => (p.rawExtraction as { duplicateOfPageNumber?: number | null }).duplicateOfPageNumber === page.pageNumber)
      .map((p) => p.pageNumber);
    const buffer = await downloadDocumentFile(document.storagePath);
    return await extractPurchaseHeader({
      fileBase64: buffer.toString("base64"),
      mimeType: document.mimeType,
      pageNumbers: [page.pageNumber, ...continuation].sort((a, b) => a - b),
    });
  } catch (err) {
    await prisma.purchaseNote.update({ where: { id: note.id }, data: { headerStatus: "ERROR" } });
    throw err;
  }
}

/**
 * Grava o cabeçalho lido e põe a nota na aba do mês certo. Não é nota fiscal
 * (boleto, guia, folha...): fica de fora das duas abas. Devolve se há itens a ler.
 */
export async function savePurchaseHeader(purchaseNoteId: string, header: PurchaseHeader): Promise<{ skipped: boolean; readItems: boolean }> {
  const note = await prisma.purchaseNote.findUniqueOrThrow({ where: { id: purchaseNoteId } });
  if (header.docType === "OUTRO") {
    await prisma.purchaseNote.update({
      where: { id: note.id },
      data: { headerStatus: "SKIPPED", stockKind: null, itemsStatus: "NONE", header: header as unknown as object },
    });
    return { skipped: true, readItems: false };
  }

  const prev = note.headerStatus === "DONE" ? { year: note.year, monthDate: note.monthDate } : undefined;
  const issueDate = header.issueDate ? new Date(`${header.issueDate}T00:00:00Z`) : note.issueDate;
  const firstDue = (await prisma.transaction.findMany({ where: { documentPageId: note.documentPageId }, select: { dueDate: true }, orderBy: { dueDate: "asc" }, take: 1 }))[0]?.dueDate;
  const base = issueDate ?? firstDue ?? note.monthDate;
  const monthDate = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), 1));

  const remarks: string[] = [];
  if (header.remark) remarks.push(header.remark);
  if (!issueDate) remarks.push("Mês pelo vencimento (a nota não trouxe data de emissão legível)");
  const installmentsTotal = Number(note.totalAmount);
  if (header.noteTotal !== null && Math.abs(header.noteTotal - installmentsTotal) > 0.05) {
    remarks.push(`Total da nota (R$ ${header.noteTotal.toFixed(2)}) difere da soma das parcelas lançadas (R$ ${installmentsTotal.toFixed(2)}) — conferir`);
  }

  await prisma.purchaseNote.update({
    where: { id: note.id },
    data: {
      headerStatus: "DONE",
      header: header as unknown as object,
      noteNumber: header.noteNumber ?? note.noteNumber,
      issueDate,
      monthDate,
      year: monthDate.getUTCFullYear(),
      remark: remarks.join("; ") || null,
    },
  });
  await writeComprasRow(note.id, prev);
  return { skipped: false, readItems: !!note.stockKind && note.itemsStatus !== "DONE" };
}

/** Escreve (ou muda de lugar) a linha da nota na aba do mês dela. `prev` = onde ela estava antes. */
export async function writeComprasRow(purchaseNoteId: string, prev?: { year: number; monthDate: Date }): Promise<void> {
  const note = await prisma.purchaseNote.findUnique({ where: { id: purchaseNoteId }, include: { supplier: true } });
  if (!note || note.headerStatus !== "DONE") return;
  const token = await companyToken(note.companyId);
  const h = (note.header ?? {}) as Partial<PurchaseHeader>;

  let lancadoAnterior = false;
  if (prev) {
    const old = await prisma.stockSheet.findUnique({ where: { companyId_year: { companyId: note.companyId, year: prev.year } } });
    if (old) {
      lancadoAnterior = await readLancadoRow(old.spreadsheetId, MONTHS[prev.monthDate.getUTCMonth()], token, note.id);
      await removeRowsById(old.spreadsheetId, MONTHS[prev.monthDate.getUTCMonth()], token, note.id);
    }
  }
  const spreadsheetId = await getOrCreateStockSheetForYear(note.companyId, note.year);
  const tab = MONTHS[note.monthDate.getUTCMonth()];
  const lancado = lancadoAnterior || (await readLancadoRow(spreadsheetId, tab, token, note.id));
  await removeRowsById(spreadsheetId, tab, token, note.id); // idempotente: nunca duas linhas da mesma nota
  const blank = (v: number | null | undefined) => (v === null || v === undefined ? "" : v);
  const lancAuto = lancamentoAutomaticoParaFornecedor(note.supplier.name);
  const cfop = (h.cfops ?? []).map(entryCfop).join(" / ");
  const pct = h.icmsBase && h.icmsValue ? Math.round((h.icmsValue / h.icmsBase) * 10000) / 100 : "";
  const modelo = h.docType === "NFSE" ? "" : h.accessKey ? h.accessKey.slice(20, 22) : "55";
  await appendRows(spreadsheetId, tab, token, [
    [
      brDate(note.issueDate),
      note.supplier.name,
      cfop,
      h.noteTotal ?? Number(note.totalAmount),
      "", // Entrada: quem digita no Alterdata preenche
      h.docType === "NFSE" ? "NFSe" : "NFe",
      h.series ?? "",
      modelo,
      note.noteNumber ?? "",
      blank(h.icmsBase),
      pct,
      blank(h.icmsValue),
      blank(h.ipi),
      blank(h.freight),
      formatCnpj(h.supplierCnpj),
      h.accessKey ?? "",
      note.categoryName ?? "",
      note.remark ?? "",
      lancAuto,
      lancado,
      note.id,
    ],
  ]);
}

/** Grava (ou regrava) as linhas de itens de uma nota na aba Estoque. */
export async function writeEstoqueRows(purchaseNoteId: string): Promise<void> {
  const note = await prisma.purchaseNote.findUnique({ where: { id: purchaseNoteId }, include: { supplier: true } });
  if (!note || !note.stockKind || note.headerStatus !== "DONE") return;
  const token = await companyToken(note.companyId);
  const spreadsheetId = await getOrCreateStockSheetForYear(note.companyId, note.year);
  await removeRowsById(spreadsheetId, ESTOQUE_TAB, token, note.id);

  const items = (Array.isArray(note.items) ? note.items : []) as unknown as PurchaseItem[];
  const month = MONTHS[note.monthDate.getUTCMonth()];
  const label = STOCK_KIND_LABEL[note.stockKind as StockKind];
  const common = [month, brDate(note.issueDate), note.supplier.name, note.noteNumber ?? "", label];
  const rows: (string | number)[][] =
    items.length === 0
      ? [[...common, "NÃO FOI POSSÍVEL LER OS ITENS — conferir a nota", "", "", "", "", note.remark ?? "", "", note.id]]
      : items.map((it, i) => [
          ...common,
          it.code ? `${it.description} (cód. ${it.code})` : it.description,
          it.quantity ?? "",
          it.unit ?? "",
          it.unitPrice ?? "",
          it.totalPrice ?? "",
          i === 0 ? (note.remark ?? "") : "",
          it.itemName ?? "",
          note.id,
        ]);
  await appendRows(spreadsheetId, ESTOQUE_TAB, token, rows);
  await rebuildItemsTab(note.companyId, note.year).catch((err) => console.error("Falha ao atualizar a aba Itens:", err));
}

/** Nomes padrão de item já usados (a IA reaproveita pra não duplicar o item). */
export async function knownItemNames(companyId: string, kind: StockKind): Promise<string[]> {
  return knownItemNamesFor(companyId, kind);
}

/** Reescreve a aba Itens do ano inteira a partir das notas lidas (preço, variação, média de 3 meses). */
export async function rebuildItemsTab(companyId: string, year: number): Promise<void> {
  const stock = await prisma.stockSheet.findUnique({ where: { companyId_year: { companyId, year } } });
  if (!stock) return;
  const token = await companyToken(companyId);
  const rows = await buildItemRows(companyId);
  const { sheets } = getGoogleClientsForCompany(token);
  await withTabLock(`stock:${stock.spreadsheetId}:${ITENS_TAB}`, async () => {
    await sheets.spreadsheets.values.clear({ spreadsheetId: stock.spreadsheetId, range: `'${ITENS_TAB}'!A3:${String.fromCharCode(64 + ITENS_HEADERS.length)}${MAX_ROWS}` });
    if (rows.length === 0) return;
    await sheets.spreadsheets.values.update({
      spreadsheetId: stock.spreadsheetId,
      range: `'${ITENS_TAB}'!A3`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: rows },
    });
  });
}

/** Apaga a nota das duas abas e do banco (usado quando a nota é excluída). */
export async function removePurchaseForPage(documentPageId: string): Promise<void> {
  const note = await prisma.purchaseNote.findUnique({ where: { documentPageId } });
  if (!note) return;
  try {
    const stock = await prisma.stockSheet.findUnique({ where: { companyId_year: { companyId: note.companyId, year: note.year } } });
    if (stock && note.headerStatus === "DONE") {
      const token = await companyToken(note.companyId);
      await removeRowsById(stock.spreadsheetId, MONTHS[note.monthDate.getUTCMonth()], token, note.id);
      await removeRowsById(stock.spreadsheetId, ESTOQUE_TAB, token, note.id);
    }
  } catch (err) {
    console.error(`Falha ao limpar a nota ${note.id} da planilha de Compras e Estoque:`, err);
  }
  await prisma.purchaseNote.delete({ where: { id: note.id } }).catch(() => {});
  if (note.stockKind) await rebuildItemsTab(note.companyId, note.year).catch((err) => console.error("Falha ao atualizar a aba Itens:", err));
}

/** Só remove se a nota não tem mais nenhum lançamento (excluir 1 parcela não apaga a compra). */
export async function removePurchaseIfOrphan(documentPageId: string | null | undefined): Promise<void> {
  if (!documentPageId) return;
  const left = await prisma.transaction.count({ where: { documentPageId } });
  if (left === 0) await removePurchaseForPage(documentPageId);
}

/**
 * Nota sem data de emissão depois da leitura fiscal: a leitura dos itens achou
 * (ou o cabeçalho veio sem). Acerta data e mês no banco e muda a linha de aba.
 */
export async function applyIssueDate(purchaseNoteId: string, issueDateIso: string): Promise<void> {
  const note = await prisma.purchaseNote.findUnique({ where: { id: purchaseNoteId } });
  if (!note || note.issueDate || !ISO.test(issueDateIso)) return;
  const issueDate = new Date(`${issueDateIso}T00:00:00Z`);
  const monthDate = new Date(Date.UTC(issueDate.getUTCFullYear(), issueDate.getUTCMonth(), 1));
  const remark = note.remark?.replace(/Mês pelo vencimento \([^)]*\);?\s*/g, "").trim() || null;
  const prev = note.headerStatus === "DONE" ? { year: note.year, monthDate: note.monthDate } : undefined;
  await prisma.purchaseNote.update({
    where: { id: note.id },
    data: { issueDate, monthDate, year: monthDate.getUTCFullYear(), remark },
  });
  await writeComprasRow(note.id, prev);
}
