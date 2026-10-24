// The static HTML remains the fallback when the optional runtime service is offline.
// The endpoint is same-origin and no-store: no private GitHub token is exposed here.
(() => {
  const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('ryuchan-runtime') : null
  const safeImage = value => typeof value === 'string' && (value.startsWith('/') && !value.startsWith('//') || /^https:\/\/[^/@]+/i.test(value))
  const setImages = (field, value) => {
    if (!safeImage(value)) return
    document.querySelectorAll(`[data-runtime-image="${field}"]`).forEach(node => { node.src = value })
  }
  const setText = (field, value) => {
    if (typeof value !== 'string') return
    document.querySelectorAll(`[data-runtime-text="${field}"]`).forEach(node => { node.textContent = value })
  }
  const setLinks = (field, value) => {
    if (!safeImage(value)) return
    document.querySelectorAll(`[data-runtime-link="${field}"]`).forEach(node => { node.href = value })
  }
  function apply(config) {
    if (!config || !config.site || !config.user) return
    const { site, user } = config
    setImages('user.avatar', user.avatar)
    setImages('user.qr_wechat', user.qr_wechat)
    setImages('user.qr_alipay', user.qr_alipay)
    setImages('user.title_image', user.title_image)
    setText('user.name', user.name)
    setText('user.description', user.description)
    setText('site.title', site.title)
    setLinks('user.site', user.site)
    if (safeImage(site.favicon)) {
      document.querySelectorAll('link[rel="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"], link[rel="apple-touch-icon-precomposed"]').forEach(node => { node.href = site.favicon })
    }
    if (typeof site.tab === 'string' && document.body?.dataset.runtimePageTitle) {
      document.title = `${document.body.dataset.runtimePageTitle} - ${site.tab}`
    }
    if (typeof site.description === 'string') {
      document.querySelectorAll('meta[name="description"],meta[property="og:description"],meta[property="twitter:description"]').forEach(node => { node.content = site.description })
    }
    document.querySelectorAll('[data-runtime-brand]').forEach(brand => {
      if (site.title_type === 'image' && safeImage(user.title_image)) {
        let img = brand.querySelector('img')
        if (!img) {
          img = document.createElement('img')
          img.className = 'h-12 md:h-14 w-auto object-contain'
          brand.replaceChildren(img)
        }
        img.src = user.title_image
        img.alt = site.title || ''
      } else if (typeof site.title === 'string') {
        let label = brand.querySelector('[data-runtime-text="site.title"]')
        if (!label) {
          label = document.createElement('span')
          label.className = 'text-3xl font-bold tracking-tight text-primary'
          label.dataset.runtimeText = 'site.title'
          brand.replaceChildren(label)
        }
        label.textContent = site.title
      }
    })
  }
  async function refresh() {
    try {
      const response = await fetch('/__runtime/config', { cache: 'no-store' })
      if (!response.ok) return
      const document = await response.json()
      apply(document.config)
    } catch (_) { /* Deployed static content is the offline fallback. */ }
  }
  document.addEventListener('astro:page-load', refresh)
  window.addEventListener('ryuchan:runtime-config-updated', () => {
    refresh()
    channel?.postMessage('updated')
  })
  channel?.addEventListener('message', refresh)
  refresh()
})()
