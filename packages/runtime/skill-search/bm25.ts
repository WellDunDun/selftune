export interface SearchDocument {
  readonly id: string;
  readonly text: string;
}

const STOP_WORDS = new Set(
  "a an and are as at be by for from in is it of on or that the this to with".split(" "),
);

export function tokenize(text: string): string[] {
  return (
    text
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  ).filter((word) => !STOP_WORDS.has(word));
}

/** Local Okapi BM25 (k1=1.5, b=0.75); document IDs must be unique. */
export class BM25Index {
  private readonly postings = new Map<string, Map<string, number>>();
  private readonly lengths = new Map<string, number>();
  private readonly averageLength: number;

  constructor(documents: readonly SearchDocument[]) {
    let total = 0;
    for (const document of documents) {
      const words = tokenize(document.text);
      this.lengths.set(document.id, words.length);
      total += words.length;
      for (const word of words) {
        const posting = this.postings.get(word) ?? new Map<string, number>();
        posting.set(document.id, (posting.get(document.id) ?? 0) + 1);
        this.postings.set(word, posting);
      }
    }
    this.averageLength = total / Math.max(1, documents.length) || 1;
  }

  search(query: string, limit = 5): { id: string; score: number }[] {
    const scores = new Map<string, number>();
    for (const word of new Set(tokenize(query))) {
      const posting = this.postings.get(word);
      if (!posting) continue;
      const idf = Math.log(1 + (this.lengths.size - posting.size + 0.5) / (posting.size + 0.5));
      for (const [id, frequency] of posting) {
        const length = this.lengths.get(id) ?? 0;
        const denominator = frequency + 1.5 * (0.25 + (0.75 * length) / this.averageLength);
        scores.set(id, (scores.get(id) ?? 0) + (idf * frequency * 2.5) / denominator);
      }
    }
    return [...scores]
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, Math.max(0, Math.min(20, Math.floor(limit))));
  }
}
