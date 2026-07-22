// capability 域对外出口。业务域之间只能经本文件互引（后端仓库结构规范）；
// 域内文件（repo/handlers/routes/persist）不从这里自引。跨域消费方是 task 域的 Cloud 流水线和 Local Result API。
export { insertCapability, listCapabilityViews } from './repo.js';
export {
  CAPABILITY_BUCKET,
  capabilityDefinitionKey,
  persistCapabilityDefinitions,
  type PersistCapabilityItem,
} from './persist.js';
