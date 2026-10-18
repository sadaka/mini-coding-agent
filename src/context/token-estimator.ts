export interface TokenEstimator {
  estimate(text: string): number;
}

// ponytail: chars/4 approximation; swap for provider tokenizer if accuracy matters
export class SimpleTokenEstimator implements TokenEstimator {
  estimate(text: string): number {
    return Math.ceil(text.length / 4);
  }
}

export const defaultTokenEstimator: TokenEstimator = new SimpleTokenEstimator();
