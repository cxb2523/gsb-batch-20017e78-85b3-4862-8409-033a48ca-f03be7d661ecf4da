import gsap from "gsap"

/**
 * 加载遮罩状态机
 *
 *   loading -> ready   淡出并 display:none
 *   loading -> error   保持可见，展示可读的失败提示
 *   error   -> loading 重新开始一次装配
 *
 * 遮罩的显隐只由 createSceneRig 的结算结果驱动，不依赖任何单个 loader 的回调，
 * 因此不会出现“部分资源失败后永久黑屏”的静默卡死。
 */
export function createLoadingOverlay(options) {
  const root = options.root
  const messageEl = options.message
  const detailEl = options.detail
  const retryEl = options.retry
  const onRetry = options.onRetry || function () {}

  if (!root) throw new Error("createLoadingOverlay: options.root is required")

  let state = "loading"

  function setText(el, text) {
    if (el) el.textContent = text || ""
  }

  function setState(next) {
    state = next
    root.dataset.state = next
  }

  function showLoading(payload) {
    gsap.killTweensOf(root)
    root.style.opacity = "1"
    root.style.display = "flex"
    setState("loading")
    setText(messageEl, (payload && payload.message) || "正在加载锦鲤池…")
    setText(detailEl, "")
    if (retryEl) retryEl.hidden = true
  }

  function showReady() {
    if (state === "error") return
    gsap.killTweensOf(root)
    setState("ready")
    setText(messageEl, "")
    setText(detailEl, "")
    gsap.to(root, {
      opacity: 0,
      duration: 1,
      onComplete: () => {
        // 淡出过程中若又发生重建，新的 showLoading 已经重置了 display，这里不再覆盖
        if (state === "ready") gsap.set(root, { display: "none" })
      },
    })
  }

  function showError(payload) {
    const info = payload || {}
    gsap.killTweensOf(root)
    root.style.display = "flex"
    root.style.opacity = "1"
    setState("error")
    setText(messageEl, info.message || "资源加载失败，场景未能完成加载")
    setText(detailEl, (info.details || []).join("\n"))
    if (retryEl) retryEl.hidden = false
  }

  if (retryEl) {
    retryEl.addEventListener("click", () => onRetry())
  }

  return {
    showLoading,
    showReady,
    showError,
    getState: () => state,
    element: root,
  }
}
