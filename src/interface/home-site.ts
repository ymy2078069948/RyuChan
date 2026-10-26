export interface HomeSite {
  /** 卡片名称 */
  name: string
  /** 点击后跳转的链接 */
  url: string
  /** 一句话描述 */
  description?: string
  /** 头像 / 图标地址（可为外链或 /images/home-sites/ 下的文件） */
  avatar?: string
  /** 右上角小徽章，如“自建”“工具” */
  badge?: string
}
