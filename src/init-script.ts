/**
 * 注入页面的 UI 事件采集脚本(独立于 session.ts, 便于单独阅读与维护)。
 *
 * 捕获阶段监听 click/change/submit, 经 context.exposeBinding 暴露的
 * __huafengRecordUIEvent 回传; 脚本开头的 __huafengRecorderInstalled 守卫保证
 * 同一文档只安装一次(attach 模式会对已加载页面直接 evaluate 补装)。
 */
export const INIT_SCRIPT = `(() => {
  if (window.__huafengRecorderInstalled) return
  window.__huafengRecorderInstalled = true
  const send = (p) => {
    try {
      if (window.__huafengRecordUIEvent) window.__huafengRecordUIEvent(p)
    } catch (e) { /* 绑定不可用时静默丢弃 */ }
  }
  const selectorOf = (el) => {
    const parts = []
    let cur = el
    while (cur && cur.tagName && parts.length < 5) {
      let part = cur.tagName.toLowerCase()
      if (cur.id) {
        parts.unshift(part + '#' + cur.id)
        break
      }
      if (typeof cur.className === 'string' && cur.className.trim()) {
        part += '.' + cur.className.trim().split(/\\s+/).slice(0, 2).join('.')
      }
      parts.unshift(part)
      cur = cur.parentElement
    }
    return parts.join(' > ')
  }
  const labelOf = (el) =>
    (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || '')
      .replace(/\\s+/g, ' ')
      .trim()
      .slice(0, 80)
  document.addEventListener('click', (e) => {
    const raw = e.target
    if (!raw || !raw.tagName) return
    const el = raw.closest ? raw.closest('button, a, [role="button"], input, select, textarea, [onclick]') || raw : raw
    send({
      kind: 'click',
      selector: selectorOf(el),
      tag: (el.tagName || '').toLowerCase(),
      text: labelOf(el) || undefined,
      x: Math.round(e.clientX),
      y: Math.round(e.clientY),
    })
  }, true)
  document.addEventListener('change', (e) => {
    const el = e.target
    if (!el || !el.tagName) return
    const isPassword = el.type === 'password'
    send({
      kind: 'change',
      selector: selectorOf(el),
      tag: el.tagName.toLowerCase(),
      name: el.name || undefined,
      value: isPassword ? undefined : String(el.value == null ? '' : el.value).slice(0, 200),
      redacted: isPassword || undefined,
    })
  }, true)
  document.addEventListener('submit', (e) => {
    const el = e.target
    if (!el || !el.tagName) return
    send({ kind: 'submit', selector: selectorOf(el) })
  }, true)
})()`
