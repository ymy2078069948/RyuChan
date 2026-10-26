'use client'

import { useEffect, useRef, useState } from 'react'
import { toast, Toaster } from 'sonner'
import { useAuthStore } from './hooks/use-auth'
import { readFileAsText } from '@/lib/file-utils'
import { loadMomentsFromGitHub, saveMomentsToGitHub, type PendingImage } from './services/moments-service'
import type { Moment } from '@/interface/moment'

type Props = {
  initialMoments?: Moment[]
}

type EditableImage = { src: string; file?: File; preview?: string }
type EditableMoment = {
  date: string
  content: string
  images: EditableImage[]
  location?: string
  mood?: string
}

function toInputValue(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function fromInputValue(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString()
}

function formatDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function toEditable(moments: Moment[]): EditableMoment[] {
  return moments.map((moment) => ({
    date: moment.date,
    content: moment.content,
    location: moment.location,
    mood: moment.mood,
    images: (moment.images || []).map((src) => ({ src })),
  }))
}

function emptyForm(): EditableMoment {
  return {
    date: new Date().toISOString(),
    content: '',
    images: [],
    location: '',
    mood: '',
  }
}

export default function MomentsEditPage({ initialMoments = [] }: Props) {
  const [moments, setMoments] = useState<EditableMoment[]>(toEditable(initialMoments))
  const [original, setOriginal] = useState<EditableMoment[]>(toEditable(initialMoments))
  const [saving, setSaving] = useState(false)
  const [loadingRemote, setLoadingRemote] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [editIndex, setEditIndex] = useState<number | null>(null)
  const [form, setForm] = useState<EditableMoment>(emptyForm())
  const { isAuth, setPrivateKey } = useAuthStore()

  const keyInputRef = useRef<HTMLInputElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    return () => {
      for (const moment of moments) {
        for (const image of moment.images) {
          if (image.preview) URL.revokeObjectURL(image.preview)
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const hasChanges = () => JSON.stringify(moments) !== JSON.stringify(original)

  const handleImportKey = () => keyInputRef.current?.click()

  const onChoosePrivateKey = async (file: File) => {
    const pem = await readFileAsText(file)
    setPrivateKey(pem)
    toast.success('密钥导入成功')
  }

  const openAdd = () => {
    setEditIndex(null)
    setForm(emptyForm())
    setShowForm(true)
  }

  const openEdit = (index: number) => {
    setEditIndex(index)
    setForm(JSON.parse(JSON.stringify(moments[index])))
    setShowForm(true)
  }

  const closeForm = () => {
    for (const image of form.images) {
      if (image.preview) URL.revokeObjectURL(image.preview)
    }
    setShowForm(false)
    setEditIndex(null)
  }

  const chooseImages = () => imageInputRef.current?.click()

  const onImagesChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || [])
    const valid = files.filter((file) => file.type.startsWith('image/'))
    if (valid.length !== files.length) toast.error('只能上传图片文件')
    const nextImages = [...form.images]
    for (const file of valid) {
      const preview = URL.createObjectURL(file)
      nextImages.push({ src: preview, file, preview })
    }
    setForm((prev) => ({ ...prev, images: nextImages }))
    if (event.currentTarget) event.currentTarget.value = ''
  }

  const removeFormImage = (index: number) => {
    const image = form.images[index]
    if (image?.preview) URL.revokeObjectURL(image.preview)
    setForm((prev) => ({ ...prev, images: prev.images.filter((_, i) => i !== index) }))
  }

  const submitForm = () => {
    if (!form.content.trim()) {
      toast.error('请填写瞬间内容')
      return
    }
    const nextMoments = [...moments]
    const payload: EditableMoment = {
      date: fromInputValue(form.date),
      content: form.content.trim(),
      images: form.images,
      location: (form.location || '').trim(),
      mood: (form.mood || '').trim(),
    }
    if (editIndex === null) nextMoments.unshift(payload)
    else nextMoments[editIndex] = payload
    setMoments(nextMoments)
    setShowForm(false)
    setEditIndex(null)
  }

  const handleDelete = (index: number) => {
    if (!window.confirm('确定要删除这条瞬间吗？')) return
    for (const image of moments[index].images) {
      if (image.preview) URL.revokeObjectURL(image.preview)
    }
    setMoments(moments.filter((_, i) => i !== index))
  }

  const handleSave = async () => {
    if (!isAuth) {
      toast.error('请先导入 GitHub App 私钥后再保存')
      handleImportKey()
      return
    }
    if (moments.some((moment) => !moment.content.trim())) {
      toast.error('每条瞬间都需要填写内容')
      return
    }
    try {
      setSaving(true)
      const payload: Moment[] = moments.map((moment) => ({
        date: moment.date,
        content: moment.content,
        images: moment.images.map((image) => image.src),
        location: moment.location,
        mood: moment.mood,
      }))
      const pending: Record<number, PendingImage[]> = {}
      moments.forEach((moment, index) => {
        const files = moment.images
          .filter((image) => image.file)
          .map((image) => ({ file: image.file!, tempSrc: image.src }))
        if (files.length) pending[index] = files
      })
      const saved = await saveMomentsToGitHub(payload, pending)
      for (const moment of moments) {
        for (const image of moment.images) {
          if (image.preview) URL.revokeObjectURL(image.preview)
        }
      }
      const editable = toEditable(saved)
      setMoments(editable)
      setOriginal(JSON.parse(JSON.stringify(editable)))
    } catch {
      // 错误提示由 service 处理
    } finally {
      setSaving(false)
    }
  }

  const handleReset = () => {
    if (!hasChanges() || window.confirm('有未保存的更改，确定要放弃吗？')) {
      for (const moment of moments) {
        for (const image of moment.images) {
          if (image.preview) URL.revokeObjectURL(image.preview)
        }
      }
      setMoments(JSON.parse(JSON.stringify(original)))
    }
  }

  const handleReload = async () => {
    if (!isAuth) {
      toast.error('请先导入 GitHub App 私钥后再刷新')
      handleImportKey()
      return
    }
    if (hasChanges() && !window.confirm('刷新会丢弃未保存的更改，确定继续吗？')) return
    try {
      setLoadingRemote(true)
      const remote = await loadMomentsFromGitHub()
      const editable = toEditable(remote)
      setMoments(editable)
      setOriginal(JSON.parse(JSON.stringify(editable)))
      toast.success(`已读取 ${remote.length} 条瞬间`)
    } catch (error: any) {
      toast.error('读取失败', { description: error?.message || '请稍后重试' })
    } finally {
      setLoadingRemote(false)
    }
  }

  return (
    <>
      <Toaster
        richColors
        position="top-center"
        toastOptions={{
          className: 'shadow-xl rounded-2xl border-2 border-primary/20 backdrop-blur-sm',
          style: { fontSize: '1rem', padding: '14px 20px', borderRadius: '12px' },
          duration: 5000,
        }}
      />

      <input
        ref={keyInputRef}
        type="file"
        accept=".pem"
        className="hidden"
        onChange={async (event) => {
          const file = event.target.files?.[0]
          if (file) await onChoosePrivateKey(file)
          if (event.currentTarget) event.currentTarget.value = ''
        }}
      />
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={onImagesChange}
      />

      <div className="mb-8 animate-fade-in-up">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h1 className="flex items-center gap-3 text-3xl font-bold md:text-4xl">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-primary" style={{ width: '2.2rem', height: '2.2rem' }}>
              <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z" />
            </svg>
            <span>瞬间编辑</span>
          </h1>
          <div className="flex flex-wrap gap-2">
            <button onClick={handleImportKey} disabled={isAuth} className={`btn btn-sm rounded-xl font-semibold ${isAuth ? 'btn-ghost text-success' : 'btn-outline'}`}>
              {isAuth ? '已导入密钥' : '导入密钥'}
            </button>
            <button onClick={handleReload} disabled={loadingRemote || saving} className="btn btn-sm btn-ghost rounded-xl border bg-base-100/60 font-semibold">
              {loadingRemote ? '读取中...' : '刷新'}
            </button>
            <a href="/moments/" target="_blank" rel="noopener noreferrer" className="btn btn-sm btn-ghost rounded-xl border bg-base-100/60 font-semibold">
              预览页面
            </a>
            <button onClick={openAdd} className="btn btn-sm btn-ghost rounded-xl border bg-base-100/60 font-semibold">
              发布瞬间
            </button>
            <button onClick={handleSave} disabled={saving} className="btn btn-sm btn-primary rounded-xl px-6 font-semibold shadow-lg shadow-primary/20">
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
          发布短动态（说说），支持文字、多图和位置、心情。保存后约 2~3 分钟自动上线。
        </p>
        {!isAuth && <p className="mt-2 text-sm text-warning">提示：保存前需要导入 GitHub App 私钥（.pem）。</p>}
      </div>

      <div className="space-y-4">
        {moments.length === 0 && (
          <button onClick={openAdd} className="block w-full rounded-2xl border-2 border-dashed border-base-300 bg-base-100/60 p-10 text-center text-base-content/60 transition-colors hover:border-primary/40 hover:text-primary">
            <span className="block text-lg font-semibold">还没有瞬间</span>
            <span className="mt-1 block text-sm">点击发布第一条</span>
          </button>
        )}

        {moments.map((moment, index) => (
          <article key={index} className="rounded-2xl border border-base-200 bg-base-100 p-4 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-xs text-base-content/50">
                  {formatDate(moment.date)}
                  {moment.location ? ` · ${moment.location}` : ''}
                </div>
                <p className="mt-1 whitespace-pre-wrap text-sm text-base-content/80">{moment.content}</p>
              </div>
              <div className="flex shrink-0 gap-1">
                <button onClick={() => openEdit(index)} className="btn btn-xs btn-outline rounded-lg">编辑</button>
                <button onClick={() => handleDelete(index)} className="btn btn-xs btn-ghost rounded-lg text-error">删除</button>
              </div>
            </div>
            {moment.images.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {moment.images.map((image, imageIndex) => (
                  <div key={imageIndex} className="h-16 w-16 overflow-hidden rounded-lg bg-base-200">
                    <img src={image.preview || image.src} alt="瞬间配图" className="h-full w-full object-cover" />
                  </div>
                ))}
              </div>
            )}
          </article>
        ))}
      </div>

      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm" onClick={closeForm}>
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-base-200 bg-base-100 p-6 shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <h3 className="mb-4 text-xl font-bold">{editIndex === null ? '发布瞬间' : '编辑瞬间'}</h3>
            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-sm font-semibold">时间</label>
                <input
                  type="datetime-local"
                  value={toInputValue(form.date)}
                  onChange={(event) => setForm((prev) => ({ ...prev, date: fromInputValue(event.target.value) }))}
                  className="input input-bordered w-full rounded-xl"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-semibold">内容 <span className="text-error">*</span></label>
                <textarea
                  rows={4}
                  value={form.content}
                  onChange={(event) => setForm((prev) => ({ ...prev, content: event.target.value }))}
                  placeholder="此刻的想法…"
                  className="textarea textarea-bordered w-full rounded-xl"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-sm font-semibold">位置</label>
                  <input
                    type="text"
                    value={form.location || ''}
                    onChange={(event) => setForm((prev) => ({ ...prev, location: event.target.value }))}
                    placeholder="可选"
                    className="input input-bordered w-full rounded-xl"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-semibold">心情</label>
                  <input
                    type="text"
                    value={form.mood || ''}
                    onChange={(event) => setForm((prev) => ({ ...prev, mood: event.target.value }))}
                    placeholder="可选，如 开心"
                    className="input input-bordered w-full rounded-xl"
                  />
                </div>
              </div>
              <div>
                <label className="mb-1 block text-sm font-semibold">配图</label>
                <div className="flex flex-wrap items-center gap-2">
                  {form.images.map((image, index) => (
                    <div key={index} className="group relative h-16 w-16 overflow-hidden rounded-lg bg-base-200">
                      <img src={image.preview || image.src} alt="配图" className="h-full w-full object-cover" />
                      <button
                        type="button"
                        onClick={() => removeFormImage(index)}
                        className="absolute right-0 top-0 hidden h-5 w-5 items-center justify-center rounded-bl-lg bg-black/60 text-xs text-white group-hover:flex"
                        aria-label="移除图片"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  <button type="button" onClick={chooseImages} className="flex h-16 w-16 items-center justify-center rounded-lg border-2 border-dashed border-base-300 text-2xl text-base-content/40 hover:border-primary/40 hover:text-primary">
                    +
                  </button>
                </div>
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button onClick={closeForm} className="btn btn-sm btn-ghost rounded-xl font-semibold">取消</button>
              <button onClick={submitForm} className="btn btn-sm btn-primary rounded-xl px-6 font-semibold shadow-lg shadow-primary/20">
                {editIndex === null ? '发布' : '确定'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
