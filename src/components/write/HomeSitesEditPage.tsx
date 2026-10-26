'use client'

import { useEffect, useRef, useState } from 'react'
import { toast, Toaster } from 'sonner'
import { useAuthStore } from './hooks/use-auth'
import { readFileAsText } from '@/lib/file-utils'
import { loadHomeSitesFromGitHub, saveHomeSitesToGitHub } from './services/home-sites-service'
import type { HomeSite } from '@/interface/home-site'

type Props = {
  initialSites?: HomeSite[]
}

type PendingAvatar = { file: File; previewUrl: string }

function cloneSites(sites: HomeSite[]): HomeSite[] {
  return JSON.parse(JSON.stringify(sites))
}

function emptySite(): HomeSite {
  return { name: '', url: '', description: '', avatar: '', badge: '' }
}

export default function HomeSitesEditPage({ initialSites = [] }: Props) {
  const [sites, setSites] = useState<HomeSite[]>(initialSites)
  const [originalSites, setOriginalSites] = useState<HomeSite[]>(cloneSites(initialSites))
  const [pendingAvatars, setPendingAvatars] = useState<Record<number, PendingAvatar>>({})
  const [saving, setSaving] = useState(false)
  const [loadingRemote, setLoadingRemote] = useState(false)
  const { isAuth, setPrivateKey } = useAuthStore()

  // 表单弹窗状态
  const [showForm, setShowForm] = useState(false)
  const [editIndex, setEditIndex] = useState<number | null>(null)
  const [form, setForm] = useState<HomeSite>(emptySite())
  const [formPreview, setFormPreview] = useState('')
  const [formFile, setFormFile] = useState<File | null>(null)

  const keyInputRef = useRef<HTMLInputElement>(null)
  const avatarInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    return () => {
      Object.values(pendingAvatars).forEach(({ previewUrl }) => URL.revokeObjectURL(previewUrl))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const hasChanges = () => {
    if (Object.keys(pendingAvatars).length > 0) return true
    return JSON.stringify(sites) !== JSON.stringify(originalSites)
  }

  const clearPendingAvatars = () => {
    Object.values(pendingAvatars).forEach(({ previewUrl }) => URL.revokeObjectURL(previewUrl))
    setPendingAvatars({})
  }

  const handleImportKey = () => keyInputRef.current?.click()

  const onChoosePrivateKey = async (file: File) => {
    const pem = await readFileAsText(file)
    setPrivateKey(pem)
    toast.success('密钥导入成功')
  }

  // ====== 添加 / 编辑弹窗 ======
  const openAdd = () => {
    setEditIndex(null)
    setForm(emptySite())
    setFormPreview('')
    setFormFile(null)
    setShowForm(true)
  }

  const openEdit = (index: number) => {
    setEditIndex(index)
    setForm({ ...emptySite(), ...sites[index] })
    setFormPreview(pendingAvatars[index]?.previewUrl || sites[index].avatar || '')
    setFormFile(null)
    setShowForm(true)
  }

  const closeForm = () => {
    if (formFile && formPreview.startsWith('blob:')) URL.revokeObjectURL(formPreview)
    setShowForm(false)
    setFormFile(null)
    setFormPreview('')
    setEditIndex(null)
  }

  const chooseAvatar = () => avatarInputRef.current?.click()

  const onAvatarFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (!file.type.startsWith('image/')) {
      toast.error('请选择图片文件')
      if (e.currentTarget) e.currentTarget.value = ''
      return
    }
    if (formFile && formPreview.startsWith('blob:')) URL.revokeObjectURL(formPreview)
    setFormFile(file)
    setFormPreview(URL.createObjectURL(file))
    if (e.currentTarget) e.currentTarget.value = ''
  }

  const onAvatarUrlChange = (value: string) => {
    if (formFile && formPreview.startsWith('blob:')) URL.revokeObjectURL(formPreview)
    setFormFile(null)
    setFormPreview(value)
    setForm((prev) => ({ ...prev, avatar: value }))
  }

  const submitForm = () => {
    const name = form.name.trim()
    let url = form.url.trim()
    if (!name) {
      toast.error('请填写模块名称')
      return
    }
    if (!url) {
      toast.error('请填写跳转链接')
      return
    }
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`

    const site: HomeSite = {
      name,
      url,
      description: (form.description || '').trim(),
      badge: (form.badge || '').trim(),
      avatar: formFile ? formPreview : (form.avatar || '').trim(),
    }

    const index = editIndex === null ? sites.length : editIndex
    const nextSites = [...sites]
    if (editIndex === null) nextSites.push(site)
    else nextSites[editIndex] = site
    setSites(nextSites)

    // 记录待上传的图标（保存时统一上传）
    setPendingAvatars((prev) => {
      const next = { ...prev }
      if (formFile) {
        next[index] = { file: formFile, previewUrl: formPreview }
      } else {
        if (next[index]) URL.revokeObjectURL(next[index].previewUrl)
        delete next[index]
      }
      return next
    })

    setShowForm(false)
    setFormFile(null)
    setFormPreview('')
    setEditIndex(null)
  }

  // ====== 删除 ======
  const handleDelete = (index: number) => {
    if (!window.confirm(`确定要删除模块 "${sites[index].name || '(未命名)'}" 吗？`)) return
    const nextSites = [...sites]
    nextSites.splice(index, 1)
    setSites(nextSites)
    setPendingAvatars((prev) => {
      const next: Record<number, PendingAvatar> = {}
      for (const [keyStr, value] of Object.entries(prev)) {
        const key = Number.parseInt(keyStr, 10)
        if (key === index) {
          URL.revokeObjectURL(value.previewUrl)
        } else if (key > index) {
          next[key - 1] = value
        } else {
          next[key] = value
        }
      }
      return next
    })
  }

  const moveSite = (index: number, direction: -1 | 1) => {
    const target = index + direction
    if (target < 0 || target >= sites.length) return
    const nextSites = [...sites]
    ;[nextSites[index], nextSites[target]] = [nextSites[target], nextSites[index]]
    setSites(nextSites)
    setPendingAvatars((prev) => {
      const next = { ...prev }
      const a = next[index]
      const b = next[target]
      delete next[index]
      delete next[target]
      if (b) next[index] = b
      if (a) next[target] = a
      return next
    })
  }

  // ====== 保存 / 重置 / 刷新 ======
  const handleSave = async () => {
    if (!isAuth) {
      toast.error('请先导入 GitHub App 私钥后再保存')
      handleImportKey()
      return
    }
    if (sites.some((site) => !site.name.trim() || !site.url.trim())) {
      toast.error('每个模块都需要填写名称和链接')
      return
    }
    try {
      setSaving(true)
      const saved = await saveHomeSitesToGitHub(sites, pendingAvatars)
      clearPendingAvatars()
      setSites(saved)
      setOriginalSites(cloneSites(saved))
    } catch {
      // 错误提示由 service 处理
    } finally {
      setSaving(false)
    }
  }

  const handleReset = () => {
    if (hasChanges() && !window.confirm('有未保存的更改，确定要放弃吗？')) return
    clearPendingAvatars()
    setSites(cloneSites(originalSites))
  }

  const handleReloadRemote = async () => {
    if (!isAuth) {
      toast.error('请先导入 GitHub App 私钥后再刷新')
      handleImportKey()
      return
    }
    if (hasChanges() && !window.confirm('刷新会丢弃未保存的更改，确定继续吗？')) return
    try {
      setLoadingRemote(true)
      const remote = await loadHomeSitesFromGitHub()
      clearPendingAvatars()
      setSites(remote)
      setOriginalSites(cloneSites(remote))
      toast.success(`已从内容仓库读取 ${remote.length} 个模块`)
    } catch (error: any) {
      toast.error('读取失败', { description: error?.message || '请稍后重试' })
    } finally {
      setLoadingRemote(false)
    }
  }

  // ====== 渲染 ======
  return (
    <>
      <Toaster
        richColors
        position="top-center"
        toastOptions={{
          className: 'shadow-xl rounded-2xl border-2 border-primary/20 backdrop-blur-sm',
          style: {
            fontSize: '1rem',
            padding: '14px 20px',
            borderRadius: '12px',
            boxShadow: '0 10px 40px rgba(0, 0, 0, 0.15)',
          },
          duration: 5000,
        }}
      />

      {/* 私钥文件 */}
      <input
        ref={keyInputRef}
        type="file"
        accept=".pem"
        className="hidden"
        onChange={async (e) => {
          const file = e.target.files?.[0]
          if (file) await onChoosePrivateKey(file)
          if (e.currentTarget) e.currentTarget.value = ''
        }}
      />
      {/* 图标文件 */}
      <input
        ref={avatarInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={onAvatarFileChange}
      />

      {/* 页头 */}
      <div className="mb-8 animate-fade-in-up">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h1 className="flex items-center gap-3 text-3xl font-bold md:text-4xl">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="shrink-0 text-primary"
              style={{ width: '2.2rem', height: '2.2rem' }}
            >
              <rect width="7" height="7" x="3" y="3" rx="1.5" />
              <rect width="7" height="7" x="14" y="3" rx="1.5" />
              <rect width="7" height="7" x="14" y="14" rx="1.5" />
              <rect width="7" height="7" x="3" y="14" rx="1.5" />
            </svg>
            <span>首页模块</span>
          </h1>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={handleImportKey}
              disabled={isAuth}
              className={`btn btn-sm rounded-xl font-semibold ${
                isAuth ? 'btn-ghost text-success' : 'btn-outline'
              }`}
            >
              {isAuth ? '已导入密钥' : '导入密钥'}
            </button>
            <button
              onClick={handleReloadRemote}
              disabled={loadingRemote || saving}
              className="btn btn-sm btn-ghost rounded-xl border bg-base-100/60 font-semibold"
            >
              {loadingRemote ? '读取中...' : '刷新'}
            </button>
            <a href="/" target="_blank" rel="noopener noreferrer" className="btn btn-sm btn-ghost rounded-xl border bg-base-100/60 font-semibold">
              预览首页
            </a>
            <button onClick={openAdd} className="btn btn-sm btn-ghost rounded-xl border bg-base-100/60 font-semibold">
              添加模块
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="btn btn-sm btn-primary rounded-xl px-6 font-semibold shadow-lg shadow-primary/20"
            >
              {saving ? '保存中...' : '保存'}
            </button>
            {hasChanges() && !saving && (
              <button onClick={handleReset} className="btn btn-sm btn-ghost rounded-xl font-semibold text-base-content/60">
                撤销更改
              </button>
            )}
          </div>
        </div>
        <p className="text-lg text-base-content/70">
          把你在其他网站的入口做成卡片放在首页，访客点击即可跳转。保存后约 2~3 分钟自动上线。
        </p>
        {!isAuth && (
          <p className="mt-2 text-sm text-warning">
            提示：保存前需要导入你的 GitHub App 私钥（.pem），只需导入一次。
          </p>
        )}
      </div>

      {/* 卡片预览 */}
      {sites.length > 0 ? (
        <div className="grid grid-cols-1 gap-6 animate-fade-in-up sm:grid-cols-2" style={{ animationDelay: '0.1s' }}>
          {sites.map((site, index) => {
            const pending = pendingAvatars[index]
            const avatarSrc = pending?.previewUrl || site.avatar
            return (
              <div
                key={index}
                className="group relative h-full rounded-2xl border border-base-200 bg-base-100 p-4 shadow-sm transition-all duration-300 hover:border-primary/40 hover:shadow-md"
              >
                <div className="flex items-start gap-3">
                  <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-base-200/60 ring-2 ring-base-200">
                    {avatarSrc ? (
                      <img src={avatarSrc} alt={site.name} className="h-full w-full object-cover" />
                    ) : (
                      <svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-base-content/40"><circle cx="12" cy="12" r="10" /><path d="M2 12h20" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" /></svg>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="truncate text-base font-bold text-base-content">{site.name}</h3>
                      {site.badge && (
                        <span className="inline-flex shrink-0 items-center rounded border border-primary/20 bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
                          {site.badge}
                        </span>
                      )}
                    </div>
                    {site.description && (
                      <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-base-content/60">{site.description}</p>
                    )}
                    <p className="mt-2 truncate text-[11px] text-base-content/40">{site.url}</p>
                  </div>
                </div>

                {/* 操作栏 */}
                <div className="mt-3 flex items-center justify-end gap-2 border-t border-base-200 pt-3">
                  <button onClick={() => moveSite(index, -1)} disabled={index === 0} className="btn btn-xs btn-ghost rounded-lg">
                    上移
                  </button>
                  <button onClick={() => moveSite(index, 1)} disabled={index === sites.length - 1} className="btn btn-xs btn-ghost rounded-lg">
                    下移
                  </button>
                  <button onClick={() => openEdit(index)} className="btn btn-xs btn-outline rounded-lg">
                    编辑
                  </button>
                  <button onClick={() => handleDelete(index)} className="btn btn-xs btn-ghost rounded-lg text-error">
                    删除
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <button
          onClick={openAdd}
          className="block w-full rounded-2xl border-2 border-dashed border-base-300 bg-base-100/60 p-10 text-center text-base-content/60 transition-colors hover:border-primary/40 hover:text-primary"
        >
          <span className="block text-lg font-semibold">还没有模块</span>
          <span className="mt-1 block text-sm">点击这里添加你的第一个站点卡片</span>
        </button>
      )}

      {/* 添加 / 编辑弹窗 */}
      {showForm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
          onClick={closeForm}
        >
          <div
            className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-base-200 bg-base-100 p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-4 text-xl font-bold text-base-content">
              {editIndex === null ? '添加模块' : '编辑模块'}
            </h3>

            <div className="space-y-4">
              {/* 图标 */}
              <div>
                <label className="mb-1 block text-sm font-semibold text-base-content">图标 / 头像</label>
                <div className="flex items-center gap-3">
                  <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-base-200/60 ring-2 ring-base-200">
                    {formPreview ? (
                      <img src={formPreview} alt="预览" className="h-full w-full object-cover" />
                    ) : (
                      <svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-base-content/40"><circle cx="12" cy="12" r="10" /><path d="M2 12h20" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" /></svg>
                    )}
                  </div>
                  <div className="flex-1 space-y-2">
                    <button onClick={chooseAvatar} className="btn btn-sm btn-outline rounded-xl">
                      上传图片
                    </button>
                    <input
                      type="url"
                      value={formFile ? '' : form.avatar || ''}
                      onChange={(e) => onAvatarUrlChange(e.target.value)}
                      placeholder="或填写图片链接（https://...）"
                      className="input input-bordered input-sm w-full rounded-xl"
                    />
                  </div>
                </div>
              </div>

              <div>
                <label className="mb-1 block text-sm font-semibold text-base-content">
                  名称 <span className="text-error">*</span>
                </label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                  placeholder="例如：我的游戏站"
                  className="input input-bordered w-full rounded-xl"
                />
              </div>

              <div>
                <label className="mb-1 block text-sm font-semibold text-base-content">
                  跳转链接 <span className="text-error">*</span>
                </label>
                <input
                  type="text"
                  value={form.url}
                  onChange={(e) => setForm((prev) => ({ ...prev, url: e.target.value }))}
                  placeholder="https://example.com"
                  className="input input-bordered w-full rounded-xl"
                />
              </div>

              <div>
                <label className="mb-1 block text-sm font-semibold text-base-content">描述</label>
                <textarea
                  value={form.description || ''}
                  onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
                  placeholder="一句话介绍这个站点（可留空）"
                  rows={2}
                  className="textarea textarea-bordered w-full rounded-xl"
                />
              </div>

              <div>
                <label className="mb-1 block text-sm font-semibold text-base-content">徽章</label>
                <input
                  type="text"
                  value={form.badge || ''}
                  onChange={(e) => setForm((prev) => ({ ...prev, badge: e.target.value }))}
                  placeholder="可选，例如：自建 / 工具 / 作品"
                  className="input input-bordered w-full rounded-xl"
                />
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <button onClick={closeForm} className="btn btn-sm btn-ghost rounded-xl font-semibold">
                取消
              </button>
              <button onClick={submitForm} className="btn btn-sm btn-primary rounded-xl px-6 font-semibold shadow-lg shadow-primary/20">
                {editIndex === null ? '添加' : '确定'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
