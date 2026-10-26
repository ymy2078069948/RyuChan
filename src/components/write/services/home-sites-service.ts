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
import { fileToBase64NoPrefix } from '@/lib/file-utils'
import { getAuthToken } from '@/lib/auth'
import { GITHUB_CONFIG } from '@/consts'
import { CONTENT_PATHS } from '@/lib/content-paths'
import yaml from 'js-yaml'
import { toast } from 'sonner'
import type { HomeSite } from '@/interface/home-site'

/** 从内容仓库读取首页模块（用于编辑页刷新最新数据） */
export async function loadHomeSitesFromGitHub(): Promise<HomeSite[]> {
  let token: string | undefined
  try {
    token = await getAuthToken()
  } catch {
    // 未登录时尝试公开访问（内容仓库是私有的，通常会失败）
  }

  let files: string[] = []
  try {
    files = await listRepoFilesRecursive(
      token,
      GITHUB_CONFIG.OWNER,
      GITHUB_CONFIG.REPO,
      CONTENT_PATHS.homeSitesList,
      GITHUB_CONFIG.BRANCH,
    )
  } catch {
    return []
  }

  const yamlFiles = files.filter((f) => f.endsWith('.yaml')).sort()
  const sites: HomeSite[] = []
  for (const filePath of yamlFiles) {
    const content = await readTextFileFromRepo(
      token,
      GITHUB_CONFIG.OWNER,
      GITHUB_CONFIG.REPO,
      filePath,
      GITHUB_CONFIG.BRANCH,
    )
    if (!content) continue
    try {
      const data = yaml.load(content) as HomeSite
      if (data && data.name) sites.push(data)
    } catch {
      // 跳过解析失败的文件
    }
  }
  return sites
}

/** 保存首页模块：上传图标 → 写入内容仓库 → 提交（提交成功会自动触发部署） */
export async function saveHomeSitesToGitHub(
  sites: HomeSite[],
  pendingAvatars?: Record<number, { file: File; previewUrl: string }>,
): Promise<HomeSite[]> {
  const token = await getAuthToken()
  const toastId = toast.loading('🚀 正在保存首页模块...')
  const updated: HomeSite[] = sites.map((site) => ({ ...site }))

  try {
    const treeItems: TreeItem[] = []

    // 1. 上传新选择的图标
    if (pendingAvatars && Object.keys(pendingAvatars).length > 0) {
      for (const [indexStr, { file }] of Object.entries(pendingAvatars)) {
        const index = Number.parseInt(indexStr, 10)
        if (!updated[index]) continue
        const ext = file.name.split('.').pop()?.toLowerCase() || 'png'
        const avatarPath = `${CONTENT_PATHS.homeSitesAvatars}/avatar-${index}.${ext}`
        toast.loading(`正在上传图标 ${index + 1}...`, { id: toastId })
        const base64Content = await fileToBase64NoPrefix(file)
        const { sha: blobSha } = await createBlob(
          token,
          GITHUB_CONFIG.OWNER,
          GITHUB_CONFIG.REPO,
          base64Content,
          'base64',
        )
        treeItems.push({ path: avatarPath, mode: '100644', type: 'blob', sha: blobSha })
        updated[index].avatar = `/images/home-sites/avatar-${index}.${ext}`
      }
    }

    // 2. 用独立 YAML 文件替换模块列表
    toast.loading('正在生成模块文件...', { id: toastId })
    const fileTreeItems = await replaceIndividualFiles(token, CONTENT_PATHS.homeSitesList, updated)
    treeItems.push(...fileTreeItems)

    // 3. 提交
    toast.loading('正在获取分支信息...', { id: toastId })
    const refName = `heads/${GITHUB_CONFIG.BRANCH}`
    const ref = await getRef(token, GITHUB_CONFIG.OWNER, GITHUB_CONFIG.REPO, refName)
    const currentCommitSha = ref.sha

    const commit = await getCommit(token, GITHUB_CONFIG.OWNER, GITHUB_CONFIG.REPO, currentCommitSha)
    const baseTreeSha = commit.tree.sha

    toast.loading('🌳 正在构建文件树...', { id: toastId })
    const { sha: newTreeSha } = await createTree(
      token,
      GITHUB_CONFIG.OWNER,
      GITHUB_CONFIG.REPO,
      treeItems,
      baseTreeSha,
    )

    toast.loading('💾 正在提交更改...', { id: toastId })
    const { sha: newCommitSha } = await createCommit(
      token,
      GITHUB_CONFIG.OWNER,
      GITHUB_CONFIG.REPO,
      'chore(home-sites): update homepage modules',
      newTreeSha,
      [currentCommitSha],
    )

    toast.loading('🔄 正在同步远程分支...', { id: toastId })
    await updateRef(token, GITHUB_CONFIG.OWNER, GITHUB_CONFIG.REPO, refName, newCommitSha)

    toast.success('🎉 首页模块已保存！', {
      id: toastId,
      description: '已提交到内容仓库，约 2~3 分钟后首页自动更新。',
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
