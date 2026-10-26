import rss from "@astrojs/rss";
import { SITE_DESCRIPTION, SITE_LANGUAGE, SITE_TITLE } from "@config";
import { loadMoments } from "@/lib/load-moments";

export async function GET(context: any) {
  const moments = loadMoments();

  const items = moments.map((moment) => {
    const url = new URL(`/moments/#moment-${moment.id}`, context.site).toString();
    const images = (moment.images || [])
      .map((src) => `<img src="${new URL(src, context.site).toString()}" alt="moment" />`)
      .join("");
    return {
      title: moment.content.replace(/\s+/g, " ").slice(0, 42) || "瞬间",
      description: moment.content,
      link: url,
      guid: url,
      pubDate: new Date(moment.date),
      content: `<p>${moment.content.replace(/\n/g, "<br />")}</p>${images}`,
      customData: `<dc:creator><![CDATA[${SITE_TITLE}]]></dc:creator>`,
    };
  });

  return rss({
    title: `${SITE_TITLE} 瞬间`,
    description: SITE_DESCRIPTION || "随手记录生活",
    site: context.site,
    stylesheet: "/rss-style.xsl",
    items,
    customData: `<language>${SITE_LANGUAGE}</language>`,
    xmlns: {
      dc: "http://purl.org/dc/elements/1.1/",
      content: "http://purl.org/rss/1.0/modules/content/",
      atom: "http://www.w3.org/2005/Atom",
      version: "2.0",
    },
  });
}
