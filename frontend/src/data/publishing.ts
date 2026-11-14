/**
 * 应用层发布治理：纯领域逻辑，不依赖 Vue / localStorage，存储由上层注入。
 *
 * 关键约束：
 * 1. 退役（retire）一次性签发 revoke_token，token_seq 单调递增；同 token 重放不新增副作用。
 * 2. archive_contract=true 只代表可做历史解释，永远不等于 callable；退役标识禁止再被当成交付。
 * 3. 目录索引（catalog_index）与解析器（resolver）命中退役标识时都必须校验 token，且不再返回 200。
 * 4. resolver 契约从应用层发布的持久索引重读对账，归档契约与调用标志两处保持一致，旧契约保留。
 */

export type AdsRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type VersionEvent = {
  at: string
  action: 'publish' | 'retire' | 'republish'
  version: string
  tokenSeq: number
}

export type ResolverContract = {
  identifier: string
  status: string
  archiveContract: boolean
  callable: boolean
  tokenSeq: number
  version: string
  updatedAt: string
}

export type PublishingOutcome = {
  ok: boolean
  message: string
  row?: AdsRow
  token?: string
  tokenSeq?: number
  replay?: boolean
  events?: VersionEvent[]
}

export type CatalogHit = {
  hit: boolean
  identifier: string
  status: string
  archiveContract: boolean
  callable: boolean
  deliverable: boolean
  version: string
  tokenSeq: number
  http: number
  message: string
}

export type ResolverResponse = {
  http: number
  ok: boolean
  replay?: boolean
  message: string
  contract: ResolverContract | null
}

export const ADS_STATUS = {
  DRAFT: '草稿',
  PENDING: '待发布',
  PUBLISHED: '已发布',
  RETIRED: '已下线',
} as const

type Ctx = { now?: string; random?: () => number }

function resolveCtx(ctx?: Ctx): { now: string; random: () => number } {
  return {
    now: ctx?.now ?? new Date().toISOString(),
    random: ctx?.random ?? Math.random,
  }
}

function makeToken(seq: number, random: () => number): string {
  const suffix = Math.floor(random() * 0x7fffffffffffffff)
    .toString(36)
    .padStart(10, '0')
    .slice(-10)
  return `RVK-${seq}-${suffix}`
}

/** 发布版本号递增：v1 -> v2；无法解析时退化为追加小版本。 */
export function bumpVersion(current: string): string {
  const matched = /^v?(\d+)$/i.exec(current.trim())
  if (matched) {
    return `v${Number(matched[1]) + 1}`
  }
  return `${current || 'v'}.1`
}

export function isRetired(row: AdsRow): boolean {
  return row.status === ADS_STATUS.RETIRED
}

export function isCallable(row: AdsRow): boolean {
  return row.status === ADS_STATUS.PUBLISHED && row.callable === true
}

/**
 * 归一化应用数据集行：补齐治理字段，并强制维护不变量——
 * 已下线必然 archive_contract=true 且 callable=false；非已发布不可能 callable。
 */
export function normalizeAdsRow(row: AdsRow): AdsRow {
  const normalized: AdsRow = { ...row }
  if (normalized.archive_contract === undefined) normalized.archive_contract = false
  if (normalized.token_seq === undefined) normalized.token_seq = 0
  if (normalized.revoke_token === undefined) normalized.revoke_token = ''
  if (normalized.token_consumed === undefined) normalized.token_consumed = false
  if (normalized.resolver_synced === undefined) normalized.resolver_synced = false
  if (normalized.版本号 === undefined || normalized.版本号 === '') normalized.版本号 = 'v1'

  if (isRetired(normalized)) {
    normalized.archive_contract = true
    normalized.callable = false
    normalized.pending = false
  } else if (isCallable(normalized)) {
    normalized.callable = true
  } else {
    normalized.callable = false
  }
  return normalized
}

/** 退役：只有已发布数据集可下线，一次性签发 revoke_token，token_seq 决定唯一定稿。 */
export function retireAds(rows: AdsRow[], id: number, ctx?: Ctx): PublishingOutcome {
  const { now, random } = resolveCtx(ctx)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的应用数据集` }
  }
  const current = normalizeAdsRow(rows[index])
  if (isRetired(current)) {
    // 幂等：退役态重复请求不重新签发，一次性令牌保持原值，不产生副作用。
    return {
      ok: false,
      message: `应用数据集已退役，一次性 revoke_token 仍为「${current.revoke_token}」，不重复签发`,
    }
  }
  if (current.status !== ADS_STATUS.PUBLISHED) {
    return { ok: false, message: `只有「${ADS_STATUS.PUBLISHED}」状态的应用数据集才能服务下线` }
  }

  const seq = Number(current.token_seq ?? 0) + 1
  const token = makeToken(seq, random)
  const updated: AdsRow = {
    ...current,
    status: ADS_STATUS.RETIRED,
    pending: false,
    abnormal: true,
    archive_contract: true,
    callable: false,
    revoke_token: token,
    token_seq: seq,
    token_consumed: false,
    resolver_synced: false,
    retired_at: now,
  }
  const event: VersionEvent = {
    at: now,
    action: 'retire',
    version: String(updated.版本号),
    tokenSeq: seq,
  }
  return {
    ok: true,
    message: `应用数据集已退役，归档契约已开启，调用标志已关闭；请立即保存一次性 revoke_token`,
    row: updated,
    token,
    tokenSeq: seq,
    events: [event],
  }
}

/** 重新发布：退役数据集必须携带当前 token_seq 对应的一次性 revoke_token。 */
export function republishAds(rows: AdsRow[], id: number, token: string, ctx?: Ctx): PublishingOutcome {
  const { now } = resolveCtx(ctx)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的应用数据集` }
  }
  const current = normalizeAdsRow(rows[index])
  const seq = Number(current.token_seq ?? 0)
  const presented = (token ?? '').trim()

  // 同 token 重放优先识别：无论当前是退役还是已重新发布，已消费令牌的重复请求都不新增副作用。
  if (
    presented &&
    presented === String(current.revoke_token ?? '') &&
    current.token_consumed === true
  ) {
    return {
      ok: true,
      replay: true,
      message: `相同 revoke_token 重放，识别为重复请求，未新增副作用（当前版本 ${current.版本号}）`,
      row: { ...current },
    }
  }

  if (!isRetired(current)) {
    return {
      ok: false,
      message:
        current.status === ADS_STATUS.PUBLISHED
          ? '应用数据集处于可调用状态，无需重新发布'
          : `只有退役（${ADS_STATUS.RETIRED}）数据集才需要带 token 重新发布`,
    }
  }

  if (!presented) {
    return { ok: false, message: '退役数据集重新发布必须携带一次性 revoke_token' }
  }
  if (presented !== String(current.revoke_token ?? '')) {
    return {
      ok: false,
      message: `revoke_token 校验失败：与当前 token_seq=${seq} 的定稿令牌不匹配，可能是过期或伪造令牌`,
    }
  }

  const nextVersion = bumpVersion(String(current.版本号))
  const updated: AdsRow = {
    ...current,
    status: ADS_STATUS.PUBLISHED,
    pending: false,
    abnormal: false,
    // 归档契约保留：历史解释能力不丢，但调用标志单独打开，二者不再混为一谈。
    archive_contract: true,
    callable: true,
    token_consumed: true,
    resolver_synced: false,
    republished_at: now,
    版本号: nextVersion,
  }
  const event: VersionEvent = {
    at: now,
    action: 'republish',
    version: nextVersion,
    tokenSeq: seq,
  }
  return {
    ok: true,
    message: `revoke_token 校验通过，应用数据集已重新发布，发布版本定稿为 ${nextVersion}`,
    row: updated,
    tokenSeq: seq,
    events: [event],
  }
}

/** 普通发布上线：待发布 -> 已发布，单独打开调用标志。 */
export function publishAds(rows: AdsRow[], id: number, ctx?: Ctx): PublishingOutcome {
  const { now } = resolveCtx(ctx)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的应用数据集` }
  }
  const current = normalizeAdsRow(rows[index])
  if (current.status !== ADS_STATUS.PENDING) {
    return { ok: false, message: `只有「${ADS_STATUS.PENDING}」状态的应用数据集才能发布上线` }
  }
  const version = String(current.版本号 || 'v1')
  const updated: AdsRow = {
    ...current,
    status: ADS_STATUS.PUBLISHED,
    pending: false,
    abnormal: false,
    archive_contract: false,
    callable: true,
    resolver_synced: false,
    published_at: now,
    版本号: version,
  }
  const event: VersionEvent = { at: now, action: 'publish', version, tokenSeq: 0 }
  return {
    ok: true,
    message: `应用数据集已发布上线，调用标志已打开（版本 ${version}）`,
    row: updated,
    events: [event],
  }
}

function tokenValidForRow(row: AdsRow, token: string | undefined): boolean {
  return (token ?? '').trim() !== '' && (token ?? '').trim() === String(row.revoke_token ?? '')
}

/** 目录索引命中：archive_contract 与 callable 分栏返回，退役标识无有效 token 不得交付。 */
export function lookupCatalog(rows: AdsRow[], identifier: string, token?: string): CatalogHit {
  const key = identifier.trim()
  const row = rows
    .map(normalizeAdsRow)
    .find((item) => String(item.数据集编号 ?? '') === key)

  if (!row) {
    return {
      hit: false,
      identifier: key,
      status: '',
      archiveContract: false,
      callable: false,
      deliverable: false,
      version: '',
      tokenSeq: 0,
      http: 404,
      message: '目录未命中该标识',
    }
  }

  const base = {
    hit: true,
    identifier: key,
    status: row.status,
    archiveContract: row.archive_contract === true,
    callable: isCallable(row),
    version: String(row.版本号 ?? ''),
    tokenSeq: Number(row.token_seq ?? 0),
  }

  if (isCallable(row)) {
    return { ...base, deliverable: true, http: 200, message: '目录命中且调用标志打开，可正常交付（HTTP 200）' }
  }
  if (isRetired(row)) {
    if (!token || !token.trim()) {
      return {
        ...base,
        deliverable: false,
        http: 410,
        message: '目录命中退役标识但缺少 revoke_token，禁止交付，仅归档可见（HTTP 410）',
      }
    }
    if (!tokenValidForRow(row, token)) {
      return {
        ...base,
        deliverable: false,
        http: 410,
        message: `revoke_token 校验失败，退役标识不得按交付处理（HTTP 410，token_seq=${base.tokenSeq}）`,
      }
    }
    return {
      ...base,
      deliverable: false,
      http: 410,
      message: 'token 校验通过，仅开放归档契约的历史解释；callable=false，存档不等于交付（HTTP 410）',
    }
  }
  return {
    ...base,
    deliverable: false,
    http: 409,
    message: `数据集处于「${row.status}」，尚未发布，目录不可交付（HTTP 409）`,
  }
}

export function contractFromRow(row: AdsRow, now: string): ResolverContract {
  const normalized = normalizeAdsRow(row)
  return {
    identifier: String(normalized.数据集编号 ?? ''),
    status: normalized.status,
    archiveContract: normalized.archive_contract === true,
    callable: isCallable(normalized),
    tokenSeq: Number(normalized.token_seq ?? 0),
    version: String(normalized.版本号 ?? ''),
    updatedAt: now,
  }
}

/**
 * 解析器调用模拟：退役标识一律不再判 200。
 * 有效 token 也只能拿到 410 + 归档契约做历史解释。
 */
export function resolveCall(
  rows: AdsRow[],
  registry: ResolverContract[],
  identifier: string,
  token?: string,
  ctx?: Ctx,
): ResolverResponse {
  const { now } = resolveCtx(ctx)
  const key = identifier.trim()
  const row = rows
    .map(normalizeAdsRow)
    .find((item) => String(item.数据集编号 ?? '') === key)

  if (!row) {
    const stale = registry.find((item) => item.identifier === key) ?? null
    return {
      http: 404,
      ok: false,
      contract: stale,
      message: stale
        ? '应用层发布主索引已无此标识，resolver 仅保留历史契约，无法调用（HTTP 404）'
        : '解析器未找到该标识（HTTP 404）',
    }
  }

  const contract = contractFromRow(row, now)
  if (isCallable(row)) {
    return { http: 200, ok: true, contract, message: '调用标志打开，resolver 放行（HTTP 200）' }
  }
  if (isRetired(row)) {
    if (!token || !token.trim()) {
      return {
        http: 410,
        ok: false,
        contract,
        message: '退役标识调用必须携带 revoke_token，旧 resolver 的 200 判定已废止（HTTP 410）',
      }
    }
    if (!tokenValidForRow(row, token)) {
      return {
        http: 410,
        ok: false,
        contract,
        message: `revoke_token 校验失败，拒绝退役标识调用（HTTP 410，token_seq=${contract.tokenSeq}）`,
      }
    }
    return {
      http: 410,
      ok: false,
      contract,
      message: 'token 校验通过，仅返回归档契约供历史解释；callable=false，不构成可调用交付（HTTP 410）',
    }
  }
  return {
    http: 409,
    ok: false,
    contract,
    message: `数据集处于「${row.status}」，resolver 不予放行（HTTP 409）`,
  }
}

/**
 * 从持久索引重读并对账 resolver 契约：
 * 归档契约 / 调用标志以应用层发布行为准，逐标识同步；索引里消失的旧契约保留不删。
 */
export function syncResolverRegistry(
  registry: ResolverContract[],
  rows: AdsRow[],
  ctx?: Ctx,
): { registry: ResolverContract[]; updated: string[] } {
  const { now } = resolveCtx(ctx)
  const next = new Map(registry.map((item) => [item.identifier, { ...item }]))
  const updated: string[] = []
  for (const row of rows.map(normalizeAdsRow)) {
    const identifier = String(row.数据集编号 ?? '')
    const desired = contractFromRow(row, now)
    const existing = next.get(identifier)
    if (
      !existing ||
      existing.status !== desired.status ||
      existing.archiveContract !== desired.archiveContract ||
      existing.callable !== desired.callable ||
      existing.tokenSeq !== desired.tokenSeq ||
      existing.version !== desired.version
    ) {
      next.set(identifier, desired)
      updated.push(identifier)
    }
  }
  return { registry: [...next.values()], updated }
}
