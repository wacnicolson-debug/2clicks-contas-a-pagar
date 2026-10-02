// Confere o dígito verificador de CNPJ/CPF. A IA às vezes monta um "CNPJ"
// juntando números vizinhos (ex: "18.085-852/1141664400") — gravado no
// cadastro, ele passa a casar notas de outro fornecedor por engano.

function checkDigits(digits: string, weights: number[]): number {
  const sum = weights.reduce((acc, w, i) => acc + Number(digits[i]) * w, 0);
  const rest = sum % 11;
  return rest < 2 ? 0 : 11 - rest;
}

export function isValidTaxId(taxId: string | null | undefined): boolean {
  const digits = (taxId ?? "").replace(/\D/g, "");
  if (/^(\d)\1+$/.test(digits)) return false;

  if (digits.length === 14) {
    const w1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const w2 = [6, ...w1];
    return (
      checkDigits(digits, w1) === Number(digits[12]) &&
      checkDigits(digits, w2) === Number(digits[13])
    );
  }

  if (digits.length === 11) {
    const w1 = [10, 9, 8, 7, 6, 5, 4, 3, 2];
    const w2 = [11, ...w1];
    return (
      checkDigits(digits, w1) === Number(digits[9]) &&
      checkDigits(digits, w2) === Number(digits[10])
    );
  }

  return false;
}
