import type { sheets_v4 } from "googleapis";
import { prisma } from "@/lib/db/prisma";
import { getGoogleClientsForCompany } from "./client";
import { MONTHS } from "./provisionCompanySheet";
import {
  FIRST_DATA_ROW,
  SCAN_LAST_ROW,
  cellToNumber,
  columnLetter,
  findDayColumnOffset,
  findExcluirColumn,
  findHeaderColumn,
  locateDayBlocks,
  readDayTabState,
  rowHasData,
  rowMatchesTransaction,
  validDay,
} from "./dayBlockLayout";
import { blankDayRow, rebuildDayBlock } from "./syncTransaction";
import { deleteTransactionEverywhere } from "@/lib/transactions/deleteTransaction";

const ROWS_PER_DAY = 30;
const HEADER_ROWS = 2;
const DAYS_IN_BLOCK = 31;
const LAST_BLOCK_ROW1 = HEADER_ROWS + DAYS_IN_BLOCK * ROWS_PER_DAY;

// Um processamento por empresa por vez nesta instância (duas abas abertas
// consultando juntas não disparam a mesma exclusão duas vezes).
// Guarda quando começou: se uma rodada travar (chamada do Google que não
// volta), a próxima tenta de novo depois de 60 s em vez de ficar bloqueada.
const running = new Map<string, number>();
const RUNNING_STALE_MS = 60 * 1000;

// Onde o app cria a coluna EXCLUIR quando a aba ainda não tem uma (T, bem
// longe de PAGO/CONFERIDO pra não marcar sem querer). Depois de criada, o
// usuário pode mover — o app sempre acha pelo cabeçalho.
const DEFAULT_EXCLUIR_COLUMN = 19;
// CONCILIADO (conciliação bancária) nasce logo depois de PAGO (L) e CONFERIDO (M).
const DEFAULT_CONCILIADO_COLUMN = 13;
const PROVISION_RETRY_MS = 10 * 60 * 1000;
const provisionAttempts = new Map<string, number>();

/**
 * Cria uma coluna de caixinha (cabeçalho na linha 2 + caixinhas até o fim dos
 * blocos de dia) nas abas de mês que ainda não têm. Só é chamada para abas
 * em que a coluna padrão está vazia no cabeçalho, e não apaga nem sobrescreve
 * nada. Se falhar, só tenta de novo depois de alguns minutos.
 */
async function ensureCheckboxColumn(
  sheets: ReturnType<typeof getGoogleClientsForCompany>["sheets"],
  spreadsheetId: string,
  tabs: string[],
  name: string,
  columnIndex: number,
  // Se informada, a linha inteira (de A até esta coluna) muda pra essa cor
  // quando a caixinha está marcada — regra no topo da lista, então vale por
  // cima das outras cores (ex: o amarelo do PAGO).
  highlight?: { red: number; green: number; blue: number }
): Promise<void> {
  const attemptKey = `${spreadsheetId}:${name}`;
  const last = provisionAttempts.get(attemptKey);
  if (last && Date.now() - last < PROVISION_RETRY_MS) return;
  provisionAttempts.set(attemptKey, Date.now());

  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties(sheetId,title,gridProperties)",
  });

  const requests: sheets_v4.Schema$Request[] = [];
  for (const tab of tabs) {
    const props = meta.data.sheets?.find((s) => s.properties?.title === tab)?.properties;
    if (!props || props.sheetId == null) continue;
    const sheetId = props.sheetId;

    const columnCount = props.gridProperties?.columnCount ?? 0;
    if (columnCount <= columnIndex) {
      requests.push({
        appendDimension: { sheetId, dimension: "COLUMNS", length: columnIndex + 1 - columnCount },
      });
    }
    requests.push({
      updateCells: {
        range: {
          sheetId,
          startRowIndex: HEADER_ROWS - 1,
          endRowIndex: HEADER_ROWS,
          startColumnIndex: columnIndex,
          endColumnIndex: columnIndex + 1,
        },
        rows: [
          {
            values: [
              {
                userEnteredValue: { stringValue: name },
                userEnteredFormat: { textFormat: { bold: true } },
              },
            ],
          },
        ],
        fields: "userEnteredValue,userEnteredFormat.textFormat",
      },
    });
    requests.push({
      setDataValidation: {
        range: {
          sheetId,
          startRowIndex: HEADER_ROWS,
          endRowIndex: LAST_BLOCK_ROW1,
          startColumnIndex: columnIndex,
          endColumnIndex: columnIndex + 1,
        },
        rule: { condition: { type: "BOOLEAN" }, strict: true, showCustomUi: true },
      },
    });
    if (highlight) {
      requests.push({
        addConditionalFormatRule: {
          rule: {
            ranges: [
              {
                sheetId,
                startRowIndex: HEADER_ROWS,
                endRowIndex: LAST_BLOCK_ROW1,
                startColumnIndex: 0,
                endColumnIndex: columnIndex + 1,
              },
            ],
            booleanRule: {
              condition: {
                type: "CUSTOM_FORMULA",
                values: [{ userEnteredValue: `=$${columnLetter(columnIndex)}${HEADER_ROWS + 1}=TRUE` }],
              },
              format: { backgroundColor: highlight },
            },
          },
          index: 0,
        },
      });
    }
  }

  if (requests.length === 0) return;
  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
}

// Linhas livres que cada dia mantém sobrando: o app abre mais quando o usuário
// vai preenchendo (ex: conciliação com o extrato, lançando à mão linha a linha).
const SPARE_ROWS = 3;
const GROW_INTERVAL_MS = 20 * 1000;
const MAX_BLOCK_ROWS = 120;
const lastGrow = new Map<string, number>();
const sheetIdCache = new Map<string, number>();

/**
 * Mantém sempre algumas linhas livres em cada dia do mês anterior, atual e
 * seguinte: se um dia ficou cheio (todas as linhas com fornecedor), abre mais
 * linhas DENTRO do bloco dele (antes da última), do mesmo jeito que o usuário
 * faria à mão. Não escreve em nenhum lançamento — só insere linhas em branco
 * (sem cor própria) com o número do dia na coluna Dia.
 */
async function growFullBlocks(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  year: number
): Promise<void> {
  const now = new Date();
  const isCurrentYear = year === now.getUTCFullYear();
  // Ano seguinte (ex: 2027) também: lançamentos já vêm com vencimento lá.
  if (!isCurrentYear && year !== now.getUTCFullYear() + 1) return;
  const last = lastGrow.get(spreadsheetId);
  if (last && Date.now() - last < (isCurrentYear ? GROW_INTERVAL_MS : GROW_INTERVAL_MS * 3)) return;
  lastGrow.set(spreadsheetId, Date.now());

  // Ano atual: mês anterior, atual e seguinte. Ano seguinte: todos os meses.
  const tabs = isCurrentYear
    ? [now.getUTCMonth() - 1, now.getUTCMonth(), now.getUTCMonth() + 1]
        .filter((m) => m >= 0 && m <= 11)
        .map((m) => MONTHS[m])
    : [...MONTHS];
  const res = await sheets.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges: tabs.map((t) => `'${t}'!A2:Z${SCAN_LAST_ROW}`),
    valueRenderOption: "FORMULA",
    dateTimeRenderOption: "FORMATTED_STRING",
  });

  type Plan = { tab: string; offset: number; fillEndCol: number; items: { day: number; end1: number; count: number }[] };
  const plans: Plan[] = [];
  // Conserto: linha EM BRANCO (sem fornecedor) dentro do bloco de um dia com o
  // número de OUTRO dia na coluna Dia. Uma versão anterior desta rotina gravou
  // o número do dia nas linhas erradas. Só mexe em linha vazia, nunca em lançamento.
  const diaFixes: { range: string; day: number }[] = [];
  tabs.forEach((tab, i) => {
    const values = (res.data.valueRanges?.[i]?.values ?? []) as unknown[][];
    const header = values[0] ?? [];
    const body = values.slice(1);
    const offset = findDayColumnOffset(header);
    const totalCol = findHeaderColumn(header, "total do dia");
    const located = locateDayBlocks(body, offset, totalCol);
    const supplierCol = offset + 2;
    const items: Plan["items"] = [];
    for (const [day, block] of located) {
      const size = block.end1 - block.start1 + 1;
      if (size >= MAX_BLOCK_ROWS) continue;
      let free = 0;
      for (let r = block.start1; r <= block.end1; r++) {
        const row = body[r - FIRST_DATA_ROW];
        if (!rowHasData(row, supplierCol)) {
          free++;
          const written = validDay(row?.[offset]);
          if (r > block.start1 && written !== null && written !== day) {
            diaFixes.push({ range: `'${tab}'!${columnLetter(offset)}${r}`, day });
          }
        }
      }
      // Dia sem nenhum lançamento fica como está (só cresce quem está em uso).
      if (free >= SPARE_ROWS || free === size) continue;
      items.push({ day, end1: block.end1, count: SPARE_ROWS - free });
    }
    if (items.length === 0) return;
    const excluir = findExcluirColumn(header);
    const conciliado = findHeaderColumn(header, "conciliado");
    plans.push({
      tab,
      offset,
      fillEndCol: Math.max(20, (excluir ?? 0) + 1, (conciliado ?? 0) + 1),
      items: items.sort((a, b) => b.end1 - a.end1), // de baixo pra cima
    });
  });
  if (diaFixes.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data: diaFixes.map((f) => ({ range: f.range, values: [[f.day]] })),
      },
    });
  }
  if (plans.length === 0) return;

  const missingId = tabs.some((t) => plans.some((p) => p.tab === t) && !sheetIdCache.has(`${spreadsheetId}:${t}`));
  if (missingId) {
    const meta = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: "sheets.properties(sheetId,title)",
    });
    for (const s of meta.data.sheets ?? []) {
      if (s.properties?.title && s.properties.sheetId != null) {
        sheetIdCache.set(`${spreadsheetId}:${s.properties.title}`, s.properties.sheetId);
      }
    }
  }

  for (const plan of plans) {
    const sheetId = sheetIdCache.get(`${spreadsheetId}:${plan.tab}`);
    if (sheetId == null) continue;
    const requests: sheets_v4.Schema$Request[] = [];
    for (const item of plan.items) {
      const start = item.end1 - 1; // índice (base 0) da última linha do bloco: insere antes dela
      requests.push({
        insertDimension: {
          range: { sheetId, dimension: "ROWS", startIndex: start, endIndex: start + item.count },
          inheritFromBefore: true,
        },
      });
      // A linha nova herda o formato da de cima, inclusive a cor pintada à mão
      // (ex: amarelo) — limpa pra ela nascer sem cor.
      requests.push({
        repeatCell: {
          range: {
            sheetId,
            startRowIndex: start,
            endRowIndex: start + item.count,
            startColumnIndex: 0,
            endColumnIndex: plan.fillEndCol,
          },
          cell: { userEnteredFormat: {} },
          fields: "userEnteredFormat.backgroundColor",
        },
      });
      // Número do dia nas linhas novas (como nas demais linhas do bloco). Vai
      // NO MESMO pedido, logo depois da inserção: as inserções seguintes (dias
      // acima) empurram estas linhas junto, então a posição nunca fica errada.
      requests.push({
        repeatCell: {
          range: {
            sheetId,
            startRowIndex: start,
            endRowIndex: start + item.count,
            startColumnIndex: plan.offset,
            endColumnIndex: plan.offset + 1,
          },
          cell: { userEnteredValue: { numberValue: item.day } },
          fields: "userEnteredValue",
        },
      });
    }
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
  }
}

const HEADER_CACHE_MS = 2 * 60 * 1000;
const headerCache = new Map<string, { at: number; byTab: Map<string, unknown[]> }>();

const HEAL_INTERVAL_MS = 30 * 60 * 1000;
const lastHeal = new Map<string, number>();
const healing = new Set<string>();

/**
 * Realinhamento dos blocos (ver healMisalignedBlocks) pra TODAS as planilhas
 * da empresa. Roda DEPOIS da resposta da conferência (ver a rota), pra nunca
 * atrasar uma exclusão marcada na planilha.
 */
export async function healAllSheets(companyId: string): Promise<void> {
  if (healing.has(companyId)) return;
  healing.add(companyId);
  try {
    const company = await prisma.company.findUnique({
      where: { id: companyId },
      include: { sheets: true },
    });
    if (!company?.googleRefreshToken || company.sheets.length === 0) return;
    const { sheets } = getGoogleClientsForCompany(company.googleRefreshToken);
    for (const companySheet of company.sheets) {
      await healMisalignedBlocks(sheets, companyId, companySheet);
    }
  } catch (err) {
    console.error("Falha no realinhamento dos blocos:", err);
  } finally {
    healing.delete(companyId);
  }
}

/**
 * Realinha, no mês atual e no seguinte, lançamentos que ficaram em linhas
 * fora do bloco do dia deles — gravados antes de o app passar a seguir a
 * estrutura da planilha, quando linhas inseridas/apagadas à mão deixavam o
 * lançamento escondido no agrupamento de outro dia. Confere no máximo a cada
 * 30 min por planilha; só regrava o que está fora de lugar (a regravação do
 * dia leva junto os dias vizinhos que se tocam).
 */
async function healMisalignedBlocks(
  sheets: sheets_v4.Sheets,
  companyId: string,
  companySheet: { spreadsheetId: string; year: number }
): Promise<void> {
  const now = new Date();
  if (companySheet.year !== now.getUTCFullYear()) return;
  const last = lastHeal.get(companySheet.spreadsheetId);
  if (last && Date.now() - last < HEAL_INTERVAL_MS) return;
  lastHeal.set(companySheet.spreadsheetId, Date.now());

  for (const monthIndex0 of [now.getUTCMonth(), now.getUTCMonth() + 1]) {
    if (monthIndex0 > 11) continue;
    const tab = MONTHS[monthIndex0];
    try {
      const state = await readDayTabState({ sheets, spreadsheetId: companySheet.spreadsheetId, tabName: tab });
      const supplierCol = state.offset + 2;
      const staleDays = new Set<number>();
      state.body.forEach((row, i) => {
        const day = validDay(row?.[state.offset]);
        if (day === null || !rowHasData(row, supplierCol)) return;
        const block = state.located.get(day);
        const row1 = FIRST_DATA_ROW + i;
        if (block && (row1 < block.start1 || row1 > block.end1)) staleDays.add(day);
      });
      for (const day of staleDays) {
        await rebuildDayBlock(companyId, companySheet.year, tab, day);
      }
    } catch (err) {
      console.error(`Falha ao realinhar os blocos de ${tab}/${companySheet.year}:`, err);
    }
  }
}

/**
 * Procura, nas abas de mês da planilha, linhas com a caixinha EXCLUIR marcada
 * e apaga o lançamento correspondente (planilha + banco), como o botão
 * Excluir do app. A planilha não avisa o app de nada — por isso é o app que
 * confere de tempos em tempos (ver AutoRefresh).
 *
 * Segurança: só vale em aba que tem uma coluna com cabeçalho "EXCLUIR" na
 * linha 2 (em qualquer lugar de A a Z), e o lançamento é achado pelo
 * CONTEÚDO da linha (fornecedor + valor + dia),
 * nunca só pela posição — se a planilha estiver desalinhada com o banco, não
 * acha nada e não apaga nada.
 */
export async function processSheetDeletions(
  companyId: string
): Promise<{ deleted: number; unmatched: number }> {
  const startedAt = running.get(companyId);
  if (startedAt && Date.now() - startedAt < RUNNING_STALE_MS) return { deleted: 0, unmatched: 0 };
  running.set(companyId, Date.now());
  try {
    const company = await prisma.company.findUnique({
      where: { id: companyId },
      include: { sheets: true },
    });
    if (!company?.googleRefreshToken || company.sheets.length === 0) {
      return { deleted: 0, unmatched: 0 };
    }

    const { sheets } = getGoogleClientsForCompany(company.googleRefreshToken);
    let deleted = 0;
    let unmatched = 0;

    for (const companySheet of company.sheets) {
      const spreadsheetId = companySheet.spreadsheetId;

      try {
        await growFullBlocks(sheets, spreadsheetId, companySheet.year);
      } catch (err) {
        console.error(`Falha ao abrir linhas nos dias cheios (planilha ${companySheet.year}):`, err);
      }

      // 1) Cabeçalho (linha 2) das 12 abas — acha onde está a coluna EXCLUIR de
      //    cada uma. Fica guardado em memória por 2 min: a conferência roda a
      //    cada poucos segundos e reler isso toda vez estourava a cota do Google.
      // 2) Só as caixinhas dessa coluna, nas abas que têm ela (1 chamada).
      let headerByTab = new Map<string, unknown[]>();
      const flagged: { tab: string; row1: number }[] = [];
      try {
        const cached = headerCache.get(spreadsheetId);
        const usedCache = !!cached && Date.now() - cached.at < HEADER_CACHE_MS;
        if (usedCache) {
          headerByTab = cached!.byTab;
        } else {
          const headerRes = await sheets.spreadsheets.values.batchGet({
            spreadsheetId,
            ranges: MONTHS.map((m) => `'${m}'!A${HEADER_ROWS}:Z${HEADER_ROWS}`),
            valueRenderOption: "UNFORMATTED_VALUE",
          });
          MONTHS.forEach((tab, i) => {
            headerByTab.set(tab, (headerRes.data.valueRanges?.[i]?.values?.[0] ?? []) as unknown[]);
          });
          headerCache.set(spreadsheetId, { at: Date.now(), byTab: headerByTab });
        }
        const withColumn: { tab: string; index: number }[] = [];
        MONTHS.forEach((tab) => {
          const index = findExcluirColumn(headerByTab.get(tab) ?? []);
          if (index !== null) withColumn.push({ tab, index });
        });
        // Abas sem a coluna (e com a posição padrão livre): o app cria — só
        // quando o cabeçalho acabou de ser lido (não a cada conferência). As
        // recém-criadas só entram na leitura de marcações na próxima rodada.
        const missing = usedCache ? [] : MONTHS.filter((tab) => {
          const header = headerByTab.get(tab) ?? [];
          return (
            findExcluirColumn(header) === null &&
            String(header[DEFAULT_EXCLUIR_COLUMN] ?? "").trim() === ""
          );
        });
        if (missing.length > 0) {
          try {
            await ensureCheckboxColumn(sheets, spreadsheetId, missing, "EXCLUIR", DEFAULT_EXCLUIR_COLUMN);
          } catch (err) {
            console.error(`Falha ao criar a coluna EXCLUIR (planilha ${companySheet.year}):`, err);
          }
        }

        // CONCILIADO (conciliação bancária): caixinha ao lado de CONFERIDO que
        // pinta a linha de verde. Mesmo critério: só cria onde não existe e a
        // posição padrão está livre.
        const missingConciliado = usedCache ? [] : MONTHS.filter((tab) => {
          const header = headerByTab.get(tab) ?? [];
          return (
            findHeaderColumn(header, "conciliado") === null &&
            String(header[DEFAULT_CONCILIADO_COLUMN] ?? "").trim() === ""
          );
        });
        if (missingConciliado.length > 0) {
          try {
            await ensureCheckboxColumn(
              sheets,
              spreadsheetId,
              missingConciliado,
              "CONCILIADO",
              DEFAULT_CONCILIADO_COLUMN,
              { red: 0.78, green: 0.92, blue: 0.78 }
            );
          } catch (err) {
            console.error(`Falha ao criar a coluna CONCILIADO (planilha ${companySheet.year}):`, err);
          }
        }
        if (withColumn.length === 0) continue;

        const flagRes = await sheets.spreadsheets.values.batchGet({
          spreadsheetId,
          ranges: withColumn.map(
            ({ tab, index }) =>
              `'${tab}'!${columnLetter(index)}${HEADER_ROWS + 1}:${columnLetter(index)}${SCAN_LAST_ROW}`
          ),
          majorDimension: "COLUMNS",
          valueRenderOption: "UNFORMATTED_VALUE",
        });
        withColumn.forEach(({ tab }, i) => {
          const column = (flagRes.data.valueRanges?.[i]?.values?.[0] ?? []) as unknown[];
          for (let j = 0; j < column.length; j++) {
            if (column[j] === true) flagged.push({ tab, row1: HEADER_ROWS + 1 + j });
          }
        });
      } catch (err) {
        console.error(`Falha ao ler a coluna EXCLUIR (planilha ${companySheet.year}):`, err);
        continue;
      }
      if (flagged.length === 0) continue;

      // Conteúdo das linhas marcadas.
      const contentRes = await sheets.spreadsheets.values.batchGet({
        spreadsheetId,
        ranges: flagged.map((f) => `'${f.tab}'!A${f.row1}:Z${f.row1}`),
        valueRenderOption: "UNFORMATTED_VALUE",
      });
      const contentRanges = contentRes.data.valueRanges ?? [];

      for (const [i, f] of flagged.entries()) {
        const row = (contentRanges[i]?.values?.[0] ?? []) as unknown[];
        const offset = findDayColumnOffset(headerByTab.get(f.tab));
        const supplierName = String(row[offset + 2] ?? "").trim();
        const amount = cellToNumber(row[offset + 6]);
        // O dia vem da própria linha (coluna Dia), não da posição dela — a
        // planilha pode ter linhas inseridas/apagadas entre os dias.
        const day = validDay(row[offset]);
        if (!supplierName || amount === null) continue; // linha vazia marcada: nada a apagar
        if (day === null) {
          unmatched++;
          continue;
        }

        const monthIndex0 = MONTHS.indexOf(f.tab as (typeof MONTHS)[number]);
        const candidates = await prisma.transaction.findMany({
          where: {
            companyId,
            kind: "PAYABLE",
            dueDate: {
              gte: new Date(Date.UTC(companySheet.year, monthIndex0, day)),
              lt: new Date(Date.UTC(companySheet.year, monthIndex0, day + 1)),
            },
          },
          include: { supplier: true },
        });
        const matches = candidates.filter((t) =>
          rowMatchesTransaction([supplierName, amount], t.supplier.name, Number(t.amount))
        );
        const target =
          matches.find((t) => t.sheetCellRef === `${f.tab}!A${f.row1}`) ?? matches[0];
        if (!target) {
          unmatched++;
          continue;
        }

        try {
          const result = await deleteTransactionEverywhere(target.id);
          if (!result.deleted) continue;
          // Garante que a planilha reflete o banco mesmo se o lançamento não
          // tinha posição guardada ou a limpeza falhou. Último recurso: deixa
          // em branco a própria linha marcada (já conferida acima).
          if (!result.cleared) {
            try {
              await rebuildDayBlock(companyId, companySheet.year, f.tab, day);
            } catch (rebuildErr) {
              console.error(`Não consegui regravar ${f.tab} dia ${day}; limpando só a linha marcada:`, rebuildErr);
              await blankDayRow({ companyId, year: companySheet.year, tabName: f.tab, row1: f.row1, day });
            }
          }
          deleted++;
        } catch (err) {
          console.error(`Falha ao excluir ${supplierName} marcado na planilha:`, err);
        }
      }
    }

    return { deleted, unmatched };
  } finally {
    running.delete(companyId);
  }
}
