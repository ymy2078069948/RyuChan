'use client'

import { useAuthStore } from '@/components/write/hooks/use-auth'
import { FRONTEND_REPO, GITHUB_CONFIG } from '@/consts'
import { KJUR, KEYUTIL } from 'jsrsasign'
import { toast } from 'sonner'

export const GH_API = 'https://api.github.com'

/**
 * 内容写在私有内容仓（RyuChan-Content）里，而线上静态站由前端仓（RyuChan）的
 * GitHub Actions 构建。内容仓的 push 不能触发前端仓的工作流，所以保存成功后
 * 由浏览器用 GitHub App 安装令牌向前端仓发送 repository_dispatch，立即部署。
 */
const DEPLOY_EVENT_TYPE = 'content-update'
const FRONTEND_TOKEN_SAFETY_WINDOW_MS = 5 * 60 * 1000

let cachedFrontendToken: { token: string; expiresAt: number } | null = null

function githubHeaders(token: string): HeadersInit {
	return {
		Authorization: `Bearer ${token}`,
		Accept: 'application/vnd.github+json',
		'X-GitHub-Api-Version': '2022-11-28',
	}
}

async function getFrontendInstallationToken(): Promise<string> {
	if (cachedFrontendToken && cachedFrontendToken.expiresAt - Date.now() > FRONTEND_TOKEN_SAFETY_WINDOW_MS) {
		return cachedFrontendToken.token
	}

	const privateKey = useAuthStore.getState().privateKey
	if (!privateKey) {
		throw new Error('GitHub App 私钥尚未加载')
	}

	const jwt = signAppJwt(GITHUB_CONFIG.APP_ID, privateKey)
	const installationRes = await fetch(`${GH_API}/repos/${GITHUB_CONFIG.OWNER}/${FRONTEND_REPO}/installation`, {
		headers: githubHeaders(jwt),
	})
	if (!installationRes.ok) {
		throw new Error(`查找前端仓库的 App 安装失败: ${installationRes.status}`)
	}
	const installation: { id: number } = await installationRes.json()

	const tokenRes = await fetch(`${GH_API}/app/installations/${installation.id}/access_tokens`, {
		method: 'POST',
		headers: githubHeaders(jwt),
	})
	if (!tokenRes.ok) {
		throw new Error(`创建前端仓库令牌失败: ${tokenRes.status}`)
	}
	const data: { token: string; expires_at?: string } = await tokenRes.json()
	const expiresAt = data.expires_at ? Date.parse(data.expires_at) : Number.NaN
	cachedFrontendToken = {
		token: data.token,
		expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 55 * 60 * 1000,
	}
	return cachedFrontendToken.token
}

/** 触发前端仓库的部署工作流；失败只记录警告，不影响内容保存。 */
export async function triggerContentDeploy(): Promise<boolean> {
	try {
		const token = await getFrontendInstallationToken()
		const res = await fetch(`${GH_API}/repos/${GITHUB_CONFIG.OWNER}/${FRONTEND_REPO}/dispatches`, {
			method: 'POST',
			headers: { ...githubHeaders(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				event_type: DEPLOY_EVENT_TYPE,
				client_payload: { branch: GITHUB_CONFIG.BRANCH },
			}),
		})
		if (!res.ok) {
			console.warn(`[deploy-trigger] 部署通知被拒绝: ${res.status}`)
			return false
		}
		return true
	} catch (error) {
		console.warn('[deploy-trigger] 自动部署通知失败，稍后仍会由兜底流程更新', error)
		return false
	}
}

// Encode each path segment without encoding the slashes required by GitHub REST routes.
function encodeGitHubPath(path: string): string {
	return path.split('/').map(encodeURIComponent).join('/')
}

function handle401Error(): void {
	if (typeof sessionStorage === 'undefined') return
	try {
		useAuthStore.getState().clearAuth()
	} catch (error) {
		console.error('Failed to clear auth cache:', error)
	}
}

function handle422Error(): void {
	toast.error('操作太快了，请操作慢一点')
}

export function toBase64Utf8(input: string): string {
	return btoa(unescape(encodeURIComponent(input)))
}

export function signAppJwt(appId: string, privateKeyPem: string): string {
	const now = Math.floor(Date.now() / 1000)
	const header = { alg: 'RS256', typ: 'JWT' }
	const payload = { iat: now - 60, exp: now + 8 * 60, iss: appId }
	const prv = KEYUTIL.getKey(privateKeyPem) as unknown as string
	return KJUR.jws.JWS.sign('RS256', JSON.stringify(header), JSON.stringify(payload), prv)
}

export async function getInstallationId(jwt: string, owner: string, repo: string): Promise<number> {
	const res = await fetch(`${GH_API}/repos/${owner}/${repo}/installation`, {
		headers: {
			Authorization: `Bearer ${jwt}`,
			Accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28'
		}
	})
	if (res.status === 401) handle401Error()
	if (res.status === 422) handle422Error()
	if (!res.ok) throw new Error(`installation lookup failed: ${res.status}`)
	const data = await res.json()
	return data.id
}

export async function createInstallationToken(jwt: string, installationId: number): Promise<string> {
	const res = await fetch(`${GH_API}/app/installations/${installationId}/access_tokens`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${jwt}`,
			Accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28'
		}
	})
	if (res.status === 401) handle401Error()
	if (res.status === 422) handle422Error()
	if (!res.ok) throw new Error(`create token failed: ${res.status}`)
	const data = await res.json()
	return data.token as string
}

export async function getFileSha(token: string, owner: string, repo: string, path: string, branch: string): Promise<string | undefined> {
	const res = await fetch(`${GH_API}/repos/${owner}/${repo}/contents/${encodeGitHubPath(path)}?ref=${encodeURIComponent(branch)}`, {
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28'
		}
	})
	if (res.status === 401) handle401Error()
	if (res.status === 422) handle422Error()
	if (res.status === 404) return undefined
	if (!res.ok) throw new Error(`get file sha failed: ${res.status}`)
	const data = await res.json()
	return (data && data.sha) || undefined
}

export async function putFile(token: string, owner: string, repo: string, path: string, contentBase64: string, message: string, branch: string) {
	const sha = await getFileSha(token, owner, repo, path, branch)
	const res = await fetch(`${GH_API}/repos/${owner}/${repo}/contents/${encodeGitHubPath(path)}`, {
		method: 'PUT',
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28',
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ message, content: contentBase64, branch, ...(sha ? { sha } : {}) })
	})
	if (res.status === 401) handle401Error()
	if (res.status === 422) handle422Error()
	if (!res.ok) throw new Error(`put file failed: ${res.status}`)
	return res.json()
}

export async function getRef(token: string, owner: string, repo: string, ref: string): Promise<{ sha: string }> {
	const res = await fetch(`${GH_API}/repos/${owner}/${repo}/git/ref/${encodeGitHubPath(ref)}`, {
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28'
		}
	})
	if (res.status === 401) handle401Error()
	if (res.status === 422) handle422Error()
	if (!res.ok) throw new Error(`get ref failed: ${res.status}`)
	const data = await res.json()
	return { sha: data.object.sha }
}

export async function getCommit(token: string, owner: string, repo: string, sha: string): Promise<{ tree: { sha: string } }> {
	const res = await fetch(`${GH_API}/repos/${owner}/${repo}/git/commits/${sha}`, {
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28'
		}
	})
	if (res.status === 401) handle401Error()
	if (res.status === 422) handle422Error()
	if (!res.ok) throw new Error(`get commit failed: ${res.status}`)
	const data = await res.json()
	return data
}

export type TreeItem = {
	path: string
	mode: '100644' | '100755' | '040000' | '160000' | '120000'
	type: 'blob' | 'tree' | 'commit'
	content?: string
	sha?: string | null
}

export async function createTree(token: string, owner: string, repo: string, tree: TreeItem[], baseTree?: string): Promise<{ sha: string }> {
	const res = await fetch(`${GH_API}/repos/${owner}/${repo}/git/trees`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28',
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ tree, base_tree: baseTree })
	})
	if (res.status === 401) handle401Error()
	if (res.status === 422) handle422Error()
	if (!res.ok) throw new Error(`create tree failed: ${res.status}`)
	const data = await res.json()
	return { sha: data.sha }
}

export async function createCommit(token: string, owner: string, repo: string, message: string, tree: string, parents: string[]): Promise<{ sha: string }> {
	const res = await fetch(`${GH_API}/repos/${owner}/${repo}/git/commits`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28',
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ message, tree, parents })
	})
	if (res.status === 401) handle401Error()
	if (res.status === 422) handle422Error()
	if (!res.ok) throw new Error(`create commit failed: ${res.status}`)
	const data = await res.json()
	return { sha: data.sha }
}

export async function updateRef(token: string, owner: string, repo: string, ref: string, sha: string, force = false): Promise<void> {
	const res = await fetch(`${GH_API}/repos/${owner}/${repo}/git/refs/${encodeGitHubPath(ref)}`, {
		method: 'PATCH',
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28',
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ sha, force })
	})
	if (res.status === 401) handle401Error()
	if (res.status === 422) handle422Error()
	if (!res.ok) throw new Error(`update ref failed: ${res.status}`)
	if (repo === GITHUB_CONFIG.REPO) {
		// 内容仓提交不会触发前端仓的部署工作流，这里主动通知一次（失败不影响保存）。
		void triggerContentDeploy().catch((error) => console.warn('[deploy-trigger] 加载失败', error))
	}
}

export async function readTextFileFromRepo(token: string | null | undefined, owner: string, repo: string, path: string, ref: string): Promise<string | null> {
	const headers: HeadersInit = {
		Accept: 'application/vnd.github+json',
		'X-GitHub-Api-Version': '2022-11-28'
	}
	if (token) {
		headers.Authorization = `Bearer ${token}`
	}

	const res = await fetch(`${GH_API}/repos/${owner}/${repo}/contents/${encodeGitHubPath(path)}?ref=${encodeURIComponent(ref)}&t=${Date.now()}`, {
		headers,
		cache: 'no-store'
	})
	if (res.status === 401) handle401Error()
	if (res.status === 422) handle422Error()
	if (res.status === 404) return null
	if (!res.ok) throw new Error(`read file failed: ${res.status}`)
	const data: any = await res.json()
	if (Array.isArray(data) || !data.content) return null
	try {
		return decodeURIComponent(escape(atob(data.content)))
	} catch {
		return atob(data.content)
	}
}

export async function listRepoFilesRecursive(token: string | null | undefined, owner: string, repo: string, path: string, ref: string): Promise<string[]> {
	async function fetchPath(targetPath: string): Promise<string[]> {
		const headers: HeadersInit = {
			Accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28'
		}
		if (token) {
			headers.Authorization = `Bearer ${token}`
		}

		const res = await fetch(`${GH_API}/repos/${owner}/${repo}/contents/${encodeGitHubPath(targetPath)}?ref=${encodeURIComponent(ref)}&t=${Date.now()}`, {
			headers,
			cache: 'no-store'
		})
		if (res.status === 401) handle401Error()
		if (res.status === 422) handle422Error()
		if (res.status === 404) return []
		if (!res.ok) throw new Error(`read directory failed: ${res.status}`)
		const data: any = await res.json()
		if (Array.isArray(data)) {
			const files: string[] = []
			for (const item of data) {
				if (item.type === 'file') {
					files.push(item.path)
				} else if (item.type === 'dir') {
					const nested = await fetchPath(item.path)
					files.push(...nested)
				}
			}
			return files
		}
		if (data?.type === 'file') return [data.path]
		if (data?.type === 'dir') return fetchPath(data.path)
		return []
	}

	return fetchPath(path)
}

export async function listRepoDir(token: string | null | undefined, owner: string, repo: string, path: string, ref: string): Promise<any[]> {
	const headers: HeadersInit = {
		Accept: 'application/vnd.github+json',
		'X-GitHub-Api-Version': '2022-11-28'
	}
	if (token) {
		headers.Authorization = `Bearer ${token}`
	}

	const res = await fetch(`${GH_API}/repos/${owner}/${repo}/contents/${encodeGitHubPath(path)}?ref=${encodeURIComponent(ref)}`, {
		headers
	})
	if (res.status === 401) handle401Error()
	if (res.status === 422) handle422Error()
	if (res.status === 404) return []
	if (!res.ok) throw new Error(`read directory failed: ${res.status}`)
	const data = await res.json()
	return Array.isArray(data) ? data : [data]
}

export type RecursiveTreeItem = {
  path: string
  mode: string
  type: string
  sha: string
  size?: number
  url?: string
}

export async function getTreeRecursive(token: string, owner: string, repo: string, treeSha: string): Promise<RecursiveTreeItem[]> {
  const res = await fetch(`${GH_API}/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  })
  if (res.status === 401) handle401Error()
  if (res.status === 422) handle422Error()
  if (!res.ok) throw new Error(`get tree failed: ${res.status}`)
  const data = await res.json()
  if (data.truncated) {
    console.warn('Tree response was truncated — large repo may need pagination')
  }
  return data.tree || []
}

export async function createBlob(
	token: string,
	owner: string,
	repo: string,
	content: string,
	encoding: 'utf-8' | 'base64' = 'base64'
): Promise<{ sha: string }> {
	const res = await fetch(`${GH_API}/repos/${owner}/${repo}/git/blobs`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28',
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ content, encoding })
	})
	if (res.status === 401) handle401Error()
	if (res.status === 422) handle422Error()
	if (!res.ok) throw new Error(`create blob failed: ${res.status}`)
	const data = await res.json()
	return { sha: data.sha }
}
