<template>
  <section class="page" data-module="ads">
    <header class="page-head">
      <div>
        <h2>应用层发布管理</h2>
        <p class="page-desc">
          维护应用层数据发布的输入、执行约束与结果记录。退役一次性签发 revoke_token，目录索引与 resolver 均校验令牌；
          归档契约只开放历史解释，与调用标志分栏管理，存档不等于交付。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记应用数据集</button>
        <button class="btn" type="button" @click="exportRows">导出应用层发布清单</button>
        <button class="btn" type="button" @click="reconcile">从持久索引对账 resolver</button>
      </div>
    </header>

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
          <th>发布版本</th>
          <th>归档契约<br /><small>archive_contract</small></th>
          <th>调用标志<br /><small>callable</small></th>
          <th>token_seq</th>
          <th>resolver 同步</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="row in rows"
          :key="String(row.id)"
          :class="{ 'row-retired': row.status === '已下线' }"
          @click="openDetail(row)"
        >
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.版本号 ?? '—' }}</td>
          <td>
            <span :class="['flag', row.archive_contract ? 'flag-on' : 'flag-off']">
              {{ row.archive_contract ? 'true · 可历史解释' : 'false' }}
            </span>
          </td>
          <td>
            <span :class="['flag', row.callable ? 'flag-on' : 'flag-off']">
              {{ row.callable ? 'true · 可调用' : 'false · 不可交付' }}
            </span>
          </td>
          <td>{{ row.token_seq ?? 0 }}</td>
          <td>
            <span :class="['dot', row.resolver_synced ? 'dot-ok' : 'dot-warn']">
              {{ row.resolver_synced ? '已同步' : '待同步' }}
            </span>
          </td>
          <td>
            <span :class="['status-badge', row.status === '已下线' ? 'badge-retired' : '']">
              {{ row.status }}
            </span>
          </td>
          <td class="row-actions" @click.stop>
            <button
              v-for="action in availableActions(row)"
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
          <td :colspan="columns.length + 7" class="empty-state">暂无应用层发布数据，可先登记应用数据集</td>
        </tr>
      </tbody>
    </table>

    <!-- resolver 调用模拟：验证退役标识不会再被判成 200 -->
    <section class="sim-card">
      <h3>resolver 调用模拟（旧 resolver 把退役调用判 200 的问题在此拦截）</h3>
      <form class="filter-bar" @submit.prevent="runResolve">
        <label class="filter-item">
          <span>数据集标识</span>
          <input v-model="resolveForm.identifier" placeholder="如 ADS-0001" />
        </label>
        <label class="filter-item">
          <span>revoke_token（退役标识必填）</span>
          <input v-model="resolveForm.token" placeholder="退役后签发的一次性令牌" class="token-input" />
        </label>
        <button class="btn primary" type="submit">发起调用</button>
      </form>
      <div v-if="resolveResult" class="sim-result" :class="resolveResult.http === 200 ? 'sim-ok' : 'sim-block'">
        <strong>HTTP {{ resolveResult.http }} · {{ resolveResult.message }}</strong>
        <dl v-if="resolveResult.contract" class="contract-grid">
          <div><dt>标识</dt><dd>{{ resolveResult.contract.identifier }}</dd></div>
          <div><dt>状态</dt><dd>{{ resolveResult.contract.status }}</dd></div>
          <div>
            <dt>归档契约</dt>
            <dd>{{ resolveResult.contract.archiveContract ? 'true（仅历史解释）' : 'false' }}</dd>
          </div>
          <div>
            <dt>调用标志</dt>
            <dd>{{ resolveResult.contract.callable ? 'true（可交付）' : 'false（禁止当交付）' }}</dd>
          </div>
          <div><dt>token_seq</dt><dd>{{ resolveResult.contract.tokenSeq }}</dd></div>
          <div><dt>发布版本</dt><dd>{{ resolveResult.contract.version }}</dd></div>
        </dl>
      </div>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条应用层发布记录；主对象为应用层发布，归档仅作历史解释</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <!-- 退役成功：一次性 revoke_token 仅在此完整展示一次 -->
    <div v-if="retireDialog" class="modal-mask" @click.self="retireDialog = null">
      <div class="modal">
        <h3>服务下线完成 · 一次性 revoke_token</h3>
        <p class="modal-tip">
          应用数据集 <strong>{{ retireDialog.identifier }}</strong> 已退役（token_seq={{ retireDialog.tokenSeq }}）。
          该令牌只展示这一次，请立即复制保存；重新发布时必须原样携带。
        </p>
        <code class="token-code">{{ retireDialog.token }}</code>
        <div class="modal-actions">
          <button class="btn" type="button" @click="copyToken(retireDialog.token)">复制令牌</button>
          <button class="btn primary" type="button" @click="retireDialog = null">我已保存</button>
        </div>
      </div>
    </div>

    <!-- 重新发布：强制输入一次性 token -->
    <div v-if="republishTarget" class="modal-mask" @click.self="republishTarget = null">
      <div class="modal">
        <h3>重新发布 · 校验 revoke_token</h3>
        <p class="modal-tip">
          {{ republishTarget.数据集编号 }} 当前为退役态（token_seq={{ republishTarget.token_seq }}），
          归档契约保留但 callable=false。输入退役时签发的一次性令牌后才能定稿新版本。
        </p>
        <input v-model="republishToken" class="token-input modal-input" placeholder="粘贴 RVK-x-xxxx 令牌" />
        <p v-if="republishError" class="error-text">{{ republishError }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="cancelRepublish">取消</button>
          <button class="btn primary" type="button" @click="confirmRepublish">校验并重新发布</button>
        </div>
      </div>
    </div>

    <!-- 详情面板：按 id 实时从持久索引取值，避免快照过期导致新值丢失 -->
    <div v-if="detailId !== null" class="modal-mask" @click.self="closeDetail">
      <div class="modal modal-wide">
        <h3>应用数据集详情 · {{ detailRow?.数据集编号 }}</h3>
        <dl v-if="detailRow" class="detail-grid">
          <div v-for="field in detailFields" :key="field">
            <dt>{{ field }}</dt>
            <dd>{{ detailRow[field] ?? '—' }}</dd>
          </div>
          <div>
            <dt>归档契约 archive_contract</dt>
            <dd>{{ detailRow.archive_contract ? 'true — 仅开放历史解释，不等于可调用' : 'false' }}</dd>
          </div>
          <div>
            <dt>调用标志 callable</dt>
            <dd>{{ detailRow.callable ? 'true — 可正常交付' : 'false — 禁止把存档当交付' }}</dd>
          </div>
          <div>
            <dt>revoke_token / token_seq</dt>
            <dd>{{ detailRow.status === '已下线' ? detailRow.revoke_token : '（退役后签发）' }} / {{ detailRow.token_seq ?? 0 }}</dd>
          </div>
        </dl>
        <h4>发布版本台账（以应用层发布为主对象回看）</h4>
        <table class="data-table ledger-table">
          <thead>
            <tr><th>时间</th><th>动作</th><th>发布版本</th><th>token_seq</th></tr>
          </thead>
          <tbody>
            <tr v-for="(event, index) in detailLedger" :key="index">
              <td>{{ event.at }}</td>
              <td>{{ ledgerActionLabel(event.action) }}</td>
              <td>{{ event.version }}</td>
              <td>{{ event.tokenSeq }}</td>
            </tr>
            <tr v-if="!detailLedger.length">
              <td colspan="4" class="empty-state">该数据集暂无发布版本事件</td>
            </tr>
          </tbody>
        </table>
        <div class="modal-actions">
          <button class="btn primary" type="button" @click="closeDetail">关闭</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  reconcileResolver,
  republishAdsService,
  resolverCallService,
  retireAdsService,
  runAction as applyAction,
  versionLedger,
} from '@/api/ads-service'
import type { EntryRow } from '@/data/types'
import type { ResolverResponse, VersionEvent } from '@/data/publishing'

const meta = moduleMeta('ads')
const columns = ['数据集编号', '业务应用', '输出表名', '查询模板', '下游消费方', '接口协议', '刷新策略']
const detailFields = [...columns, '版本号']
const stats = ref([
  { label: '应用数据集总数', value: 0 },
  { label: '已发布（callable=true）', value: 0 },
  { label: '已退役（归档不可交付）', value: 0 },
  { label: '待发布', value: 0 },
])

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statuses = ['草稿', '待发布', '已发布', '已下线']

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const resolveForm = ref({ identifier: 'ADS-0001', token: '' })
const resolveResult = ref<ResolverResponse | null>(null)

const retireDialog = ref<{ identifier: string; token: string; tokenSeq: number } | null>(null)
const republishTarget = ref<EntryRow | null>(null)
const republishToken = ref('')
const republishError = ref('')

const detailId = ref<number | null>(null)
// 详情按 id 从最新持久索引实时计算，修复旧对象快照导致的「新值丢失」。
const detailRow = computed(() =>
  detailId.value === null ? null : rows.value.find((row) => Number(row.id) === detailId.value) ?? null,
)
const detailLedger = computed<VersionEvent[]>(() => {
  if (!detailRow.value) {
    return []
  }
  return versionLedger(String(detailRow.value.数据集编号 ?? '')) as VersionEvent[]
})

function availableActions(row: EntryRow): string[] {
  if (row.status === '草稿') {
    return ['提交发布']
  }
  if (row.status === '待发布') {
    return ['发布上线']
  }
  if (row.status === '已发布') {
    return ['服务下线']
  }
  if (row.status === '已下线') {
    return ['重新发布']
  }
  return []
}

function refreshStats() {
  stats.value = [
    { label: '应用数据集总数', value: rows.value.length },
    { label: '已发布（callable=true）', value: rows.value.filter((row) => row.callable === true).length },
    { label: '已退役（归档不可交付）', value: rows.value.filter((row) => row.status === '已下线').length },
    { label: '待发布', value: rows.value.filter((row) => row.status === '待发布').length },
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
  errorMessage.value = '应用数据集登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  if (action === '服务下线') {
    const result = retireAdsService(Number(row.id))
    if (!result.ok || !result.token) {
      errorMessage.value = result.message
      return
    }
    reload()
    retireDialog.value = {
      identifier: String(row.数据集编号),
      token: result.token,
      tokenSeq: result.tokenSeq ?? 0,
    }
    return
  }
  if (action === '重新发布') {
    republishTarget.value = row
    republishToken.value = ''
    republishError.value = ''
    return
  }
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function confirmRepublish() {
  if (!republishTarget.value) {
    return
  }
  const result = republishAdsService(Number(republishTarget.value.id), republishToken.value)
  if (!result.ok) {
    republishError.value = result.message
    return
  }
  republishError.value = ''
  republishTarget.value = null
  republishToken.value = ''
  reload()
  errorMessage.value = result.message
}

function cancelRepublish() {
  republishTarget.value = null
  republishToken.value = ''
  republishError.value = ''
}

function reconcile() {
  const result = reconcileResolver()
  reload()
  errorMessage.value = result.updated.length
    ? `resolver 已按持久索引对账，同步标识：${result.updated.join('、')}`
    : 'resolver 契约与持久索引已一致，旧契约保留未删'
}

function runResolve() {
  errorMessage.value = ''
  resolveResult.value = resolverCallService(resolveForm.value.identifier, resolveForm.value.token)
}

function openDetail(row: EntryRow) {
  detailId.value = Number(row.id)
}

function closeDetail() {
  detailId.value = null
}

function copyToken(token: string) {
  if (navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(token)
  }
}

function ledgerActionLabel(action: string): string {
  const labels: Record<string, string> = {
    publish: '发布上线',
    retire: '服务下线',
    republish: '重新发布',
  }
  return labels[action] ?? action
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    refreshStats()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '应用层发布列表读取失败'
  }
}

onMounted(() => {
  // 应用启动即从持久索引对账一次，保证归档契约与调用标志两处一致。
  reconcileResolver()
  reload()
})
</script>
