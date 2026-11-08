/** Amounts in words for offer letters, e.g. "Twenty Million Naira Only", "... Naira and Fifty Kobo Only". */
const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
const SCALES = ["", "Thousand", "Million", "Billion", "Trillion"];

function below1000(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  const parts: string[] = [];
  if (h) parts.push(`${ONES[h]} Hundred`);
  if (r) {
    const t = r < 20 ? ONES[r] : TENS[Math.floor(r / 10)] + (r % 10 ? `-${ONES[r % 10]}` : "");
    parts.push(h ? `and ${t}` : t);
  }
  return parts.join(" ");
}

export function integerToWords(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("integerToWords: non-negative safe integer required");
  if (n === 0) return "Zero";
  const groups: { text: string; value: number; scale: number }[] = [];
  let i = 0;
  while (n > 0) {
    const g = n % 1000;
    if (g) groups.unshift({ text: `${below1000(g)}${SCALES[i] ? ` ${SCALES[i]}` : ""}`, value: g, scale: i });
    n = Math.floor(n / 1000);
    i++;
  }
  // British style: "Two Million and Fifty", "Four Million, Nine Hundred and Fifty Thousand".
  return groups
    .map((g, idx) => {
      if (idx === 0) return g.text;
      const last = idx === groups.length - 1;
      return (last && g.scale === 0 && g.value < 100 ? " and " : ", ") + g.text;
    })
    .join("");
}

export function nairaInWords(kobo: number): string {
  const naira = Math.floor(kobo / 100);
  const k = kobo % 100;
  return `${integerToWords(naira)} Naira${k ? ` and ${integerToWords(k)} Kobo` : ""} Only`;
}
