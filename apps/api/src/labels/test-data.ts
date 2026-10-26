import type { StickerInput } from './template-v1.js';

/** Fictional sticker data for label tests. */
export const STANDARD_UNIT: StickerInput = {
  storageUnitId: 'BKT-2026-000014',
  projectNumber: 'DEMO-2601',
  projectName: 'Demo Subdivision Phase 2',
  receivedDate: '2026-10-26',
  testHoles: ['TH26-01', 'TH26-02'],
};

/** One issued ID per prefix (AC7). */
export const ID_PER_PREFIX = [
  'BKT-2026-000014',
  'ST-2026-000003',
  'CRE-2026-000001',
  'CT-2026-000120',
] as const;

/** Worst case for fit: 120-character project name and six long field-location names. */
export const WORST_CASE_UNIT: StickerInput = {
  ...STANDARD_UNIT,
  projectName:
    'Demonstration Regional Wastewater Treatment Plant Expansion Geotechnical Investigation ' +
    'and Slope Stability Reviews Ph 03',
  testHoles: [
    'BH26-01 North Abutment',
    'BH26-02 South Abutment',
    'BH26-03 Pier 1',
    'BH26-04 Pier 2',
    'TP26-05 Borrow Area East',
    'TP26-06 Borrow Area West',
  ],
};
