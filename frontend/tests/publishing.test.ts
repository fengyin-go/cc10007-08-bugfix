/**
 * 应用层发布治理领域逻辑测试：node --experimental-strip-types 直接运行。
 * 覆盖：一次性 revoke_token、token_seq 定稿、重放幂等、目录/resolver 校验、
 * archive_contract 与 callable 分栏、resolver 对账与旧契约保留。
 */
import assert from 'node:assert/strict'
import {
  bumpVersion,
  contractFromRow,
  isCallable,
  isRetired,
  lookupCatalog,
  normalizeAdsRow,
  publishAds,
  republishAds,
  resolveCall,
  retireAds,
  syncResolverRegistry,
  type AdsRow,
} from '../src/data/publishing.ts'

let passed = 0
function test(name: string, fn: () => void): void {
  fn()
  passed += 1
  console.info(`✓ ${name}`)
}

function makeRows(): AdsRow[] {
  return [
    normalizeAdsRow({
      id: 1,
      status: '已发布',
      pending: false,
      abnormal: false,
      数据集编号: 'ADS-0001',
      版本号: 'v3',
      callable: true,
      token_seq: 3,
    }),
    normalizeAdsRow({
      id: 2,
      status: '待发布',
      pending: true,
      abnormal: false,
      数据集编号: 'ADS-0002',
      版本号: 'v1',
    }),
    normalizeAdsRow({
      id: 3,
      status: '已下线',
      pending: false,
      abnormal: true,
      数据集编号: 'ADS-0003',
      版本号: 'v2',
      revoke_token: 'RVK-2-abcdefghij',
      token_seq: 2,
      token_consumed: false,
      archive_contract: true,
    }),
  ]
}

const fixedNow = '2026-11-14T08:00:00.000Z'
const deterministicRandom = (): number => 0.123456789

test('归一化强制不变量：退役必归档且不可调用', () => {
  const broken = normalizeAdsRow({
    id: 9,
    status: '已下线',
    pending: true,
    abnormal: false,
    数据集编号: 'ADS-X',
    callable: true,
    archive_contract: false,
  })
  assert.equal(broken.archive_contract, true)
  assert.equal(broken.callable, false)
  assert.equal(broken.pending, false)
  assert.equal(isRetired(broken), true)
  assert.equal(isCallable(broken), false)
})

test('退役一次性签发 revoke_token，token_seq 单调递增', () => {
  const rows = makeRows()
  const outcome = retireAds(rows, 1, { now: fixedNow, random: deterministicRandom })
  assert.equal(outcome.ok, true)
  assert.match(outcome.token ?? '', /^RVK-4-/)
  assert.equal(outcome.tokenSeq, 4)
  const updated = outcome.row!
  assert.equal(updated.status, '已下线')
  assert.equal(updated.archive_contract, true)
  assert.equal(updated.callable, false)
})

test('已退役重复退役不重新签发、不产生副作用', () => {
  const rows = makeRows()
  const again = retireAds(rows, 3)
  assert.equal(again.ok, false)
  assert.equal(again.token, undefined)
  assert.equal(rows[2].revoke_token, 'RVK-2-abcdefghij')
})

test('只有已发布数据集允许退役', () => {
  const rows = makeRows()
  const blocked = retireAds(rows, 2)
  assert.equal(blocked.ok, false)
  assert.match(blocked.message, /只有/)
})

test('重新发布缺少 token 被拒绝', () => {
  const rows = makeRows()
  const blocked = republishAds(rows, 3, '')
  assert.equal(blocked.ok, false)
  assert.match(blocked.message, /必须携带/)
})

test('重新发布 token 不匹配（过期/伪造）被拒绝', () => {
  const rows = makeRows()
  const blocked = republishAds(rows, 3, 'RVK-9-wrongtoken')
  assert.equal(blocked.ok, false)
  assert.match(blocked.message, /校验失败/)
})

test('正确 token 重新发布：版本定稿递增，归档保留但 callable 单独打开', () => {
  const rows = makeRows()
  const outcome = republishAds(rows, 3, 'RVK-2-abcdefghij', { now: fixedNow })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.row!.版本号, 'v3')
  assert.equal(outcome.row!.status, '已发布')
  assert.equal(outcome.row!.archive_contract, true)
  assert.equal(outcome.row!.callable, true)
  assert.equal(outcome.row!.token_consumed, true)
})

test('同 token 重放：识别为重复请求，不新增副作用', () => {
  const rows = makeRows()
  const first = republishAds(rows, 3, 'RVK-2-abcdefghij', { now: fixedNow })
  const applied = rows.map((row) => (row.id === 3 ? first.row! : row))
  // 客户端用同一个已消费令牌重试：行已是「已发布」，必须识别为重放而非报错或二次发布。
  const replay = republishAds(applied, 3, 'RVK-2-abcdefghij', { now: fixedNow })
  assert.equal(replay.ok, true)
  assert.equal(replay.replay, true)
  assert.equal(replay.row!.版本号, 'v3')
  assert.equal(replay.row!.status, '已发布')
})

test('已重新发布后使用伪造 token 被拒绝，不会误放行', () => {
  const rows = makeRows()
  const first = republishAds(rows, 3, 'RVK-2-abcdefghij', { now: fixedNow })
  const applied = rows.map((row) => (row.id === 3 ? first.row! : row))
  const blocked = republishAds(applied, 3, 'RVK-2-forged0000')
  assert.equal(blocked.ok, false)
})

test('目录索引：退役标识无 token 命中也不交付（410），两栏分置', () => {
  const rows = makeRows()
  const hit = lookupCatalog(rows, 'ADS-0003')
  assert.equal(hit.hit, true)
  assert.equal(hit.http, 410)
  assert.equal(hit.deliverable, false)
  assert.equal(hit.archiveContract, true)
  assert.equal(hit.callable, false)
  assert.match(hit.message, /缺少 revoke_token/)
})

test('目录索引：有效 token 仅开放历史解释，仍不可交付', () => {
  const rows = makeRows()
  const hit = lookupCatalog(rows, 'ADS-0003', 'RVK-2-abcdefghij')
  assert.equal(hit.http, 410)
  assert.equal(hit.deliverable, false)
  assert.match(hit.message, /存档不等于交付/)
})

test('目录索引：可调用标识返回 200，未命中返回 404', () => {
  const rows = makeRows()
  const ok = lookupCatalog(rows, 'ADS-0001')
  assert.equal(ok.http, 200)
  assert.equal(ok.deliverable, true)
  const missing = lookupCatalog(rows, 'ADS-404')
  assert.equal(missing.http, 404)
  assert.equal(missing.hit, false)
})

test('resolver：退役标识无 token 不再判 200，返回 410', () => {
  const rows = makeRows()
  const registry = [contractFromRow(rows[2], fixedNow)]
  const blocked = resolveCall(rows, registry, 'ADS-0003')
  assert.equal(blocked.http, 410)
  assert.equal(blocked.ok, false)
  assert.equal(blocked.contract!.callable, false)
})

test('resolver：有效 token 也只返回 410 归档解释；可调用标识才放行 200', () => {
  const rows = makeRows()
  const archived = resolveCall(rows, [], 'ADS-0003', 'RVK-2-abcdefghij')
  assert.equal(archived.http, 410)
  assert.equal(archived.contract!.archiveContract, true)
  const allowed = resolveCall(rows, [], 'ADS-0001')
  assert.equal(allowed.http, 200)
  assert.equal(allowed.ok, true)
})

test('resolver 对账：以持久索引为准同步两处标志，旧契约保留', () => {
  const rows = makeRows()
  const staleRegistry = [
    {
      identifier: 'ADS-0003',
      status: '已发布',
      archiveContract: false,
      callable: true,
      tokenSeq: 1,
      version: 'v1',
      updatedAt: '2026-10-01T00:00:00.000Z',
    },
    {
      identifier: 'ADS-LEGACY',
      status: '已下线',
      archiveContract: true,
      callable: false,
      tokenSeq: 9,
      version: 'v9',
      updatedAt: '2026-09-01T00:00:00.000Z',
    },
  ]
  const result = syncResolverRegistry(staleRegistry, rows, { now: fixedNow })
  const synced = result.registry.find((item) => item.identifier === 'ADS-0003')!
  assert.equal(synced.status, '已下线')
  assert.equal(synced.archiveContract, true)
  assert.equal(synced.callable, false)
  assert.equal(synced.tokenSeq, 2)
  const legacy = result.registry.find((item) => item.identifier === 'ADS-LEGACY')
  assert.ok(legacy, '主索引消失的旧契约必须保留')
})

test('版本号递增规则', () => {
  assert.equal(bumpVersion('v3'), 'v4')
  assert.equal(bumpVersion('2'), 'v3')
  assert.equal(bumpVersion('hotfix-x'), 'hotfix-x.1')
})

test('普通发布上线：待发布转已发布并打开调用标志', () => {
  const rows = makeRows()
  const outcome = publishAds(rows, 2, { now: fixedNow })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.row!.status, '已发布')
  assert.equal(outcome.row!.callable, true)
  assert.equal(outcome.row!.archive_contract, false)
})

console.info(`\n全部 ${passed} 项领域测试通过`)
