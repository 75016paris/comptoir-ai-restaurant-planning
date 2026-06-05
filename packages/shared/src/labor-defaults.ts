export type LaborCountryCode = "FR";
export type LaborSectorCode = "hcr";

export type LaborDefaults = {
  countryCode: LaborCountryCode;
  sectorCode: LaborSectorCode;
  defaultContractType: "CDI";
  defaultContractHours: number;
  overtimeThresholdHours: number;
  maxWeeklyHours: number;
};

export const FR_HCR_LABOR_DEFAULTS: LaborDefaults = {
  countryCode: "FR",
  sectorCode: "hcr",
  defaultContractType: "CDI",
  defaultContractHours: 39,
  overtimeThresholdHours: 39,
  maxWeeklyHours: 48,
};

export const DEFAULT_LABOR_COUNTRY: LaborCountryCode = "FR";
export const DEFAULT_LABOR_SECTOR: LaborSectorCode = "hcr";
export const DEFAULT_LABOR_DEFAULTS = FR_HCR_LABOR_DEFAULTS;
export const DEFAULT_CONTRACT_TYPE = DEFAULT_LABOR_DEFAULTS.defaultContractType;
export const DEFAULT_CONTRACT_HOURS = DEFAULT_LABOR_DEFAULTS.defaultContractHours;
