/**
 * Normaliza texto pra comparação "aproximada": remove acento, deixa
 * minúsculo, troca qualquer pontuação/espaço por um espaço só. Usado tanto
 * pra casar fornecedor quanto categoria — evita duplicata por diferença de
 * hífen, espaço extra, ou maiúscula/minúscula (ex: "matéria-prima - tecidos"
 * e "matéria prima - tecidos" viram o mesmo texto normalizado).
 */
export function normalizeText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // remove acentos
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
