export interface Moment {
  /** 发布时间（ISO 字符串） */
  date: string;
  /** 正文 */
  content: string;
  /** 图片地址列表 */
  images?: string[];
  /** 位置（可选） */
  location?: string;
  /** 心情 / 标签（可选） */
  mood?: string;
  /** 页面渲染用的稳定 id（由加载器生成，不写入仓库） */
  id?: string;
}
