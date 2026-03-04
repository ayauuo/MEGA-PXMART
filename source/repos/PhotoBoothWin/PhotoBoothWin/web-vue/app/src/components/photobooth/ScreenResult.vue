<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from 'vue'
import { usePhotobooth } from '@/composables/usePhotobooth'

const {
  currentScreen,
  finalFilePath,
  resultDisplayUrl,
  selectedTemplate,
  showScreen,
  callHost,
  resetSession,
  autoPrint,
  isTestSession,
} = usePhotobooth()

const copies = ref(1)
const autoGoTimer = ref<ReturnType<typeof setTimeout> | null>(null)

function getResultAutoPrintSec(): number {
  const raw = import.meta.env.VITE_RESULT_AUTO_PRINT_SEC
  if (raw === undefined || raw === '') return 60
  const n = parseInt(raw, 10)
  return Number.isNaN(n) || n < 1 ? 60 : Math.min(300, n)
}

function getPrintingShowSec(): number {
  const raw = import.meta.env.VITE_PRINTING_SHOW_SEC
  if (raw === undefined || raw === '') return 21
  const n = parseInt(raw, 10)
  const base = Number.isNaN(n) || n < 1 ? 20 : Math.min(120, n)
  return Math.min(120, base + 1)
}

function getSkipPrint(): boolean {
  const v = import.meta.env.VITE_SKIP_PRINT
  return v === '1' || String(v).toLowerCase() === 'true'
}

function getReceiptAmount(): string {
  const v = import.meta.env.VITE_RECEIPT_AMOUNT
  return typeof v === 'string' && v !== '' ? v : '0'
}

function getLogPrintRecordWhenSkip(): boolean {
  const v = import.meta.env.VITE_LOG_PRINT_RECORD_WHEN_SKIP
  return v === '1' || String(v).toLowerCase() === 'true'
}

function getProjectName(): string {
  const v = import.meta.env.VITE_PROJECT_NAME
  return typeof v === 'string' ? v : ''
}

function getMachineName(): string {
  const v = import.meta.env.VITE_MACHINE_NAME
  return typeof v === 'string' ? v : ''
}

function getIsTest(): boolean {
  // 只要是從測試相關按鈕進來的流程，前端會把 isTestSession 設為 true
  // 若沒有 session 旗標，才退回檢查 env（相容舊的測試方式）
  if (isTestSession.value) return true
  const v = import.meta.env.VITE_TEST_FAST_COUNTDOWN
  return v === '1' || String(v).toLowerCase() === 'true'
}

function getFinalFileName(): string {
  const path = finalFilePath.value
  if (!path) return ''
  return path.replace(/^.*[/\\]/, '') || ''
}

function clearAutoGoTimer() {
  if (autoGoTimer.value != null) {
    clearTimeout(autoGoTimer.value)
    autoGoTimer.value = null
  }
}

/** 進入列印中 → 送 DNP（若未設 VITE_SKIP_PRINT）→ 寫入列印紀錄 CSV → 顯示 N 秒後回待機並還原 */
function goToPrintingThenIdle() {
  const printingSec = getPrintingShowSec()
  const skipPrint = getSkipPrint()
  showScreen('processing')
  if (!finalFilePath.value) {
    setTimeout(() => { autoPrint.value = false; resetSession(); showScreen('idle') }, printingSec * 1000)
    return
  }
  if (skipPrint) {
    if (getLogPrintRecordWhenSkip()) {
      callHost('log_print_record', {
        templateName: selectedTemplate.value?.id ?? 'unknown',
        printTime: new Date().toISOString(),
        amount: getReceiptAmount(),
        projectName: getProjectName(),
        machineName: getMachineName(),
        copies: 1,
        fileName: getFinalFileName(),
        isTest: getIsTest(),
      }).finally(() => {
        setTimeout(() => { autoPrint.value = false; resetSession(); showScreen('idle') }, printingSec * 1000)
      })
    } else {
      setTimeout(() => { autoPrint.value = false; resetSession(); showScreen('idle') }, printingSec * 1000)
    }
    return
  }
  callHost('print_hotfolder', {
    filePath: finalFilePath.value,
    sizeKey: selectedTemplate.value?.sizeKey ?? '4x6',
    copies: 1,
  })
    .then(() =>
      callHost('log_print_record', {
        templateName: selectedTemplate.value?.id ?? 'unknown',
        printTime: new Date().toISOString(),
        amount: getReceiptAmount(),
        projectName: getProjectName(),
        machineName: getMachineName(),
        copies: copies.value,
        fileName: getFinalFileName(),
        isTest: getIsTest(),
      })
    )
    .finally(() => {
      setTimeout(() => {
        autoPrint.value = false
        resetSession()
        showScreen('idle')
      }, printingSec * 1000)
    })
}

// 結果頁：有合成結果時啟動 N 秒（ENV）自動列印，沒按就自動進列印中（需 VITE_SKIP_PRINT=0 才會真的送 DNP）
watch(
  [() => currentScreen.value, () => finalFilePath.value],
  ([screen, path]) => {
    clearAutoGoTimer()
    if (screen !== 'result' || !path) return
    const sec = getResultAutoPrintSec()
    autoGoTimer.value = setTimeout(() => {
      autoGoTimer.value = null
      goToPrintingThenIdle()
    }, sec * 1000)
  },
  { immediate: true }
)

onBeforeUnmount(clearAutoGoTimer)

async function onPrint() {
  if (!finalFilePath.value) return
  clearAutoGoTimer()
  const skipPrint = getSkipPrint()
  let c = copies.value
  if (Number.isNaN(c)) c = 1
  copies.value = Math.min(5, Math.max(1, c))
  const printingSec = getPrintingShowSec()
  showScreen('processing')
  if (skipPrint) {
    if (getLogPrintRecordWhenSkip()) {
      await callHost('log_print_record', {
        templateName: selectedTemplate.value?.id ?? 'unknown',
        printTime: new Date().toISOString(),
        amount: getReceiptAmount(),
        projectName: getProjectName(),
        machineName: getMachineName(),
        copies: copies.value,
        fileName: getFinalFileName(),
        isTest: getIsTest(),
      })
    }
    autoPrint.value = false
    resetSession()
    setTimeout(() => showScreen('idle'), printingSec * 1000)
    return
  }
  await callHost('print_hotfolder', {
    filePath: finalFilePath.value,
    sizeKey: selectedTemplate.value?.sizeKey ?? '4x6',
    copies: copies.value,
  })
  await callHost('log_print_record', {
    templateName: selectedTemplate.value?.id ?? 'unknown',
    printTime: new Date().toISOString(),
    amount: getReceiptAmount(),
    projectName: getProjectName(),
    machineName: getMachineName(),
    copies: copies.value,
    fileName: getFinalFileName(),
    isTest: getIsTest(),
  })
  autoPrint.value = false
  resetSession()
  setTimeout(() => showScreen('idle'), printingSec * 1000)
}
</script>

<template>
  <div class="screen screen--result" role="region" aria-label="結果畫面">
    <div class="result-wrap">
      <div class="result-preview">
        <img id="final-preview" alt="final preview" :src="resultDisplayUrl" />
      </div>
      <div class="right-panel">
        <div class="btns">
          <button type="button" class="print-btn" @click="onPrint">
            <img src="/assets/templates/QRcodePage/printbutton.png" alt="確認儲存完畢" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
@use '@/styles/variables' as *;

.screen--result {
  display: flex;
  flex-direction: row;
  width: 100%;
  // background-color: bisque;
  min-height: 100vh;
  background-image: url('#{$path-templates}/QRcodePage/background.png');
  background-repeat: no-repeat;
  background-position: center center;
  background-size: cover;
  padding: $spacing-5xl;
}

.result-wrap {
  display: flex;
  // flex-direction: row;
  // flex: 1;
  // align-items: center;
  // justify-content: center;
  gap: $spacing-4xl;
  max-width: 1600px;
  margin: 0 auto;
  width: 100%;
}

.result-preview {
  width: 50%;
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;

  img {
    max-width: 100%;
    max-height: calc(100vh - 80px);
    width: auto;
    height: auto;
    object-fit: contain;
    display: block;
  }
}

.right-panel {
  width: 50%;
  padding-top: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.print-btn {
  display: block;
  width: 650px;
  padding: 0;
  border: none;
  background: none;
  cursor: pointer;

  img {
    width: 100%;
    height: auto;
    display: block;
  }
}

/* 未來若要按鈕跳動可啟用
.print-btn--pulse {
  animation: print-btn-pulse 1.5s ease-in-out infinite;
}

@keyframes print-btn-pulse {
  0%,
  100% {
    transform: scale(1);
    opacity: 1;
  }
  50% {
    transform: scale(1.04);
    opacity: 0.95;
  }
}
*/
</style>
