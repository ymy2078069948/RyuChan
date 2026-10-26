import { getCollection } from "astro:content";
import { SITE_START_DATE } from "@/config";

export interface SiteStatsData {
  postCount: number;
  categoryCount: number;
  tagCount: number;
  totalChars: number;
  lastUpdatedTs: number;
  runningDays: number;
}

/** 构建时统计站点数据（文章、分类、标签、字数、最后更新、运行天数） */
export async function getSiteStats(): Promise<SiteStatsData> {
  const posts = (await getCollection("blog")).filter((post) => !post.data.draft);

  const categories = new Set<string>();
  const tags = new Set<string>();
  let totalChars = 0;
  let firstDate = Number.POSITIVE_INFINITY;
  let lastUpdatedTs = 0;

  for (const post of posts) {
    for (const category of post.data.categories || []) categories.add(category);
    for (const tag of post.data.tags || []) tags.add(tag);
    totalChars += (post.body || "").replace(/\s+/g, "").length;
    const created = new Date(post.data.pubDate).getTime();
    if (created < firstDate) firstDate = created;
    const updated = new Date(post.data.updated ?? post.data.pubDate).getTime();
    if (updated > lastUpdatedTs) lastUpdatedTs = updated;
  }

  const configuredStart = SITE_START_DATE ? new Date(SITE_START_DATE).getTime() : Number.NaN;
  const startTime = Number.isFinite(configuredStart) ? configuredStart : firstDate;
  const runningDays = Number.isFinite(startTime)
    ? Math.max(1, Math.ceil((Date.now() - startTime) / 86_400_000))
    : 1;

  return {
    postCount: posts.length,
    categoryCount: categories.size,
    tagCount: tags.size,
    totalChars,
    lastUpdatedTs,
    runningDays,
  };
}
