/**
 * 应用层发布治理的前端服务门面：页面只依赖本模块，底层存储与领域规则分别在
 * data/local-store.ts 与 data/publishing.ts。
 */
export {
  adsStatuses,
  isAdsCallable,
  isAdsRetired,
  listEntries,
  publishAdsService,
  republishAdsService,
  resolverCallService,
  resolverRegistry,
  retireAdsService,
  runAction,
  syncResolverNow as reconcileResolver,
  versionLedger,
  downloadEntries,
  moduleMeta,
} from '@/api/local-service'
