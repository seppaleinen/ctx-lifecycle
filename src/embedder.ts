/**
 * Lazy-loaded ONNX embedding pipeline (only when memory.vector = 'auto').
 * Uses Xenova/all-MiniLM-L6-v2 (384-d q8).
 */
export class Embedder {
  private static instance: Embedder | null = null;
  private pipeline: unknown = null;
  private readonly dim = 384;
  private initialized = false;

  private constructor(private modelId: string = 'Xenova/all-MiniLM-L6-v2') {}

  /**
   * Get singleton instance (lazy init).
   */
  static async getInstance(modelId?: string): Promise<Embedder> {
    if (!Embedder.instance) {
      Embedder.instance = new Embedder(modelId);
    }
    return Embedder.instance;
  }

  /**
   * Initialize pipeline on first call (background load).
   */
  async init(): Promise<void> {
    if (this.initialized || this.pipeline) return;

    try {
      // Lazy-load transformers.js only when needed
      const transformers = await import('@huggingface/transformers');
      const { pipeline } = transformers;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.pipeline = await (pipeline as any)('feature-extraction', this.modelId, {
        device: 'cpu',
        dtype: 'q8'
      });

      this.initialized = true;
    } catch (error) {
      console.warn('Failed to load embedding pipeline:', error);
      this.initialized = true;
    }
  }

  /**
   * Embed a batch of texts. Returns flat [N, 384] Float32Array.
   */
  async embed(texts: string[]): Promise<Float32Array> {
    if (!this.pipeline) {
      await this.init();
    }

    if (!this.pipeline) {
      // Fallback: return zero embeddings
      return new Float32Array(texts.length * this.dim);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (this.pipeline as any).call(texts);

    // Result is [N, 384]
    const flat = new Float32Array(texts.length * this.dim);

    const data = result.data as number[][];
    for (let i = 0; i < texts.length; i++) {
      for (let j = 0; j < this.dim; j++) {
        flat[i * this.dim + j] = data[i][j] ?? 0;
      }
    }

    return flat;
  }

  /**
   * Get embedding dimension (always 384).
   */
  getDimension(): number {
    return this.dim;
  }
}