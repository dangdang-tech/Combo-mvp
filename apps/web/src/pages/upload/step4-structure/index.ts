// STEP④ 结构化模块出口（F-13，§5.4）。
export { StructureStepPage } from './StructureStepPage.js';
export { AppIdentityPanel, type AppIdentityPanelProps } from './AppIdentityPanel.js';
export { SoftFieldCard, type SoftFieldCardProps } from './SoftFieldCard.js';
export { HardFieldCard, type HardFieldCardProps } from './HardFieldCard.js';
export {
  buildSoftFields,
  buildHardFields,
  softProgressText,
  allSoftReady,
  isGenerating,
  isDone,
  SOFT_FIELD_LABEL,
  HARD_FIELD_LABEL,
  ARRAY_SOFT_FIELDS,
  type SoftFieldView,
  type HardFieldView,
} from './manifestFields.js';
export {
  createCapability,
  fetchManifest,
  startStructure,
  patchManifest,
  regenerateField,
  manifestPath,
  startStructurePath,
  regenerateFieldPath,
} from './structureApi.js';
