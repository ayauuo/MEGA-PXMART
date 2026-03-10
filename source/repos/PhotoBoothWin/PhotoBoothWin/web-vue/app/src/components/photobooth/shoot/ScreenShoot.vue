<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { usePhotobooth } from '@/composables/usePhotobooth'
import { useTakePicture } from '@/composables/useTakePicture'
import { useLiveView } from '@/composables/useLiveView'
const props = defineProps<{ isActive?: boolean }>()
const { selectedTemplate, templates, selectTemplate, showScreen, setCaptureResults, setCaptureVideoBlob, captureResults, buildFinalOutput, callHost, setTestSession } =
  usePhotobooth()
const { hostLiveViewDataUrl, liveViewFrameCount, clearHostLiveViewDataUrl } = useLiveView()
const tp = useTakePicture(() => selectedTemplate.value ?? null)

/** 是否顯示濾鏡區（拍完照按「下一步」後顯示，同一頁內完成預覽→濾鏡→確認） */
const showFilterOptions = ref(false)

const shootRootRef = ref<HTMLElement | null>(null)
const pictureAreaRef = ref<HTMLElement | null>(null)
const leftPanelRef = ref<HTMLElement | null>(null)
/** 左側面板 left：拍照外框左緣往左 80px，再扣掉左側縮圖區寬度（動態依外框與縮圖大小計算） */
const leftPanelLeftPx = ref(70)
const LEFT_PANEL_OFFSET = 80

/** 只執行一次：左側面板 left 計算（拍照外框左緣往左 80px 再扣掉縮圖區寬度） */
function doUpdateLeftPanelLeft() {
  const root = shootRootRef.value
  const area = pictureAreaRef.value
  const panel = leftPanelRef.value
  if (!root || !area) return
  const rootRect = root.getBoundingClientRect()
  const areaRect = area.getBoundingClientRect()
  const panelWidth = panel ? panel.getBoundingClientRect().width : 0
  leftPanelLeftPx.value = Math.round(areaRect.left - rootRect.left - LEFT_PANEL_OFFSET - panelWidth)
}

/** 是否已做過第一次 left 計算（之後不再更新，版面已定型） */
const hasInitialLeft = ref(false)
/** 下一步按鈕處理中：防止重複點擊導致多次列印 */
const isNextProcessing = ref(false)
/** 左側面板是否已定位完成（定位前隱藏，避免使用者看到跑位） */
const shootLayoutReady = ref(false)

/** 左側面板在 absolute 模式時的 style（left 依拍照外框動態計算） */
const leftPanelStyle = computed(() =>
  !showFilterOptions.value ? { left: `${leftPanelLeftPx.value}px` } : {}
)

const thumbUrls = ref<string[]>([])
/** 連拍中目前要拍的是第幾格（0-based），-1 表示非連拍中；左側該格顯示即時預覽 */
const currentShootingIndex = ref(-1)
const isReshooting = ref(false)
/** 非 WebView 時顯示提示：僅在拍貼機程式內使用 EDSDK 相機 */
const cameraError = ref<string | null>(null)

const shotCount = computed(() => tp.shotCount.value)
/** 強制拍攝不等待對焦（到時機就拍，不管有無對焦成功） */
function getForceWithoutAf(): boolean {
  const v = import.meta.env.VITE_FORCE_CAPTURE_WITHOUT_AF
  return v === '1' || String(v).toLowerCase() === 'true'
}

/** 只半按模式：進入拍照頁只對焦不自動倒數，需手動點「開始倒數拍照」才會倒數與拍照 */
const onlyHalfPressMode = computed(
  () =>
    String(import.meta.env.VITE_SHOOT_ONLY_HALF_PRESS ?? '') === '1' ||
    String(import.meta.env.VITE_SHOOT_ONLY_HALF_PRESS ?? '').toLowerCase() === 'true'
)

/** 倒數與對焦參數：可由 .env 覆寫。
 * VITE_FOCUS_AT_SECONDS=10,5 表示在倒數 10 秒與 5 秒時「觸發對焦」；預設 10,5。拍攝只在 T=0 一次。 */
function getCountdownOptions(): {
  countdownSeconds: number
  focusAtSeconds: number[]
  focusWaitAfterMs: number
  shootAfterFirstFocus: boolean
} {
  const secRaw = String(import.meta.env.VITE_COUNTDOWN_SECONDS ?? '10').trim()
  const countdownSeconds = Math.min(30, Math.max(1, parseInt(secRaw, 10) || 10))
  const defaultFocus = [10, 5]
  const focusRaw = String(import.meta.env.VITE_FOCUS_AT_SECONDS ?? '10,5').trim()
  const focusAtSeconds = focusRaw
    ? focusRaw.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !Number.isNaN(n) && n >= 1 && n <= 30)
    : defaultFocus
  const waitRaw = String(import.meta.env.VITE_FOCUS_WAIT_AFTER_MS ?? '350').trim()
  const focusWaitAfterMs = Math.min(2000, Math.max(100, parseInt(waitRaw, 10) || 350))
  const shootRaw = String(import.meta.env.VITE_SHOOT_AFTER_FIRST_FOCUS ?? '0').trim()
  const shootAfterFirstFocus = shootRaw === '1' || shootRaw.toLowerCase() === 'true'
  return {
    countdownSeconds,
    focusAtSeconds: focusAtSeconds.length > 0 ? focusAtSeconds : defaultFocus,
    focusWaitAfterMs,
    shootAfterFirstFocus,
  }
}
/** 左側縮圖：有拍照用原圖，沒拍照一開始就顯示外匡圖；外匡兩層 */
const thumbList = computed(() =>
  Array.from({ length: shotCount.value }, (_, i) => ({
    id: i + 1,
    url: thumbUrls.value[i] ?? '',
    frameUrl: tp.getCurrentFrameUrl(i),
  }))
)

/** 依版型帶入的根節點 class，方便依 .screen--shoot--bk01 等重寫 CSS */
const shootRootClass = computed(() => {
  const t = selectedTemplate.value
  const base = ['screen', 'screen--shoot']
  const idClass = t ? `screen--shoot--${t.id}` : 'screen--shoot--none'
  const layoutClass = t?.shootLayout?.layoutKey
    ? `screen--shoot--layout-${t.shootLayout!.layoutKey}`
    : ''
  const reshootingClass = isReshooting.value ? 'is-reshooting' : ''
  return [...base, idClass, layoutClass, reshootingClass].filter(Boolean)
})

/** 依版型帶入的 CSS 變數，可在拍照畫面 CSS 內用 var(--shoot-capture-w) 等 */
const shootRootStyle = computed(() => {
  const t = selectedTemplate.value
  if (!t) return {}
  const layout = t.shootLayout ?? {}
  const w = layout.captureW ?? t.captureW
  const h = layout.captureH ?? t.captureH
  const vars: Record<string, string> = {
    '--shoot-capture-w': `${w}px`,
    '--shoot-capture-h': `${h}px`,
    '--shoot-shot-count': String(t.shotCount),
  }
  if (layout.cssVars) Object.assign(vars, layout.cssVars)
  return vars
})

/** 拍照區縮放係數（1 = 原始大小，0.8 = 縮小到 80%） */
const FRAME_SCALE = 0.5

/** 拍照區尺寸（避免在 template :style 內用 ref 導致 [object Object]） */
const pictureAreaStyle = computed(() => ({
  width: `${tp.pictureAreaWidth.value * FRAME_SCALE}px`,
  height: `${tp.pictureAreaHeight.value * FRAME_SCALE}px`,
}))

/** 左側縮圖容器：與右側大圖同比例（讀取框圖大小），避免左邊裁切跑掉 */
const THUMB_HEIGHT = 203
const thumbWrapStyle = computed(() => {
  const w = tp.pictureAreaWidth.value
  const h = tp.pictureAreaHeight.value
  if (!h || h <= 0) return { width: '277px', height: `${THUMB_HEIGHT}px` }
  const widthPx = Math.round(THUMB_HEIGHT * (w / h))
  return { width: `${widthPx}px`, height: `${THUMB_HEIGHT}px` }
})

/** 框圖 .cover：拍完後用選中格的框，拍攝中用目前格的框；與大圖同用 100% 填滿容器，不溢出 */
const coverStyle = computed(() => {
  const url = tp.shootingDone.value
    ? tp.getCurrentFrameUrl(tp.currentMainIndex.value - 1)
    : tp.coverFrameUrl.value
  return {
    backgroundImage: url ? `url('${url}')` : 'none',
    backgroundSize: 'contain',
    backgroundPosition: 'center',
    backgroundRepeat: 'no-repeat',
  }
})

/** 倒數顯示：不顯示 11 與 0，只顯示 10～1 */
const countdownDisplay = computed(() => {
  const n = tp.countdownNum.value
  return n >= 1 && n <= 10 ? String(n) : ''
})

/** 右側主預覽圖（目前選中的縮圖）；拍完後與外匡兩層顯示 */
const mainPreviewUrl = computed(() => {
  if (!tp.shootingDone.value || !thumbUrls.value.length) return ''
  const i = tp.currentMainIndex.value - 1
  return thumbUrls.value[i] ?? thumbUrls.value[0] ?? ''
})

/** 主預覽 img */
const mainPreviewImgRef = ref<HTMLImageElement | null>(null)

/** 左側縮圖上的外匡 style（每格各自框） */
function thumbCoverStyle(frameUrl: string) {
  return {
    backgroundImage: frameUrl ? `url('${frameUrl}')` : 'none',
    backgroundSize: 'contain',
    backgroundPosition: 'center',
    backgroundRepeat: 'no-repeat',
  }
}

function shootLog(msg: string) {
  console.log('[Shoot]', msg)
  callHost('append_shoot_log', { msg }).catch(() => {})
}

function logWaitForLiveViewReady(_reason: string, _frameCountBeforeRestart: number) {}

async function stopLiveViewWithClear(reason: string) {
  clearHostLiveViewDataUrl(reason)
  await callHost('stop_liveview', {}).catch(() => {})
}

/** 等待 Live View 重啟後收到「新幀」，逾時可設（預設 2.5 秒；僅以 frameCount 變化為準，避免舊幀 hasUrl 誤判 ready） */
function waitForLiveViewReady(frameCountBeforeRestart: number): Promise<void> {
  const raw = import.meta.env.VITE_LIVEVIEW_READY_TIMEOUT_MS
  const timeoutMs = raw !== undefined && raw !== '' ? Math.max(500, Math.min(10000, parseInt(raw, 10) || 2500)) : 2500
  const intervalMs = 50
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve) => {
    const check = () => {
      // 僅當收到「新的幀」（frameCount 增加）才視為 Live View 恢復，避免舊的 hasUrl 導致第一次重拍誤判 ready
      if (liveViewFrameCount.value > frameCountBeforeRestart) {
        shootLog(`waitForLiveViewReady 已恢復（幀數 ${liveViewFrameCount.value} > ${frameCountBeforeRestart}）`)
        logWaitForLiveViewReady('frameCount', frameCountBeforeRestart)
        resolve()
        return
      }
      if (Date.now() >= deadline) {
        shootLog('waitForLiveViewReady 逾時，繼續下一張')
        logWaitForLiveViewReady('timeout', frameCountBeforeRestart)
        resolve()
        return
      }
      setTimeout(check, intervalMs)
    }
    check()
  })
}

/** 使用 EDSDK 連拍：預覽與拍照皆由 C# 推送／take_one_shot_edsdk，無 webcam。僅拍 shotCount 張（通常 4 張）。 */
async function startBurstShootEdsdk() {
  if (tp.isBurstShooting.value) {
    shootLog('startBurstShootEdsdk 忽略：已在連拍中')
    return
  }
  if (!props.isActive) {
    shootLog('startBurstShootEdsdk 忽略：已離開拍照頁')
    return
  }
  const count = shotCount.value
  const opts = getCountdownOptions()
  shootLog(`startBurstShootEdsdk 開始 count=${count} opts=${JSON.stringify(opts)} forceWithoutAf=${getForceWithoutAf()}`)
  tp.isBurstShooting.value = true
  if (hasWebView()) callHost('clear_captures', {}).catch(() => {})
  // 依格號保留空位，放棄的格留空字串，方便補拍回填
  const results: string[] = Array.from({ length: count }, () => '')
  thumbUrls.value = Array.from({ length: count }, () => '')

  for (let i = 0; i < count; i++) {
    currentShootingIndex.value = i
    shootLog(`連拍 第 ${i + 1}/${count} 張：setCoverFrameOnly → runCountdown`)
    tp.setCoverFrameOnly(i)
    await new Promise((r) => requestAnimationFrame(r))
    try {
      await tp.runCountdownWithEvfAf(callHost, opts)
    } catch (e) {
      shootLog(`連拍 第 ${i + 1} 張 runCountdown 錯誤: ${e instanceof Error ? e.message : e}`)
    }
    // 拍照當下擷取目前 Live View 並做鏡像（與 captureFrame 相同效果）；有擷取到則優先使用
    let capturedMirroredUrl = ''
    if (hostLiveViewDataUrl.value) {
      try {
        capturedMirroredUrl = await tp.captureFrameFromImage(hostLiveViewDataUrl.value)
      } catch (e) {
        shootLog(`連拍 第 ${i + 1} 張 captureFrameFromImage 失敗: ${e instanceof Error ? e.message : e}`)
      }
    }
    shootLog(`連拍 第 ${i + 1}/${count} 張：呼叫 take_one_shot_edsdk（T=0 立即拍攝）`)
    try {
      const res = (await callHost('take_one_shot_edsdk', { index: i, shotCount: count, forceWithoutAf: getForceWithoutAf() })) as { photoUrl?: string; dataUrl?: string; thumbUrl?: string }
      const urlFromHost = res?.thumbUrl ?? res?.dataUrl ?? ''
      const url = capturedMirroredUrl || urlFromHost
      console.log('[Vue] 收到 C# 回傳:', { hasDataUrl: !!res?.dataUrl, dataUrlLen: res?.dataUrl?.length, photoUrl: res?.photoUrl })
      shootLog(`連拍 第 ${i + 1}/${count} 張 take_one_shot 回傳 url=${url ? '有' : '無'}`)
      if (url) {
        results[i] = url
        thumbUrls.value = [...thumbUrls.value.slice(0, i), url, ...thumbUrls.value.slice(i + 1)]
      }
      // 拍完後：短暫顯示剛拍的縮圖，再重啟 Live View，等恢復後再拍下一張
      if (i < count - 1) {
        await new Promise((r) => setTimeout(r, 300))
      }
    } catch (e) {
      shootLog(`連拍 第 ${i + 1} 張 take_one_shot 錯誤: ${e instanceof Error ? e.message : e}，後端應已回傳截圖／placeholder，若無則用框圖占位`)
      console.error('EDSDK capture failed at shot', i + 1, e)
      callHost('recover_camera_after_error', {}).catch(() => {})
      const fallbackUrl = tp.getCurrentFrameUrl(i)
      if (fallbackUrl) {
        results[i] = fallbackUrl
        thumbUrls.value = [...thumbUrls.value.slice(0, i), fallbackUrl, ...thumbUrls.value.slice(i + 1)]
      }
      if (i < count - 1) {
        await new Promise((r) => setTimeout(r, 300))
      }
    }
  }

  currentShootingIndex.value = -1
  const filledCount = results.filter((u) => !!u).length
  shootLog(`startBurstShootEdsdk 完成 results=${filledCount}/${count} 張（依格號保留空位）`)
  tp.isBurstShooting.value = false
  if (cameraError.value) return
  tp.shootingDone.value = true
  tp.reshootUsedSlots.value = new Set()
  tp.currentMainIndex.value = 1
  thumbUrls.value = [...results]
  setCaptureResults([...results])

  // 拍完照進入預覽時就啟動 Live View，讓第一次按重拍也能立刻顯示即時預覽（不 await，背景執行）
  if (hasWebView()) callHost('start_liveview', {}).catch(() => {})

  const testFast = String(import.meta.env.VITE_TEST_FAST_COUNTDOWN ?? '')
  if (testFast === '1' || testFast === 'true') {
    // 標記為測試模式
    setTestSession(true)
    const tplId = selectedTemplate.value?.id
    if (tplId) {
      callHost('save_test_captures', { templateId: tplId, dataUrls: results.filter(Boolean) }).catch(() => {})
    }
  }
}

async function onNext() {
  if (tp.shootingDone.value) {
    // 進入濾鏡模式前先停止 Live View，避免 60fps 更新 hostLiveViewDataUrl 導致主線程被佔滿、drawFilterPreview 的 rAF 永遠跑不到
    if (hasWebView()) await stopLiveViewWithClear('filter_enter').catch(() => {})
    showFilterOptions.value = true
  }
}

async function onFilterConfirm() {
  await stopLiveViewWithClear('filter_confirm').catch(() => {})
  await new Promise((r) => setTimeout(r, 100))
  await buildFinalOutput()
}

/** 下一步按鈕點擊：直接合成並列印（已拿掉濾鏡步驟）；僅允許點擊一次，防止多次列印 */
async function handleNextClick() {
  if (!tp.shootingDone.value) return
  if (isNextProcessing.value) return
  isNextProcessing.value = true
  try {
    await onFilterConfirm()
  } finally {
    isNextProcessing.value = false
  }
}

async function onAgain() {
  if (tp.reshootUsedSlots.value.has(tp.currentMainIndex.value) || !tp.shootingDone.value) return
  if (!hasWebView()) return
  const idx = tp.currentMainIndex.value - 1
  const shotCountVal = shotCount.value
  shootLog(`onAgain 開始 idx=${idx} slot=${tp.currentMainIndex.value}`)
  isReshooting.value = true
  // 重拍開頭先清空舊 Live View 幀，避免殘留畫面誤導判斷（UI 會進入「等待鏡頭…」狀態）
  clearHostLiveViewDataUrl('reshoot_start')
  tp.setCoverFrameOnly(idx)
  await nextTick()
  await new Promise((r) => requestAnimationFrame(r))
  // 重拍前重新啟動 Live View，確保即時預覽會顯示（連拍結束後 C# 可能已停止推送）
  const frameBeforeRestart = liveViewFrameCount.value
  await callHost('start_liveview', {}).catch(() => {})
  await waitForLiveViewReady(frameBeforeRestart)
  // 多給第一幀一點時間穩定，避免剛切換時出現黑畫面／閃爍
  if (hostLiveViewDataUrl.value) {
    await new Promise((r) => setTimeout(r, 200))
  }
  try {
    await tp.runCountdownWithEvfAf(callHost, getCountdownOptions())
  } catch (e) {
    shootLog(`onAgain runCountdown 錯誤: ${e instanceof Error ? e.message : e}`)
  }
  let capturedMirroredUrl = ''
  if (hostLiveViewDataUrl.value) {
    try {
      capturedMirroredUrl = await tp.captureFrameFromImage(hostLiveViewDataUrl.value)
    } catch (e) {
      shootLog(`onAgain captureFrameFromImage 失敗: ${e instanceof Error ? e.message : e}`)
    }
  }
  shootLog(`onAgain 呼叫 take_one_shot_edsdk idx=${idx}`)
  try {
    const res = (await callHost('take_one_shot_edsdk', { index: idx, shotCount: shotCountVal, forceWithoutAf: getForceWithoutAf() })) as { photoUrl?: string; dataUrl?: string; thumbUrl?: string }
    const urlFromHost = res?.thumbUrl ?? res?.dataUrl ?? ''
    const url = capturedMirroredUrl || urlFromHost
    console.log('[Vue] 收到 C# 回傳 (onAgain):', { hasDataUrl: !!res?.dataUrl, dataUrlLen: res?.dataUrl?.length, photoUrl: res?.photoUrl })
    if (url) {
      // 依格號固定長度更新，避免 thumbUrls 為空或較短時 .map 無法放入補拍照片（見 debug.log burst_completed resultsLen:0）
      const next = Array.from({ length: shotCountVal }, (_, i) => (i === idx ? url : (thumbUrls.value[i] ?? '')))
      thumbUrls.value = next
      setCaptureResults([...next])
    }
  } catch (e) {
    console.error('EDSDK reshoot failed', e)
  }
  tp.reshootUsedSlots.value = new Set(
    Array.from(tp.reshootUsedSlots.value).concat(tp.currentMainIndex.value)
  )
  isReshooting.value = false
}

function onThumbClick(num: number) {
  if (!tp.shootingDone.value || isReshooting.value) return
  tp.currentMainIndex.value = num
}

/** 與原本 web-vue 一致：錯誤時可點重試（在 WebView 內會重新 start_liveview + 連拍） */
function onRetryCamera() {
  cameraError.value = null
  if (!hasWebView()) {
    cameraError.value = '請在拍貼機程式內使用相機（EDSDK）'
    return
  }
  callHost('start_liveview', {}).catch(() => {})
  startBurstShootEdsdk()
}

function hasWebView(): boolean {
  const w = typeof window !== 'undefined' ? window : null
  return !!(w && (w as unknown as { chrome?: { webview?: unknown } }).chrome?.webview)
}

/** 等版面穩定後再算左側面板位置，避免框圖／JS 尚未載完就計算導致位置錯誤（競態） */
function scheduleLeftPanelLayout() {
  return new Promise<void>((resolve) => {
    nextTick(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          doUpdateLeftPanelLeft()
          hasInitialLeft.value = true
          shootLayoutReady.value = true
          resolve()
        })
      })
    })
  })
}

onMounted(() => {
  tp.setCoverAndVideoSize(0).catch(() => {})
})

onUnmounted(() => {
  if (hasWebView()) {
    stopLiveViewWithClear('unmount').catch(() => {})
  }
})

/** 直接進入濾鏡區測試用：無相機時使用的預設預覽圖（可被 VITE_TEST_FILTER_IMAGE 覆寫） */
const DEFAULT_FILTER_TEST_IMAGE =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='300' viewBox='0 0 400 300'%3E%3Crect fill='%23666' width='400' height='300'/%3E%3Ctext x='200' y='160' text-anchor='middle' fill='%23fff' font-size='24' font-family='sans-serif'%3E測試濾鏡%3C/text%3E%3C/svg%3E"

/** 是否為「直接進入濾鏡區」測試模式（VITE_TEST_FILTER_DIRECT=1，瀏覽器可測濾鏡、不需相機） */
function isTestFilterDirect(): boolean {
  const v = String(import.meta.env.VITE_TEST_FILTER_DIRECT ?? '').trim()
  return v === '1' || v.toLowerCase() === 'true'
}

/** 防止 watch 非同步重入：同一時間只允許一組「進入拍照頁」流程，避免連拍被觸發兩次（例如拍到 8 張） */
const entryFlowRunning = ref(false)

/** 單一 watch：進入/離開拍照頁時排版、Live View、連拍（與你原本 web-vue 流程一致，改為 EDSDK 預覽+拍照） */
watch(
  () => props.isActive,
  async (active) => {
    if (!active) {
      entryFlowRunning.value = false
      shootLayoutReady.value = false
      hasInitialLeft.value = false
      thumbUrls.value = []
      tp.shootingDone.value = false
      tp.reshootUsedSlots.value = new Set()
      tp.currentMainIndex.value = 1
      showFilterOptions.value = false
      isReshooting.value = false
      isNextProcessing.value = false
      cameraError.value = null
      if (hasWebView()) stopLiveViewWithClear('deactivate').catch(() => {})
      return
    }

    if (entryFlowRunning.value) return
    entryFlowRunning.value = true

    try {
      if (isTestFilterDirect()) {
        // 標記為測試模式
        setTestSession(true)
        cameraError.value = null
        selectTemplate(templates.value[0] ?? null)
        await nextTick()
        const count = shotCount.value
        const testImage =
          String(import.meta.env.VITE_TEST_FILTER_IMAGE ?? '').trim() || DEFAULT_FILTER_TEST_IMAGE
        const urls = Array.from({ length: count }, () => testImage)
        thumbUrls.value = urls
        setCaptureResults(urls)
        tp.shootingDone.value = true
        tp.reshootUsedSlots.value = new Set()
        tp.currentMainIndex.value = 1
        showFilterOptions.value = true
        try {
          await tp.setCoverAndVideoSize(0)
          await scheduleLeftPanelLayout()
        } catch {
          shootLayoutReady.value = true
        }
        return
      }

      if (!hasWebView()) {
        cameraError.value = '請在拍貼機程式內使用相機（EDSDK）'
        return
      }
      cameraError.value = null
      await callHost('start_liveview', {}).catch(() => {})

      if (!selectedTemplate.value) {
        await nextTick()
      }

      try {
        if (!hasInitialLeft.value) {
          shootLayoutReady.value = false
          await tp.setCoverAndVideoSize(0)
          await scheduleLeftPanelLayout()
        } else {
          shootLayoutReady.value = true
        }
      } catch {
        shootLayoutReady.value = true
      }

      const count = shotCount.value
      const onlyHalfPress = String(import.meta.env.VITE_SHOOT_ONLY_HALF_PRESS ?? '') === '1' || String(import.meta.env.VITE_SHOOT_ONLY_HALF_PRESS ?? '').toLowerCase() === 'true'
      const existing = captureResults.value
      if (!onlyHalfPress && existing.length >= count) {
        thumbUrls.value = existing.slice(0, count)
        tp.shootingDone.value = true
        tp.reshootUsedSlots.value = new Set()
        tp.currentMainIndex.value = 1
        showFilterOptions.value = false
        return
      }

      if (onlyHalfPress) {
        setTimeout(() => callHost('half_press_shutter', {}).catch(() => {}), 2000)
        await new Promise((r) => setTimeout(r, 1200))
        if (!props.isActive) return
        setTimeout(() => startBurstShootEdsdk(), 0)
        return
      }

      try {
        await tp.setCoverAndVideoSize(0)
      } catch {
        /* 框圖載入失敗仍繼續連拍 */
      }
      await new Promise((r) => setTimeout(r, 1200))
      if (!props.isActive) return
      startBurstShootEdsdk()
    } finally {
      entryFlowRunning.value = false
    }
  },
  { immediate: true }
)
</script>

<template>
  <div
    ref="shootRootRef"
    :class="shootRootClass"
    :style="shootRootStyle"
    role="region"
    aria-label="拍照畫面"
  >
    <div class="screen-shoot-content" :class="{ 'is-reshooting': isReshooting, 'is-ready': shootLayoutReady || !!cameraError, 'is-filter-mode': showFilterOptions }">

      <!-- <div class="test-red"></div> -->

      <div
        ref="leftPanelRef"
        class="left-panel"
        :class="{
          'absolute-panel': !showFilterOptions,
          'is-filter-mode': showFilterOptions,
          'is-positioned': shootLayoutReady,
        }"
        :style="leftPanelStyle"
      >
      </div>
      <div class="right-panel">
        <img
          class="choosetext-img"
          src="/assets/templates/ShootPage/Readtext.png"
          alt="請看上方鏡頭"
        />
        <div
          ref="pictureAreaRef"
          class="picture-area"
          :class="{ 'is-preview': tp.shootingDone.value && !isReshooting }"
          :style="pictureAreaStyle"
        >
          <!-- 相機錯誤時顯示（非 WebView 或 EDSDK 失敗），與原本 web-vue 排版一致 -->
          <div
            v-if="cameraError"
            class="shoot-camera-error"
            role="alert"
          >
            <p class="shoot-camera-error__msg">{{ cameraError }}</p>
            <button
              type="button"
              class="shoot-camera-error__retry"
              @click="onRetryCamera"
            >
              重試
            </button>
          </div>
          <div class="cover" :style="coverStyle" aria-hidden="true" />
          <!-- 預覽與拍照皆由 C# 推送：EDSDK Live View 即時預覽、拍完顯示選中照片；重拍時也要顯示 Live View -->
          <img
            v-show="hostLiveViewDataUrl && (!tp.shootingDone.value || isReshooting)"
            class="host-live-view-img"
            :src="hostLiveViewDataUrl"
            alt="即時預覽"
          />
          <!-- 倒數層放在 Live View 之上，確保數字可見 -->
          <div
            v-show="tp.countdownVisible.value && countdownDisplay"
            class="shoot-countdown"
            aria-hidden="true"
          >
            {{ countdownDisplay }}
          </div>
          <div
            v-show="hasWebView() && !hostLiveViewDataUrl && (!tp.shootingDone.value || isReshooting)"
            class="shoot-waiting"
            aria-hidden="true"
          >
            等待鏡頭…
          </div>
          <!-- 只半按模式：有畫面後可手動觸發倒數＋拍照 -->
          <button
            v-show="onlyHalfPressMode && hostLiveViewDataUrl && !tp.shootingDone.value && !tp.isBurstShooting.value"
            type="button"
            class="shoot-start-countdown-btn"
            @click="startBurstShootEdsdk"
          >
            開始倒數拍照
          </button>
          <img
            ref="mainPreviewImgRef"
            v-show="tp.shootingDone.value && !isReshooting"
            class="shoot-main-preview"
            :src="mainPreviewUrl"
            alt="預覽"
          />
        </div>
        <div
          class="btns shoot-btns"
          :class="{
            'is-visible': tp.shootingDone.value && !isReshooting,
            'is-reshooting': isReshooting,
          }"
        >
          <button
            type="button"
            class="again-btn shoot-btn"
            :class="{ 'is-hidden': tp.reshootUsedSlots.value.has(tp.currentMainIndex.value) }"
            @click="onAgain"
          />
          <button
            type="button"
            class="next-btn shoot-btn"
            :class="{ 'is-disabled': isNextProcessing }"
            :disabled="isNextProcessing"
            @click="handleNextClick"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
@use '@/styles/variables' as *;
@use '@/styles/mixins' as *;

/* 根節點會依版型帶入 .screen--shoot--bk01 / .screen--shoot--bk02 等，可依此重寫各版型 CSS */
/* 另有 CSS 變數：--shoot-capture-w, --shoot-capture-h, --shoot-shot-count（來自 selectedTemplate） */
.screen--shoot {
  position: relative;
  // background-color: #ff4d4f;
  width: 100%;
  height: 100vh;
  background-image: url('#{$path-templates}/ShootPage/background.png');

  &.is-reshooting {
    pointer-events: none;
    user-select: none;
  }

  .shoot-countdown {
    position: absolute;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    z-index: 100;
    font-size: 120px;
    font-weight: bold;
    color: #fff;
    text-shadow: 0 4px 20px rgba(0, 0, 0, 0.8);
    pointer-events: none;

    &.is-visible {
      visibility: visible;
    }
  }

  .screen-shoot-content {
    display: flex;
    width: 100%;
    height: 100%;
    justify-content: center;
    opacity: 0;
    transition: opacity 0.2s ease;
    &.is-ready {
      opacity: 1;
    }

    &.is-reshooting {
      pointer-events: none;
      user-select: none;
    }
  }

  .left-panel {
    // width: 1000px;
    margin-right: 50px;
    height: 100%;
    display: flex;
    justify-content: flex-end;
    position: relative;
    gap: 36px;
    // padding-top: 100px;
  }
  .absolute-panel {
    justify-content: flex-start;

    width: auto;
    // background-color: #ff4d4f;
    position: absolute;
    /* left 只算一次（leftPanelStyle），之後不再更新 */
    opacity: 0;
    transition: opacity 0.15s ease-out;

    &.is-positioned {
      opacity: 1;
    }
  }

  /* 進入濾鏡時移除 absolute 排版，恢復一般 flow，確保濾鏡列表可見 */
  .left-panel.is-filter-mode {
    position: relative;
    left: auto;
    justify-content: flex-end;
    opacity: 1;
    min-width: 280px; /* 濾鏡列表約 250px + 間距，避免被壓成 0 寬 */
  }

  .filter-list-wrap {
    padding-top: 50px;
    display: flex;
    // position: absolute;
    // left: 20px;
    // top: 180px;
    // z-index: 10;
  }

  .thumb-wrapper {
    padding-top: 100px;
    display: flex;
    flex-direction: column;
    // justify-content: center;
    align-items: center;
    gap: 24px;
    // position: absolute;
    // top: 135px;
    // left: 299px;
    // width: 100%;
    // height: 100%;
    // display: flex;
    // flex-direction: column;
    // gap: $spacing-md;
  }

  .thumb-frame {
    cursor: pointer;
    outline: none;

    &.is-selected {
      outline: 4px solid #ff4d4f;
      outline-offset: 2px;
    }

    .thumb-frame__wrap {
      background-color: bisque;
      position: relative;
      display: flex;
      flex-shrink: 0;
      /* 寬高由 thumbWrapStyle 依框圖比例決定，與右側大圖一致 */

      /* 與右側大圖一致：照片填滿框、無白邊；cover 避免正方形版型（bk03）上下留白 */
      .shoot-page {
        display: block;
        width: 100%;
        height: 100%;
        object-fit: cover;
        object-position: center;
        background-color: white;

        /* 左側縮圖顯示即時 Live View 時也做水平鏡像，與主預覽一致 */
        &.shoot-page--live-view-mirror {
          transform: scaleX(-1);
        }
      }

      .thumb-frame__cover {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
        background-size: contain;
        background-position: center;
        background-repeat: no-repeat;
      }
    }




  }

  .right-panel {
    // width: 100%;
    // background-color: aqua;
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-direction: column;
    padding: 12px 0px 60px 0px;
    gap: 12px;
    min-width: 0;

    h1 {
      font-size: 72px;
      text-align: center;
      padding: 0px;
      margin: 0px;
    }

    .Readtext-img {
      max-width: 100%;
      width: auto;
      height: auto;
      display: block;
      margin: 0;
    }
  }

  .screen-shoot-content.is-filter-mode .right-panel {
    // flex: 1;
    min-width: 0;
  }

  .screen-shoot-content.is-filter-mode .picture-area {
    flex-shrink: 1;
    min-width: 0;
  }

  .picture-area {
    position: relative;
    display: flex;
    align-items: center;
    overflow: hidden;
    flex-shrink: 0;

    .shoot-camera-error {
      position: absolute;
      inset: 0;
      z-index: 50;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: $spacing-lg;
      padding: $spacing-xl;
      background: rgba(0, 0, 0, 0.75);
      color: #fff;
      text-align: center;
    }

    .shoot-camera-error__msg {
      margin: 0;
      font-size: 18px;
      line-height: 1.5;
      max-width: 360px;
    }

    .shoot-camera-error__retry {
      padding: 10px 24px;
      font-size: 16px;
      color: #fff;
      background: $color-accent;
      border: none;
      border-radius: $radius-md;
      cursor: pointer;

      &:hover {
        opacity: 0.9;
      }
    }

    .shoot-waiting {
      position: absolute;
      inset: 0;
      z-index: 2;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
      font-size: 24px;
      background: rgba(0, 0, 0, 0.5);
    }

    .shoot-start-countdown-btn {
      position: absolute;
      left: 50%;
      bottom: 120px;
      transform: translateX(-50%);
      z-index: 15;
      padding: 16px 40px;
      font-size: 24px;
      font-weight: bold;
      color: #fff;
      background: var(--accent, #ff4d4f);
      border: none;
      border-radius: 12px;
      cursor: pointer;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);

      &:hover {
        opacity: 0.95;
      }
    }

    .cover {
      display: block;
    }

    /* 拍完後外匡仍顯示（原圖＋框兩層） */
    &.is-preview .cover {
      display: block;
    }

    /* 大圖與框同尺寸：讀取框圖大小決定容器，cover 填滿遮罩、避免正方形版型（bk03）上下留白 */
    .shoot-main-preview {
      display: none;
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
      object-position: center;
    }

    &.is-preview .shoot-main-preview {
      display: block;
    }

    .cover {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      z-index: 9;
      background-position: center;
      background-repeat: no-repeat;
      background-size: contain;
      pointer-events: none;
    }

    /* EDSDK Live View 由 C# 推送；前端水平鏡像顯示，與拍照擷取結果一致 */
    .host-live-view-img {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
      object-position: center;
      z-index: 2;
      transform: scaleX(-1);
    }
  }

  .btns.shoot-btns {
    visibility: hidden;

    &.is-visible {
      visibility: visible;
    }

    &.is-reshooting {
      visibility: hidden !important;
      pointer-events: none;
    }

    /* 重拍隱藏時只用 visibility 保留佔位；禁止 display:none，避免下一步按鈕位移（勿用行內 style） */
    .again-btn.is-hidden {
      display: block !important;
      visibility: hidden !important;
      pointer-events: none;
    }
  }

  .btns {
    width: 1000px;
    padding: 0px 30px;

    // width: 1000px;
    // position: absolute;
    // bottom: 70px;
    // left: 690px;
    display: flex;
    justify-content: space-between;

    .shoot-btn {
      width: 410px;
      height: 100px;
      border: none;
      background: none;
      outline: none;
      box-shadow: none;
      appearance: none;
      -webkit-appearance: none;
      background-repeat: no-repeat;
    }

    .again-btn {
      background-image: url('#{$path-templates}/ShootPage/reshoot.png');
    }

    .next-btn {
      background-image: url('#{$path-templates}/ShootPage/nextbutton.png');
      cursor: pointer;

      &.is-disabled,
      &:disabled {
        cursor: not-allowed;
        opacity: 0.6;
        pointer-events: none;
      }
    }
  }
}


.test-red {
  width: 50%;
  height: 100%;
  background-color: #ff4d4f;
position: absolute;
}
</style>
