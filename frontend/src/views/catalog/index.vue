<template>
  <section class="page" data-module="catalog">
    <header class="page-head">
      <div>
        <h2>编目检索管理</h2>
        <p class="page-desc">
          维护数据编目条目的输入、执行约束与结果记录。目录索引命中应用层发布标识时校验 revoke_token：
          归档契约与调用标志分栏呈现，退役存档禁止当成交付。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记编目条目</button>
        <button class="btn" type="button" @click="exportRows">导出编目检索清单</button>
      </div>
    </header>

    <!-- 应用层发布目录索引：catalog_index 命中与 token 校验入口 -->
    <section class="sim-card">
      <h3>应用层发布目录索引（catalog_index）</h3>
      <form class="filter-bar" @submit.prevent="runLookup">
        <label class="filter-item">
          <span>数据集标识</span>
          <input v-model="lookupForm.identifier" placeholder="如 ADS-0001" />
        </label>
        <label class="filter-item">
          <span>revoke_token（仅退役标识需要）</span>
          <input v-model="lookupForm.token" placeholder="退役后签发的一次性令牌" class="token-input" />
        </label>
        <button class="btn primary" type="submit">目录检索</button>
      </form>

      <div v-if="lookupResult" class="sim-result" :class="lookupResult.deliverable ? 'sim-ok' : 'sim-block'">
        <strong>HTTP {{ lookupResult.http }} · {{ lookupResult.message }}</strong>
        <dl class="contract-grid">
          <div><dt>标识</dt><dd>{{ lookupResult.identifier || '—' }}</dd></div>
          <div><dt>主对象状态</dt><dd>{{ lookupResult.status || '未命中' }}</dd></div>
          <div>
            <dt>归档契约 archive_contract</dt>
            <dd>{{ lookupResult.archiveContract ? 'true · 仅历史解释' : 'false' }}</dd>
          </div>
          <div>
            <dt>调用标志 callable</dt>
            <dd>{{ lookupResult.callable ? 'true · 可交付' : 'false · 存档不可交付' }}</dd>
          </div>
          <div><dt>发布版本</dt><dd>{{ lookupResult.version || '—' }}</dd></div>
          <div><dt>token_seq</dt><dd>{{ lookupResult.tokenSeq }}</dd></div>
        </dl>
      </div>

      <!-- 索引视图：两栏分开，旧退役对象不会在列表里被显示成有效 -->
      <table class="data-table index-table">
        <thead>
          <tr>
            <th>数据集标识</th>
            <th>主对象状态</th>
            <th>归档契约（历史解释）</th>
            <th>调用标志（能否交付）</th>
            <th>发布版本</th>
            <th>token_seq</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in indexView" :key="item.identifier" :class="{ 'row-retired': item.status === '已下线' }">
            <td>{{ item.identifier }}</td>
            <td>
              <span :class="['status-badge', item.status === '已下线' ? 'badge-retired' : '']">{{ item.status }}</span>
            </td>
            <td>
              <span :class="['flag', item.archiveContract ? 'flag-on' : 'flag-off']">
                {{ item.archiveContract ? 'true' : 'false' }}
              </span>
            </td>
            <td>
              <span :class="['flag', item.callable ? 'flag-on' : 'flag-off']">
                {{ item.callable ? 'true · 可交付' : 'false · 不可交付' }}
              </span>
            </td>
            <td>{{ item.version }}</td>
            <td>{{ item.tokenSeq }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无编目检索数据，可先登记编目条目</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条编目条目记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadEntries, listEntries, moduleMeta, runAction as applyAction } from '@/api/local-service'
import { catalogLookupService, catalogIndexView } from '@/api/catalog-service'
import type { EntryRow } from '@/data/types'
import type { CatalogHit } from '@/data/publishing'

const meta = moduleMeta('catalog')
const columns = ['条目编号', '数据集名称', '所属分层', '业务标签', '数据格式', '存储路径', '负责人', '最后更新']
const actions = ['提交发布', '发布条目', '下线条目']
const statuses = ['草稿', '待发布', '已发布', '已下线']
const stats = ref([
  { label: '编目条目总数', value: 0 },
  { label: '已发布条目', value: 0 },
  { label: '待发布条目', value: 0 },
])

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const lookupForm = ref({ identifier: 'ADS-0001', token: '' })
const lookupResult = ref<CatalogHit | null>(null)
const indexTick = ref(0)
const indexView = computed(() => {
  // 依赖 indexTick，动作导致底层数据变化后索引视图随之刷新。
  void indexTick.value
  return catalogIndexView()
})

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function refreshStats() {
  stats.value = [
    { label: '编目条目总数', value: rows.value.length },
    { label: '已发布条目', value: rows.value.filter((row) => row.status === '已发布').length },
    { label: '待发布条目', value: rows.value.filter((row) => row.status === '待发布').length },
  ]
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '编目条目登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function runLookup() {
  errorMessage.value = ''
  lookupResult.value = catalogLookupService(lookupForm.value.identifier, lookupForm.value.token)
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    refreshStats()
    indexTick.value += 1
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '编目检索列表读取失败'
  }
}

onMounted(reload)
</script>
