import fs from 'fs'
import path from 'path'
import yaml from 'js-yaml'
import type { HomeSite } from '@/interface/home-site'

const HOME_SITES_YAML_PATH = path.resolve(process.cwd(), 'src/data/home-sites.yaml')

export function loadHomeSites(): HomeSite[] {
  try {
    const raw = fs.readFileSync(HOME_SITES_YAML_PATH, 'utf-8')
    const data = yaml.load(raw)
    return Array.isArray(data) ? (data as HomeSite[]) : []
  } catch {
    return []
  }
}
