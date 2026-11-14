# 数据分层建模工作台

离线版数仓分层建模工具，覆盖贴源层、明细层、汇总层、应用层的表结构设计、分区策略配置、质量规则编排与血缘关系管理，数据持久化到浏览器本地存储。

这是一个**纯前端**管理平台：Vue 3 + Vite + TypeScript，仓库里没有后端服务。业务数据由
`frontend/src/data/` 下的本地数据层提供：首次打开用示例数据播种，之后的登记、筛选与状态流转
结果都持久化在浏览器 `localStorage` 里，刷新或重开浏览器都还在。dev server 已关掉自动打开页面，
启动后按终端打印的地址手工打开。

## 目录结构

```text
.
├── frontend/                 Vue 3 + Vite + TypeScript 前端（唯一运行单元）
│   ├── src/views/            每个业务模块一个页面
│   ├── src/api/local-service.ts   本地数据服务：列表、筛选、动作流转、导出
│   ├── src/data/             模块元数据 / 示例数据 / localStorage 持久化
│   ├── src/stores/           会话与筛选状态
│   └── vite.config.ts        dev server 配置（open: false，无 /api 代理）
├── .gitignore
└── docker-compose.yml
```

## 启动

```bash
cd frontend
npm install
npm run dev
```

前端默认监听 `http://127.0.0.1:5173/`，dev server 不会自动打开浏览器，需要自己访问。

生产构建：

```bash
cd frontend
npm run build
```

## 业务模块

| 模块 | 目录 | 业务对象 | 主要字段 |
| --- | --- | --- | --- |
| 贴源层建模 | `ods` | 贴源表 | 表编号、源表名称、目标表名 |
| 明细层建模 | `dwd` | 明细表 | 表编号、业务域、明细表名 |
| 汇总层建模 | `dws` | 汇总表 | 表编号、汇总主题、聚合维度 |
| 应用层发布 | `ads` | 应用数据集 | 数据集编号、业务应用、输出表名 |
| 数据源管理 | `source` | 数据源连接 | 连接编号、连接类型、接入地址 |
| 分区策略 | `partition` | 分区方案 | 方案编号、目标表名、分区字段 |
| 清洗加工 | `cleanse` | 清洗规则 | 规则编号、输入表名、目标表名 |
| 转换编排 | `transform` | 转换节点 | 节点编号、输入表名、输出表名 |
| 质量校验 | `quality` | 质量规则 | 规则编号、校验表名、目标字段 |
| 血缘追踪 | `lineage` | 血缘关系 | 关系编号、上游表名、下游表名 |
| 历史补数 | `backfill` | 补数任务 | 任务编号、目标表名、开始日期 |
| 元数据管理 | `schema` | 字段定义 | 字段编号、所属表名、字段名称 |
| 数据同步 | `datasync` | 同步链路 | 链路编号、源端连接、目标端连接 |
| 快照管理 | `snapshot` | 快照策略 | 策略编号、目标表名、快照周期 |
| 存储治理 | `govern` | 治理策略 | 策略编号、目标表名、治理类型 |
| 任务监控 | `monitor` | 监控配置 | 配置编号、关联任务、监控指标 |
| 变更审计 | `audit` | 审计记录 | 记录编号、操作表名、变更类型 |
| 编目检索 | `catalog` | 编目条目 | 条目编号、数据集名称、所属分层 |

## 约定

- 每个模块的页面在 `frontend/src/views/<模块>/index.vue`，页面只负责渲染，读写统一走
  `frontend/src/api/local-service.ts`。
- 字段、状态、动作与流转目标集中在 `frontend/src/data/modules.ts`；示例数据在
  `frontend/src/data/seed.ts`。
- 状态流转只允许在 `local-service.ts` 里改，页面组件不做业务判断。
- 想回到初始数据：清掉浏览器里 `data-layer-studio:entries` 这一项，或调用 `resetModule(模块)`。

## 应用层发布治理（退役 / 令牌 / 目录 / resolver）

应用层发布（`ads`）不走通用状态机，专属规则集中在 `frontend/src/data/publishing.ts`
（纯领域逻辑，不依赖浏览器），服务封装在 `frontend/src/api/local-service.ts`：

- **一次性 revoke_token**：`服务下线` 只允许对「已发布」数据集执行，退役时按单调递增的
  `token_seq` 一次性签发 `RVK-<seq>-<随机串>`；重复退役不重新签发。
- **重新发布强制带 token**：退役数据集必须携带当前 `token_seq` 对应的令牌才能定稿新版本；
  令牌缺失/不匹配一律拒绝，同一已消费令牌重放识别为重复请求，不新增副作用、不追加版本台账。
- **归档契约 ≠ 可调用**：`archive_contract` 与 `callable` 是两个独立分栏。退役时
  `archive_contract=true` 仅开放历史解释，`callable` 恒为 `false`；重新发布保留归档契约，
  单独重新打开调用标志。归一化逻辑强制该不变量，存档不会被当成交付。
- **目录索引（catalog_index）**：`catalogLookupService` 命中退役标识时校验 token，无 token /
  错误 token / 有效 token 都返回 HTTP 410，仅有效 token 可看归档解释；只有 `callable=true`
  的标识才返回 200。编目页与应用层发布页都把两个标志分栏呈现。
- **resolver 对账**：resolver 契约表独立持久化（`data-layer-studio:resolver-contracts`），
  `syncResolverNow` 从应用层发布的持久索引重读，逐标识同步状态/归档/调用标志/版本；主索引里
  消失的旧契约保留不删。应用启动与每次退役、重新发布后自动对账。
- **版本台账**：发布/退役/重新发布事件写入 `data-layer-studio:version-ledger`，详情面板按
  应用数据集（主对象）回看发布版本。

### 测试

```bash
cd frontend
npm test          # 17 项纯领域测试 + 8 项服务层集成测试（localStorage 垫片）
npm run typecheck # vue-tsc 类型检查
npm run build     # 生产构建
```

领域测试位于 `frontend/tests/publishing.test.ts`，服务层集成测试位于
`frontend/tests/publishing.service.test.ts`（通过 `tests/alias-loader.mjs` 映射 `@/` 别名）。

领域：数据工程
子方向：数仓与数据湖
