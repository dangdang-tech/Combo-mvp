// 任务域路由。
//   POST /tasks                 建任务（返回配对码）—— requireAuth
//   GET  /tasks                 任务列表 —— requireAuth
//   GET  /tasks/:taskId         任务详情 —— requireAuth
//   GET  /tasks/:taskId/events  进度 SSE —— requireSseAuth（同源 Cookie）
//   POST /tasks/:taskId/retry   重试失败任务 —— requireAuth
//   POST /tasks/local           创建 local Task —— requireAuth
//   POST /tasks/:taskId/local-execution/claim  设备绑定或同设备恢复 —— bindCode 鉴权
//   POST /tasks/:taskId/local-progress         本地进度 —— Task Token + 设备签名
//   POST /tasks/:taskId/local-result           最终定义 —— Task Token + 设备签名
//   GET  /connect/script        助手脚本下发 —— 无登录（配对码 query 鉴权）
//   POST /connect/prepare       建立/确认 v2 上传快照 —— 无登录（配对码 body 鉴权）
//   POST /connect/upload        助手分片上传 —— 无登录（配对码 body 鉴权）
import type { FastifyInstance } from 'fastify';
import { requireAuth, requireSseAuth } from '../../platform/middleware/auth.js';
import { registerEndpoints, type EndpointDecl } from '../../platform/http/_helpers.js';
import {
  connectScriptHandler,
  connectPrepareHandler,
  connectUploadHandler,
  createTaskHandler,
  getTaskHandler,
  listTasksHandler,
  retryTaskHandler,
} from './handlers.js';
import { taskEventsHandler } from './sse.js';
import {
  claimLocalExecutionHandler,
  createLocalTaskHandler,
  reportLocalProgressHandler,
  requireLocalExecutionAuth,
  submitLocalResultHandler,
} from './local-execution.js';

export const TASK_ENDPOINTS: EndpointDecl[] = [
  { method: 'POST', url: '/tasks', preHandlers: [requireAuth()], handler: createTaskHandler() },
  { method: 'GET', url: '/tasks', preHandlers: [requireAuth()], handler: listTasksHandler() },
  { method: 'GET', url: '/tasks/:taskId', preHandlers: [requireAuth()], handler: getTaskHandler() },
  {
    method: 'GET',
    url: '/tasks/:taskId/events',
    preHandlers: [requireSseAuth()],
    handler: taskEventsHandler(),
  },
  {
    method: 'POST',
    url: '/tasks/:taskId/retry',
    preHandlers: [requireAuth()],
    handler: retryTaskHandler(),
  },
  {
    method: 'POST',
    url: '/tasks/local',
    preHandlers: [requireAuth()],
    handler: createLocalTaskHandler(),
  },
  {
    method: 'POST',
    url: '/tasks/:taskId/local-execution/claim',
    handler: claimLocalExecutionHandler(),
  },
  {
    method: 'POST',
    url: '/tasks/:taskId/local-progress',
    preHandlers: [requireLocalExecutionAuth()],
    handler: reportLocalProgressHandler(),
  },
  {
    method: 'POST',
    url: '/tasks/:taskId/local-result',
    preHandlers: [requireLocalExecutionAuth()],
    handler: submitLocalResultHandler(),
  },
  { method: 'GET', url: '/connect/script', handler: connectScriptHandler() },
  { method: 'POST', url: '/connect/prepare', handler: connectPrepareHandler() },
  { method: 'POST', url: '/connect/upload', handler: connectUploadHandler() },
];

export async function registerTaskRoutes(scoped: FastifyInstance): Promise<void> {
  registerEndpoints(scoped, TASK_ENDPOINTS);
}
