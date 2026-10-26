/**
 * Menu areas from later increments stay hidden until their cards ship (TRP-T34). Flip a flag in
 * the same change that delivers the feature.
 */
export const FEATURES = {
  /** TRP-T24 */
  labTestingWorklist: false,
  /** TRP-T23 */
  testingPrograms: false,
  /** TRP-T29 / TRP-T30 */
  disposalRetention: false,
} as const;

export type FeatureFlag = keyof typeof FEATURES;
