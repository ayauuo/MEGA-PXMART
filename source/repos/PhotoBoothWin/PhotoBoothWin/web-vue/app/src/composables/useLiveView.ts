import { ref } from 'vue'

/** 單例：C# 推送的 EDSDK Live View 幀 dataUrl，供拍照頁顯示 */
const hostLiveViewDataUrl = ref('')
/** 除錯用：已收到的幀數，畫面上可顯示「已收到 N 幀」確認即時串流有進來 */
const liveViewFrameCount = ref(0)

export function useLiveView() {
  function setHostLiveViewDataUrl(url: string) {
    hostLiveViewDataUrl.value = url
    liveViewFrameCount.value += 1
  }

  function clearHostLiveViewDataUrl(_reason?: string) {
    hostLiveViewDataUrl.value = ''
  }

  return {
    hostLiveViewDataUrl,
    liveViewFrameCount,
    setHostLiveViewDataUrl,
    clearHostLiveViewDataUrl,
  }
}
