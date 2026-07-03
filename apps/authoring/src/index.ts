// 默认入口 = api 进程（dev/start 用）。worker/consumer/sweeper 各有独立 processes/*.ts 入口。
import './processes/api.js';
