// The six seeded coding questions: 2 EASY, 3 MEDIUM, 1 HARD (database prompt, Step 4).
import type { CodingQuestionSpec } from '../types';
import { maintenanceWindows } from './maintenance-windows';
import { parcelSurcharge } from './parcel-surcharge';
import { sensorBursts } from './sensor-bursts';
import { steadyStretch } from './steady-stretch';
import { stockRebalance } from './stock-rebalance';
import { tollVouchers } from './toll-vouchers';

export const codingQuestions: readonly CodingQuestionSpec[] = [
  parcelSurcharge,
  sensorBursts,
  steadyStretch,
  stockRebalance,
  maintenanceWindows,
  tollVouchers,
];
