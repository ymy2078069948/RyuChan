'use client'

import { useState, useRef, useEffect } from 'react'
import { toast, Toaster } from 'sonner'
import { useAuthStore } from './hooks/use-auth'
import { readFileAsText } from '@/lib/file-utils'
import { saveFriendsToGitHub } from './services/friends-service'
import type { FriendItem } from '@/interface/friend'

type FriendEditState = FriendItem & { _draft?: boolean }

type Props = {
  initialFriends?: FriendItem[]
}

export default function FriendsEditPage({ initialFriends = [] }: Props) {
  const [friends, setFriends] = useState<FriendEditState[]>(initialFriends)
  const [originalFriends, setOriginalFriends] = useState<FriendItem[]>(
    JSON.parse(JSON.stringify(initialFriends))
  )
  const [globalEditMode, setGlobalEditMode] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editingIndices, setEditingIndices] = useState<Set<number>>(new Set())
  const [pendingAvatars, setPendingAvatars] = useState<Record<number, { file: File; previewUrl: string }>>({})
  const [avatarTargetIndex, setAvatarTargetIndex] = useState<number | null>(null)
  const [scrollToIndex, setScrollToIndex] = useState<number | null>(null)
  const { isAuth, setPrivateKey } = useAuthStore()
  const keyInputRef = useRef<HTMLInputElement>(null)
  const avatarInputRef = useRef<HTMLInputElement>(null)
  const cardRefs = useRef<Record<number, HTMLDivElement | null>>({})

  // Scroll a newly added card into view once it renders
  useEffect(() => {
    if (scrollToIndex === null) return
    const el = cardRefs.current[scrollToIndex]
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
    setScrollToIndex(null)
  }, [scrollToIndex])

  const hasChanges = () => {
    return JSON.stringify(friends) !== JSON.stringify(originalFriends) || Object.keys(pendingAvatars).length > 0
  }

  const handleEnterEditMode = () => {
    setGlobalEditMode(true)
  }

  const handleCancelGlobal = () => {
    if (hasChanges()) {
      if (!window.confirm('你有未保存的更改，确定要取消吗？所有修改将丢失。')) return
    }
    setFriends(JSON.parse(JSON.stringify(originalFriends)))
    Object.values(pendingAvatars).forEach(({ previewUrl }) => URL.revokeObjectURL(previewUrl))
    setPendingAvatars({})
    setGlobalEditMode(false)
    setEditingIndices(new Set())
  }

  const handleSaveAll = async () => {
    if (!isAuth) {
      toast.error('请先导入密钥后再保存')
      handleImportKey()
      return
    }
    try {
      setSaving(true)
      const cleanFriends = friends.map(({ _draft, ...rest }) => rest as FriendItem)
      await saveFriendsToGitHub(cleanFriends, pendingAvatars)
      Object.values(pendingAvatars).forEach(({ previewUrl }) => URL.revokeObjectURL(previewUrl))
      setPendingAvatars({})
      setOriginalFriends(JSON.parse(JSON.stringify(cleanFriends)))
      setFriends(cleanFriends)
      setGlobalEditMode(false)
      setEditingIndices(new Set())
    } catch {
      // error handled in service
    } finally {
      setSaving(false)
    }
  }

  const handleAdd = () => {
    const newFriend: FriendEditState = {
      name: '',
      avatar: '',
      description: '',
      url: '',
      badge: '',
      _draft: true
    }
    const newIndex = friends.length
    setFriends([...friends, newFriend])
    setEditingIndices(prev => new Set(prev).add(newIndex))
    setScrollToIndex(newIndex)
  }

  const handleDelete = (index: number) => {
    if (!window.confirm(`确定要删除好友 "${friends[index].name || '(未命名)'}" 吗？`)) return
    const updated = [...friends]
    updated.splice(index, 1)
    setFriends(updated)
    // Re-index editing set (indices shift after splice)
    setEditingIndices(prev => {
      const next = new Set<number>()
      prev.forEach(i => {
        if (i === index) return
        next.add(i > index ? i - 1 : i)
      })
      return next
    })
    setPendingAvatars(prev => {
      const next: Record<number, { file: File; previewUrl: string }> = {}
      for (const [keyStr, value] of Object.entries(prev)) {
        const key = parseInt(keyStr)
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

  const swapEditing = (a: number, b: number) => {
    setEditingIndices(prev => {
      const next = new Set(prev)
      const hasA = prev.has(a)
      const hasB = prev.has(b)
      next.delete(a); next.delete(b)
      if (hasA) next.add(b)
      if (hasB) next.add(a)
      return next
    })
  }

  const handleMoveUp = (index: number) => {
    if (index <= 0) return
    const updated = [...friends]
    ;[updated[index - 1], updated[index]] = [updated[index], updated[index - 1]]
    setFriends(updated)
    swapEditing(index, index - 1)
    setPendingAvatars(prev => {
      const next: Record<number, { file: File; previewUrl: string }> = {}
      for (const [keyStr, value] of Object.entries(prev)) {
        const key = parseInt(keyStr)
        if (key === index) {
          next[index - 1] = value
        } else if (key === index - 1) {
          next[index] = value
        } else {
          next[key] = value
        }
      }
      return next
    })
  }

  const handleMoveDown = (index: number) => {
    if (index >= friends.length - 1) return
    const updated = [...friends]
    ;[updated[index], updated[index + 1]] = [updated[index + 1], updated[index]]
    setFriends(updated)
    swapEditing(index, index + 1)
    setPendingAvatars(prev => {
      const next: Record<number, { file: File; previewUrl: string }> = {}
      for (const [keyStr, value] of Object.entries(prev)) {
        const key = parseInt(keyStr)
        if (key === index) {
          next[index + 1] = value
        } else if (key === index + 1) {
          next[index] = value
        } else {
          next[key] = value
        }
      }
      return next
    })
  }

  const handleStartEdit = (index: number) => {
    setEditingIndices(prev => new Set(prev).add(index))
  }

  const handleCancelEdit = (index: number) => {
    if (pendingAvatars[index]) {
      URL.revokeObjectURL(pendingAvatars[index].previewUrl)
      setPendingAvatars(prev => {
        const next = { ...prev }
        delete next[index]
        return next
      })
    }
    if (friends[index]._draft && !friends[index].name) {
      const updated = [...friends]
      updated.splice(index, 1)
      setFriends(updated)
      // Re-index editing set (indices shift after splice)
      setEditingIndices(prev => {
        const next = new Set<number>()
        prev.forEach(i => {
          if (i === index) return
          next.add(i > index ? i - 1 : i)
        })
        return next
      })
    } else {
      const updated = [...friends]
      const orig = originalFriends[index]
      if (orig) {
        updated[index] = { ...orig, _draft: false }
      } else {
        updated[index] = { ...friends[index], _draft: false }
      }
      setFriends(updated)
      setEditingIndices(prev => {
        const next = new Set(prev)
        next.delete(index)
        return next
      })
    }
  }

  const handleCompleteEdit = (index: number) => {
    const item = friends[index]
    if (!item.name.trim()) {
      toast.error('好友名称不能为空')
      return
    }
    if (!item.url.trim()) {
      toast.error('请输入好友的网站链接')
      return
    }
    const updated = [...friends]
    updated[index] = { ...item, _draft: false }
    setFriends(updated)
    setEditingIndices(prev => {
      const next = new Set(prev)
      next.delete(index)
      return next
    })
  }

  const updateFriend = (index: number, field: keyof FriendEditState, value: any) => {
    const updated = [...friends]
    updated[index] = { ...updated[index], [field]: value }
    setFriends(updated)
  }

  const handleImportKey = () => {
    keyInputRef.current?.click()
  }

  const onChoosePrivateKey = async (file: File) => {
    const pem = await readFileAsText(file)
    setPrivateKey(pem)
    toast.success('密钥导入成功')
  }

  const handleAvatarClick = (index: number) => {
    setAvatarTargetIndex(index)
    avatarInputRef.current?.click()
  }

  const handleAvatarFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    const index = avatarTargetIndex
    if (!file || index === null) return

    if (!file.type.startsWith('image/')) {
      toast.error('请选择图片文件')
      setAvatarTargetIndex(null)
      if (e.currentTarget) e.currentTarget.value = ''
      return
    }

    if (pendingAvatars[index]) {
      URL.revokeObjectURL(pendingAvatars[index].previewUrl)
    }

    const previewUrl = URL.createObjectURL(file)
    setPendingAvatars(prev => ({ ...prev, [index]: { file, previewUrl } }))
    updateFriend(index, 'avatar', previewUrl)

    setAvatarTargetIndex(null)
    if (e.currentTarget) e.currentTarget.value = ''
  }

  // ====== Render badge ======
  const renderBadge = (badge?: string) => {
    if (!badge) return null
    return (
      <span className="inline-flex items-center px-2 py-0.5 text-xs font-semibold rounded bg-primary/10 text-primary border border-primary/20">
        {badge}
      </span>
    )
  }

  // ====== Render view-only name ======
  const renderViewName = (friend: FriendEditState) => {
    return (
      <h3 className="font-bold text-base text-base-content truncate">
        {friend.name}
      </h3>
    )
  }

  // ====== Render avatar (view mode only) ======
  const renderAvatar = (friend: FriendEditState, index: number) => {
    const pendingAvatar = pendingAvatars[index]
    const displaySrc = pendingAvatar?.previewUrl || friend.avatar

    return (
      <div className="shrink-0">
        <div className="group relative w-16 h-16 rounded-full bg-base-200/50 p-0.5 ring-2 ring-base-200 transition-all duration-300">
          {displaySrc ? (
            <img
              alt={friend.name}
              className="w-full h-full rounded-full object-cover"
              src={displaySrc}
            />
          ) : (
            <div className="flex items-center justify-center w-full h-full rounded-full bg-base-300 text-base-content/40">
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
            </div>
          )}
        </div>
      </div>
    )
  }

  // ====== Render description (view mode only) ======
  const renderDescription = (friend: FriendEditState) => {
    return (
      <p className="text-xs text-base-content/60 line-clamp-2 leading-relaxed">
        {friend.description}
      </p>
    )
  }

  // ====== Render URL link (view mode only) ======
  const renderUrl = (friend: FriendEditState) => {
    return (
      <a
        href={friend.url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-sm font-medium text-primary bg-primary/5 hover:bg-primary/10 rounded-md px-2 py-1 transition-colors"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        Website
      </a>
    )
  }

  return (
    <>
      <Toaster
        richColors
        position="top-center"
        toastOptions={{
          className: 'shadow-xl rounded-2xl border-2 border-primary/20 backdrop-blur-sm',
          style: { fontSize: '1rem', padding: '14px 20px', borderRadius: '12px', boxShadow: '0 10px 40px rgba(0, 0, 0, 0.15)' },
          duration: 5000,
        }}
      />

      {/* PEM key file input */}
      <input
        ref={keyInputRef}
        type="file"
        accept=".pem"
        className="hidden"
        onChange={async e => {
          const f = e.target.files?.[0]
          if (f) await onChoosePrivateKey(f)
          if (e.currentTarget) e.currentTarget.value = ''
        }}
      />

      {/* Avatar file input */}
      <input
        ref={avatarInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleAvatarFileChange}
      />

      {/* Header: Title + Toolbar */}
      <div className="mb-8 animate-fade-in-up">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-3xl md:text-4xl font-bold flex items-center gap-3">
            <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-primary shrink-0" style={{ fontSize: '2.5rem' }}>
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
            </svg>
            <span>Friends</span>
          </h1>
          <div className="flex gap-3 shrink-0">
            {globalEditMode ? (
              <>
                <button onClick={handleCancelGlobal} className="btn btn-sm btn-ghost rounded-xl border bg-base-100/60 font-semibold">
                  取消
                </button>
                <button onClick={handleAdd} className="btn btn-sm btn-ghost rounded-xl border bg-base-100/60 font-semibold">
                  添加
                </button>
                <button
                  onClick={handleImportKey}
                  disabled={isAuth}
                  className={`btn btn-sm rounded-xl font-semibold ${
                    isAuth ? 'btn-ghost text-success' : 'btn-outline'
                  }`}
                >
                  {isAuth ? '已导入' : '导入密钥'}
                </button>
                <button onClick={handleSaveAll} disabled={saving} className="btn btn-sm btn-primary px-6 shadow-lg shadow-primary/20 font-semibold">
                  {saving ? '保存中...' : '保存'}
                </button>
              </>
            ) : (
              <button onClick={handleEnterEditMode} className="btn btn-sm btn-primary gap-2 rounded-xl font-semibold shadow-lg shadow-primary/20">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
                编辑
              </button>
            )}
          </div>
        </div>
        <p className="text-base-content/70 text-lg">
          记录那些珍贵的友谊，分享彼此的故事。
        </p>
      </div>

      {friends.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 animate-fade-in-up" style={{ animationDelay: '0.1s' }}>
          {friends.map((friend, index) => {
            const isEditing = editingIndices.has(index)

            return (
              <div
                key={index}
                ref={el => { cardRefs.current[index] = el }}
                data-friend-card
                data-friend-badge={friend.badge || ""}
                className={`group relative block bg-base-100 rounded-2xl border border-base-200 hover:border-primary/40 shadow-sm hover:shadow-md transition-all duration-300 overflow-hidden ${
                  isEditing ? 'ring-2 ring-primary/30' : ''
                }`}
              >
                <div className={`flex flex-col h-full ${isEditing ? '' : 'p-4'}`}>
                  {/* Global edit mode toolbar for non-editing cards */}
                  {globalEditMode && !isEditing && (
                    <div className="px-4 pt-4 pb-2">
                      <div className="flex justify-end gap-2">
                        {index > 0 && (
                          <button
                            onClick={(e) => { e.preventDefault(); handleMoveUp(index) }}
                            className="btn btn-sm btn-ghost text-primary/50 hover:text-primary hover:bg-primary/10 rounded-lg px-2"
                            title="上移"
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="18 15 12 9 6 15"/></svg>
                          </button>
                        )}
                        {index < friends.length - 1 && (
                          <button
                            onClick={(e) => { e.preventDefault(); handleMoveDown(index) }}
                            className="btn btn-sm btn-ghost text-primary/50 hover:text-primary hover:bg-primary/10 rounded-lg px-2"
                            title="下移"
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                          </button>
                        )}
                        <button
                          onClick={(e) => { e.preventDefault(); handleStartEdit(index) }}
                          className="btn btn-sm btn-ghost text-primary hover:bg-primary/10 rounded-lg px-2"
                          title="编辑"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
                        </button>
                        <button
                          onClick={(e) => { e.preventDefault(); handleDelete(index) }}
                          className="btn btn-sm btn-ghost text-error hover:bg-error/10 rounded-lg px-2"
                          title="删除"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                        </button>
                      </div>
                    </div>
                  )}

                  {isEditing ? (
                    /* ====== Inline Edit Form — single card, vertical layout ====== */
                    <div className="p-4 space-y-3">
                      {/* Avatar row: 1/3 avatar + 2/3 name/badge */}
                      <div className="flex items-start gap-3">
                        <div className="w-1/3 shrink-0">
                          <div
                            className="group relative aspect-square w-full rounded-xl bg-base-200/50 p-0.5 cursor-pointer hover:ring-2 hover:ring-primary/50 hover:shadow-md transition-all duration-300"
                            onClick={() => handleAvatarClick(index)}
                            title="点击上传头像"
                          >
                            {(pendingAvatars[index]?.previewUrl || friend.avatar) ? (
                              <img
                                alt={friend.name}
                                className="w-full h-full rounded-lg object-cover"
                                src={pendingAvatars[index]?.previewUrl || friend.avatar}
                              />
                            ) : (
                              <div className="flex items-center justify-center w-full h-full rounded-lg bg-base-300 text-base-content/40">
                                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
                              </div>
                            )}
                            <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-xl bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity">
                              <span className="text-xs text-white font-semibold">更换</span>
                            </div>
                          </div>
                          <input
                            className="input input-xs input-bordered w-full bg-base-100 focus:border-primary text-xs font-medium mt-1.5"
                            value={friend.avatar || ''}
                            onChange={e => updateFriend(index, 'avatar', e.target.value)}
                            placeholder="图片URL"
                          />
                        </div>
                        <div className="w-2/3 min-w-0 flex flex-col gap-2">
                          <input
                            className="input input-sm input-bordered w-full bg-base-100 focus:border-primary text-sm font-medium"
                            value={friend.name}
                            onChange={e => updateFriend(index, 'name', e.target.value)}
                            placeholder="好友名称"
                          />
                          <input
                            className="input input-sm input-bordered w-full bg-base-100 focus:border-primary text-sm"
                            value={friend.badge || ''}
                            onChange={e => updateFriend(index, 'badge', e.target.value)}
                            placeholder="徽章（如 邻居、室友）"
                          />
                          <textarea
                            className="textarea textarea-bordered w-full flex-1 min-h-0 bg-base-100 focus:border-primary text-sm leading-relaxed resize-none"
                            value={friend.description}
                            onChange={e => updateFriend(index, 'description', e.target.value)}
                            placeholder="好友描述"
                          />
                        </div>
                      </div>

                      {/* URL */}
                      <input
                        className="input input-sm input-bordered w-full bg-base-100 focus:border-primary text-sm"
                        value={friend.url}
                        onChange={e => updateFriend(index, 'url', e.target.value)}
                        placeholder="网站链接 https://..."
                        type="url"
                      />

                      {/* Action buttons */}
                      <div className="flex gap-3 pt-2 border-t border-base-200/50">
                        <button onClick={() => handleCancelEdit(index)} className="btn btn-ghost btn-sm flex-1 rounded-xl text-base-content/60 font-semibold">
                          取消
                        </button>
                        <button onClick={() => handleCompleteEdit(index)} className="btn btn-primary btn-sm flex-1 rounded-xl font-semibold shadow-lg shadow-primary/20">
                          完成
                        </button>
                      </div>
                    </div>
                  ) : (
                    /* ====== View Mode — original compact card ====== */
                    <>
                      {/* Badge in view mode */}
                      {!globalEditMode && friend.badge && (
                        <div className="absolute top-2 right-2 z-10">
                          {renderBadge(friend.badge)}
                        </div>
                      )}

                      {/* Main content: Avatar + Name + Description */}
                      <div className={`flex items-start gap-4 flex-1 ${globalEditMode ? 'relative' : ''}`}>
                        {renderAvatar(friend, index)}
                        <div className="flex-1 min-w-0 flex flex-col justify-center">
                          <div className="flex items-center justify-between mb-1">
                            {renderViewName(friend)}
                          </div>
                          <div className="mb-1.5">
                            {renderDescription(friend)}
                          </div>
                        </div>
                      </div>

                      {/* Badge: top-right inside content area in global edit mode */}
                      {globalEditMode && friend.badge && (
                        <div className="absolute top-0 right-0">
                          {renderBadge(friend.badge)}
                        </div>
                      )}

                      {/* Footer: URL at bottom-right */}
                      <div className="px-4 pt-2 border-t border-base-200/50">
                        {renderUrl(friend)}
                      </div>
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-24 text-center space-y-4 animate-fade-in-up" style={{ animationDelay: '0.1s' }}>
          <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" className="text-base-content/20"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
          <p className="text-base-content/50">还没有好友，点击"编辑"开始添加</p>
          <button onClick={handleEnterEditMode} className="btn btn-primary btn-sm gap-2 font-semibold">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
            编辑
          </button>
        </div>
      )}
    </>
  )
}
