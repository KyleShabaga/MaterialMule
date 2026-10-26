/**
 * Menu areas from later increments stay hidden until their cards ship (MM-T34). Flip a flag in
 * the same change that delivers the feature.
 */
export const FEATURES = {
  /** MM-T24 */
  labTestingWorklist: false,
  /** MM-T23 */
  testingPrograms: false,
  /** MM-T29 / MM-T30 */
  disposalRetention: false,
} as const;

export type FeatureFlag = keyof typeof FEATURES;
