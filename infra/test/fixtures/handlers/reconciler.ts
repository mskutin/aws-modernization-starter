/**
 * Test fixture standing in for functions/reconciler/src/handler.ts. It only
 * exists so infra tests and offline synth can bundle a real entry point.
 */
export async function handler(): Promise<{ staleCandidates: number }> {
  return { staleCandidates: 0 };
}
