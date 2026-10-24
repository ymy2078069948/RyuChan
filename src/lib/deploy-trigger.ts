import { FRONTEND_REPO, GITHUB_CONFIG } from '@/consts'
import { useAuthStore } from '@/components/write/hooks/use-auth'
import { GH_API, signAppJwt } from './github-client'

/**
 * 内容提交成功后，用 GitHub App 的安装令牌通知前端仓库重新部署。
 *
 * 内容写在私有内容仓（RyuChan-Content）里，而线上的静态站由前端仓库
 * （RyuChan）的 GitHub Actions 构建；内容仓的 push 不会自动触发前端仓的
 * 工作流（GitHub 不允许跨仓 push 触发），所以保存成功后由浏览器主动向
 * 前端仓发送 repository_dispatch（content-update），让线上在几分钟内更新。
 */
const DEPLOY_EVENT_TYPE = 'content-update'
const TOKEN_SAFETY_WINDOW_MS = 5 * 60 * 1000

let cachedToken: { token: string; expiresAt: number } | null = null

function authHeaders(token: string): HeadersInit {
	return {
		Authorization: `Bearer ${token}`,
		Accept: 'application/vnd.github+json',
		'X-GitHub-Api-Version': '2022-11-28',
	}
}

async function getFrontendToken(): Promise<string> {
	if (cachedToken && cachedToken.expiresAt - Date.now() > TOKEN_SAFETY_WINDOW_MS) {
		return cachedToken.token
	}

	const privateKey = useAuthStore.getState().privateKey
	if (!privateKey) {
		throw new Error('GitHub App 私钥尚未加载')
	}

	const jwt = signAppJwt(GITHUB_CONFIG.APP_ID, privateKey)
	const installationRes = await fetch(`${GH_API}/repos/${GITHUB_CONFIG.OWNER}/${FRONTEND_REPO}/installation`, {
		headers: authHeaders(jwt),
	})
	if (!installationRes.ok) {
		throw new Error(`查找前端仓库的 App 安装失败: ${installationRes.status}`)
	}
	const installation: { id: number } = await installationRes.json()

	const tokenRes = await fetch(`${GH_API}/app/installations/${installation.id}/access_tokens`, {
		method: 'POST',
		headers: authHeaders(jwt),
	})
	if (!tokenRes.ok) {
		throw new Error(`创建前端仓库令牌失败: ${tokenRes.status}`)
	}
	const data: { token: string; expires_at?: string } = await tokenRes.json()
	const expiresAt = data.expires_at ? Date.parse(data.expires_at) : Number.NaN
	cachedToken = {
		token: data.token,
		expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 55 * 60 * 1000,
	}
	return cachedToken.token
}

/**
 * 触发前端仓库的部署工作流。失败时不打断保存流程，只记录警告。
 */
export async function triggerContentDeploy(): Promise<boolean> {
	try {
		const token = await getFrontendToken()
		if (!token) return false
		const res = await fetch(`${GH_API}/repos/${GITHUB_CONFIG.OWNER}/${FRONTEND_REPO}/dispatches`, {
			method: 'POST',
			headers: {
				...authHeaders(token),
				'Content-Type': 'application/json',
			},
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
		console.warn('[deploy-trigger] 自动部署通知失败，内容已提交，稍后仍会由兜底流程更新', error)
		return false
	}
}
