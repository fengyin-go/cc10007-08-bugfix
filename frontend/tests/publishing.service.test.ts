/**
 * 服务层集成测试：用 localStorage 垫片模拟浏览器持久化，
 * 验证「下架后从持久索引重读，归档契约与调用标志两处一致，旧契约同步至 resolver」。
 */
import assert from 'node:assert/strict'

class MemoryStorage {
  private map = new Map<string, string>()
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
}

// 必须在导入服务模块之前安装浏览器垫片。
globalThis.window = { localStorage: new MemoryStorage() } as unknown as Window & typeof globalThis
globalThis.localStorage = (globalThis.window as unknown as { localStorage: Storage }).localStorage
globalThis.document = {
  createElement: () => ({ click() {}, href: '', download: '' }),
  body: { appendChild() {}, removeChild() {} },
} as unknown as Document
globalThis.Blob = class {} as unknown as typeof Blob
globalThis.URL = { createObjectURL: () => 'blob:mock', revokeObjectURL: () => {} } as unknown as typeof URL

const {
  listEntries,
  retireAdsService,
  republishAdsService,
  catalogLookupService,
  resolverCallService,
  syncResolverNow,
  resolverRegistry,
  versionLedger,
} = await import('../src/api/local-service.ts')

let passed = 0
function test(name: string, fn: () => void): void {
  fn()
  passed += 1
  console.info(`✓ ${name}`)
}

test('启动即对账：退役种子 ADS-0001 的 resolver 契约与持久索引一致', () => {
  const sync = syncResolverNow()
  const registry = resolverRegistry()
  const contract = registry.find((item) => item.identifier === 'ADS-0001')!
  assert.equal(contract.status, '已下线')
  assert.equal(contract.archiveContract, true)
  assert.equal(contract.callable, false)
  assert.equal(contract.tokenSeq, 3)
  assert.ok(sync.updated.includes('ADS-0001'))
})

test('目录命中退役标识且无 token：410，不可交付', () => {
  const hit = catalogLookupService('ADS-0001')
  assert.equal(hit.http, 410)
  assert.equal(hit.deliverable, false)
  assert.equal(hit.archiveContract, true)
  assert.equal(hit.callable, false)
})

test('旧 resolver 200 问题已修复：退役标识调用一律 410', () => {
  const noToken = resolverCallService('ADS-0001')
  assert.equal(noToken.http, 410)
  const badToken = resolverCallService('ADS-0001', 'RVK-3-wrong')
  assert.equal(badToken.http, 410)
  const goodToken = resolverCallService('ADS-0001', 'RVK-3-SEED0001')
  assert.equal(goodToken.http, 410)
  assert.equal(goodToken.contract!.archiveContract, true)
  assert.equal(goodToken.contract!.callable, false)
})

test('完整退役流程：一次性 token 落盘、列表分栏、resolver 同步', () => {
  // ADS-0004 是已发布数据集。
  const before = listEntries('ads').items.find((row) => row.数据集编号 === 'ADS-0004')!
  assert.equal(before.callable, true)
  const result = retireAdsService(Number(before.id))
  assert.equal(result.ok, true)
  assert.match(result.token ?? '', /^RVK-1-/)
  assert.equal(result.tokenSeq, 1)

  const after = listEntries('ads').items.find((row) => row.数据集编号 === 'ADS-0004')!
  assert.equal(after.status, '已下线')
  assert.equal(after.archive_contract, true)
  assert.equal(after.callable, false)
  assert.equal(after.resolver_synced, true)

  const contract = resolverRegistry().find((item) => item.identifier === 'ADS-0004')!
  assert.equal(contract.callable, false)
  assert.equal(contract.archiveContract, true)
  assert.equal(contract.tokenSeq, 1)

  const ledger = versionLedger('ADS-0004')
  assert.equal(ledger.length, 1)
  assert.equal(ledger[0].action, 'retire')
})

test('用一次性 token 重新发布：版本递增、归档保留、callable 重新打开', () => {
  const target = listEntries('ads').items.find((row) => row.数据集编号 === 'ADS-0004')!
  const token = String(target.revoke_token)
  const result = republishAdsService(Number(target.id), token)
  assert.equal(result.ok, true)
  const republished = listEntries('ads').items.find((row) => row.数据集编号 === 'ADS-0004')!
  assert.equal(republished.status, '已发布')
  assert.equal(republished.callable, true)
  assert.equal(republished.archive_contract, true)
  assert.equal(republished.版本号, 'v2')

  // resolver 同步后放行 200。
  const allowed = resolverCallService('ADS-0004')
  assert.equal(allowed.http, 200)
  assert.equal(allowed.contract!.callable, true)
})

test('同 token 重放不新增副作用，台账不追加', () => {
  const target = listEntries('ads').items.find((row) => row.数据集编号 === 'ADS-0004')!
  const ledgerBefore = versionLedger('ADS-0004').length
  const replay = republishAdsService(Number(target.id), 'RVK-1-' + String(target.revoke_token).split('-')[2])
  assert.equal(replay.ok, true)
  assert.equal(replay.replay, true)
  assert.equal(versionLedger('ADS-0004').length, ledgerBefore)
})

test('列表入口不再把退役对象显示成有效：callable 统计与分栏正确', () => {
  const payload = listEntries('ads')
  const retired = payload.items.filter((row) => row.status === '已下线')
  assert.ok(retired.length >= 1)
  for (const row of retired) {
    assert.equal(row.callable, false)
    assert.equal(row.archive_contract, true)
  }
})

test('resolver 旧契约保留：主索引没有的标识不被对账删除', () => {
  // 手工注入一条主索引不存在的历史契约，再对账。
  const storage = globalThis.localStorage
  const key = 'data-layer-studio:resolver-contracts'
  const registry = JSON.parse(storage.getItem(key) ?? '[]')
  registry.push({
    identifier: 'ADS-LEGACY',
    status: '已下线',
    archiveContract: true,
    callable: false,
    tokenSeq: 9,
    version: 'v9',
    updatedAt: '2026-09-01T00:00:00.000Z',
  })
  storage.setItem(key, JSON.stringify(registry))
  syncResolverNow()
  const stillThere = resolverRegistry().find((item) => item.identifier === 'ADS-LEGACY')
  assert.ok(stillThere, '旧契约必须保留')
})

console.info(`\n全部 ${passed} 项服务层集成测试通过`)
