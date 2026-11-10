// Deterministic hashing and random draws. The data generator, the simulated stock
// faults and the test goldens all depend on these exact bodies, so they don't change.

/** FNV-1a over UTF-16 code units, as an unsigned 32-bit integer. */
export function fnv1a32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * The MurmurHash3 32-bit finalizer. FNV-1a alone barely changes when only the last
 * character changes, so attempt 1, 2 and 3 of one key would draw nearly the same value.
 */
export function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** A draw in [0, 1) decided only by the string. */
export function faultDraw(s: string): number {
  return fmix32(fnv1a32(s)) / 2 ** 32;
}

/** mulberry32 in its standard reference form: a seeded stream of draws in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
