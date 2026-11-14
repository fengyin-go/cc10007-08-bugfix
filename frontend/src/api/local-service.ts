import { MODULE_BY_KEY } from '@/data/modules'
import {
  ledgerStorageKey,
  allRows,
  listRows,
  readJson,
  resetRows,
  resolverStorageKey,
  saveRows,
  writeJson,
} from '@/data/local-store'
import {
  ADS_STATUS,
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
  type CatalogHit,
  type ResolverContract,
  type ResolverResponse,
  type VersionEvent,
} from '@/data/publishing'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

type VersionLedger = Record<string, VersionEvent[]>

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  // 应用层发布的发布/下线走带 token 治理的专用链路，不再走通用状态机。
  if (key === 'ads') {
    if (action === '发布上线') {
      return publishAdsService(id)
    }
    if (action === '服务下线') {
      return retireAdsService(id)
    }
  }
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// ---------------------------------------------------------------------------
// 应用层发布治理：退役 token、目录索引、resolver 对账、版本台账
// ---------------------------------------------------------------------------

const ADS_KEY = 'ads'

function adsRows(): AdsRow[] {
  return listRows(ADS_KEY).map((row) => normalizeAdsRow(row as AdsRow))
}

function persistAdsRows(rows: AdsRow[]): void {
  saveRows(ADS_KEY, rows as EntryRow[])
}

function readRegistry(): ResolverContract[] {
  return readJson<ResolverContract[]>(resolverStorageKey(), [])
}

function readLedger(): VersionLedger {
  return readJson<VersionLedger>(ledgerStorageKey(), {})
}

function appendLedgerForIdentifier(identifier: string, events: VersionEvent[]): void {
  if (events.length === 0) {
    return
  }
  const ledger = readLedger()
  const bucket = ledger[identifier] ?? []
  bucket.push(...events)
  ledger[identifier] = bucket
  writeJson(ledgerStorageKey(), ledger)
}

/**
 * 从持久索引重读，对账 resolver 契约表：
 * 归档契约与调用标志两处一致；旧契约保留（主索引消失的标识不删除）。
 */
export function syncResolverNow(): { updated: string[]; registry: ResolverContract[] } {
  const rows = adsRows()
  const registry = readRegistry()
  const result = syncResolverRegistry(registry, rows)
  writeJson(resolverStorageKey(), result.registry)

  // 回写行上的同步标志，便于列表展示哪些契约已经同步到 resolver。
  const nextRows = rows.map((row) => ({
    ...row,
    resolver_synced: result.registry.some(
      (contract) =>
        contract.identifier === String(row.数据集编号 ?? '') &&
        contract.status === row.status &&
        contract.archiveContract === (row.archive_contract === true) &&
        contract.callable === isCallable(row),
    ),
  }))
  persistAdsRows(nextRows)
  return { updated: result.updated, registry: result.registry }
}

export function resolverRegistry(): ResolverContract[] {
  return readRegistry()
}

export function versionLedger(identifier?: string): VersionLedger | VersionEvent[] {
  const ledger = readLedger()
  if (!identifier) {
    return ledger
  }
  return ledger[identifier] ?? []
}

/** 服务下线（退役）：一次性签发 revoke_token，并立即把新契约同步到 resolver。 */
export function retireAdsService(id: number): ActionResult {
  const rows = adsRows()
  const outcome = retireAds(rows, id)
  if (!outcome.ok || !outcome.row) {
    return { ok: false, message: outcome.message }
  }
  const next = rows.map((row) => (Number(row.id) === id ? (outcome.row as AdsRow) : row))
  persistAdsRows(next)
  const identifier = String(outcome.row.数据集编号 ?? '')
  appendLedgerForIdentifier(identifier, outcome.events ?? [])
  syncResolverNow()
  return {
    ok: true,
    message: outcome.message,
    token: outcome.token,
    tokenSeq: outcome.tokenSeq,
  }
}

/** 重新发布：必须携带退役时签发的一次性 revoke_token；同 token 重放不新增副作用。 */
export function republishAdsService(id: number, token: string): ActionResult {
  const rows = adsRows()
  const outcome = republishAds(rows, id, token)
  if (!outcome.ok) {
    return { ok: false, message: outcome.message }
  }
  if (outcome.replay) {
    return { ok: true, replay: true, message: outcome.message }
  }
  if (!outcome.row) {
    return { ok: false, message: '重新发布未产生定稿数据' }
  }
  const next = rows.map((row) => (Number(row.id) === id ? (outcome.row as AdsRow) : row))
  persistAdsRows(next)
  const identifier = String(outcome.row.数据集编号 ?? '')
  appendLedgerForIdentifier(identifier, outcome.events ?? [])
  syncResolverNow()
  return { ok: true, message: outcome.message, tokenSeq: outcome.tokenSeq }
}

/** 发布上线：待发布 -> 已发布，单独打开 callable，归档契约不联动。 */
export function publishAdsService(id: number): ActionResult {
  const rows = adsRows()
  const outcome = publishAds(rows, id)
  if (!outcome.ok || !outcome.row) {
    return { ok: false, message: outcome.message }
  }
  const next = rows.map((row) => (Number(row.id) === id ? (outcome.row as AdsRow) : row))
  persistAdsRows(next)
  const identifier = String(outcome.row.数据集编号 ?? '')
  appendLedgerForIdentifier(identifier, outcome.events ?? [])
  syncResolverNow()
  return { ok: true, message: outcome.message }
}

/** 目录索引查询：命中退役标识时校验 token，archive_contract 与 callable 分栏返回。 */
export function catalogLookupService(identifier: string, token?: string): CatalogHit {
  return lookupCatalog(adsRows(), identifier, token)
}

/** 目录索引全量视图：每个应用数据集一行，归档契约与调用标志强制分栏。 */
export function catalogIndexViewService(): CatalogHit[] {
  return adsRows().map((row) => lookupCatalog(adsRows(), String(row.数据集编号 ?? '')))
}

/** resolver 调用模拟：退役标识一律不再判 200，有效 token 也只返回 410 归档解释。 */
export function resolverCallService(identifier: string, token?: string): ResolverResponse {
  return resolveCall(adsRows(), readRegistry(), identifier, token)
}

export function adsStatuses() {
  return ADS_STATUS
}

export function isAdsRetired(row: EntryRow): boolean {
  return isRetired(normalizeAdsRow(row as AdsRow))
}

export function isAdsCallable(row: EntryRow): boolean {
  return isCallable(normalizeAdsRow(row as AdsRow))
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
