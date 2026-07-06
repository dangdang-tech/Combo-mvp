// capability 域对外出口。业务域之间只能经本文件互引（后端仓库结构规范）；
// 域内文件（repo/handlers/routes）不从这里自引。当前跨域消费方：task 域流水线落库能力项。
export { insertCapability } from './repo.js';
