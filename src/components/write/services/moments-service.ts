import {
  readTextFileFromRepo,
  listRepoFilesRecursive,
  createBlob,
  createTree,
  createCommit,
  updateRef,
  getRef,
  getCommit,
  type TreeItem,
} from '@/lib/github-client'
import { replaceIndividualFiles } from '@/lib/individual-files'
import { fileToBase64NoPrefix, hashFileSHA256 } from '@/lib/file-utils'
import { getAuthToken } from '@/lib/auth'
import { GITHUB_CONFIG } from '@/consts'
import { CONTENT_PATHS } from '@/lib/content-paths'
import yaml from 'js-yaml'
import { toast } from 'sonner'
import type { Moment } from '@/interface/moment'

/** 从内容仓库读取瞬间（用于编辑页刷新） */
export async function loadMomentsFromGitHub(): Promise<Moment[]> {
  let token: string | undefined
  try {
    token = await getAuthToken()
  } catch {
    // 内容仓库是私有的，未导入私钥时无法读取
  }

  let files: string[] = []
  try {
    files = await listRepoFilesRecursive(
      token,
      GITHUB_CONFIG.OWNER,
      GITHUB_CONFIG.REPO,
      CONTENT_PATHS.momentsList,
      GITHUB_CONFIG.BRANCH,
    )
  } catch {
    return []
  }

  const moments: Moment[] = []
  for (const filePath of files.filter((f) => f.endsWith('.yaml')).sort()) {
    const content = await readTextFileFromRepo(
      token,
      GITHUB_CONFIG.OWNER,
      GITHUB_CONFIG.REPO,
      filePath,
      GITHUB_CONFIG.BRANCH,
    )
    if (!content) continue
    try {
      const data = yaml.load(content) as Moment
      if (data?.content) moments.push(data)
    } catch {
      // 跳过解析失败的文件
    }
  }
  return moments.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
}

export type PendingImage = { file: File; tempSrc: string }

/** 保存瞬间：上传配图 → 写入内容仓库 → 提交（提交成功会自动触发部署） */
export async function saveMomentsToGitHub(
  moments: Moment[],
  pendingImages?: Record<number, PendingImage[]>,
): Promise<Moment[]> {
  const token = await getAuthToken()
  const toastId = toast.loading('🚀 正在保存瞬间...')
  const updated: Moment[] = moments.map((moment) => ({
    ...moment,
    images: [...(moment.images || [])],
  }))

  try {
    const treeItems: TreeItem[] = []
    const uploaded = new Map<string, string>()

    if (pendingImages) {
      for (const [indexStr, files] of Object.entries(pendingImages)) {
        const index = Number.parseInt(indexStr, 10)
        if (!updated[index] || !files.length) continue
        toast.loading(`正在上传配图 ${index + 1}...`, { id: toastId })
        for (const item of files) {
          const hash = await hashFileSHA256(item.file)
          const ext = item.file.name.split('.').pop()?.toLowerCase() || 'jpg'
          const filename = `moment-${hash}.${ext}`
          const repoPath = `${CONTENT_PATHS.momentsImages}/${filename}`
          const publicPath = `/images/moments/${filename}`

          if (!uploaded.has(repoPath)) {
            const base64 = await fileToBase64NoPrefix(item.file)
            const { sha } = await createBlob(
              token,
              GITHUB_CONFIG.OWNER,
              GITHUB_CONFIG.REPO,
              base64,
              'base64',
            )
            treeItems.push({ path: repoPath, mode: '100644', type: 'blob', sha })
            uploaded.set(repoPath, publicPath)
          }
          const finalPath = uploaded.get(repoPath)!
          updated[index].images = updated[index].images?.map((src) =>
            src === item.tempSrc ? finalPath : src,
          )
        }
      }
    }

    toast.loading('正在生成瞬间文件...', { id: toastId })
    const clean = updated.map(({ id, ...rest }) => rest)
    const fileTreeItems = await replaceIndividualFiles(token, CONTENT_PATHS.momentsList, clean)
    treeItems.push(...fileTreeItems)

    toast.loading('正在获取分支信息...', { id: toastId })
    const refName = `heads/${GITHUB_CONFIG.BRANCH}`
    const ref = await getRef(token, GITHUB_CONFIG.OWNER, GITHUB_CONFIG.REPO, refName)
    const currentCommitSha = ref.sha
    const commit = await getCommit(token, GITHUB_CONFIG.OWNER, GITHUB_CONFIG.REPO, currentCommitSha)

    toast.loading('🌳 正在构建文件树...', { id: toastId })
    const { sha: newTreeSha } = await createTree(
      token,
      GITHUB_CONFIG.OWNER,
      GITHUB_CONFIG.REPO,
      treeItems,
      commit.tree.sha,
    )

    toast.loading('💾 正在提交更改...', { id: toastId })
    const { sha: newCommitSha } = await createCommit(
      token,
      GITHUB_CONFIG.OWNER,
      GITHUB_CONFIG.REPO,
      'chore(moments): update moments',
      newTreeSha,
      [currentCommitSha],
    )

    toast.loading('🔄 正在同步远程分支...', { id: toastId })
    await updateRef(token, GITHUB_CONFIG.OWNER, GITHUB_CONFIG.REPO, refName, newCommitSha)

    toast.success('🎉 瞬间已保存！', {
      id: toastId,
      description: '已提交到内容仓库，约 2~3 分钟后 /moments 自动更新。',
      duration: 5000,
    })
    return updated
  } catch (error: any) {
    console.error(error)
    toast.error('❌ 保存失败', {
      id: toastId,
      description: error?.message || '发生了未知错误，请重试',
    })
    throw error
  }
}
