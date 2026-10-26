import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import type { Moment } from "@/interface/moment";

const MOMENTS_YAML_PATH = path.resolve(process.cwd(), "src/data/moments.yaml");

function hashString(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

export function loadMoments(): Moment[] {
  try {
    const raw = fs.readFileSync(MOMENTS_YAML_PATH, "utf-8");
    const data = yaml.load(raw);
    if (!Array.isArray(data)) return [];
    return (data as Moment[])
      .filter((moment) => moment && moment.content)
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
      .map((moment) => ({
        ...moment,
        id: `${new Date(moment.date).getTime().toString(36)}-${hashString(moment.content)}`,
      }));
  } catch {
    return [];
  }
}
