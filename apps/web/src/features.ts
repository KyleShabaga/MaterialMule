/**
 * Menu areas from later increments stay hidden until their cards ship (MM-T34). Flip a flag in
 * the same change that delivers the feature.
 */
export const FEATURES = {
  /**
   * MM-T23/T24: the one "Lab Testing" area (Programs; the Worklist tab arrives with MM-T24).
   * Replaces the separate Lab Testing Worklist and Testing Programs placeholders.
   */
  labTesting: true,
  /** MM-T29 / MM-T30 */
  disposalRetention: false,
} as const;

export type FeatureFlag = keyof typeof FEATURES;
