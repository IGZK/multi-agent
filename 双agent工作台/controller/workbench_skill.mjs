// 工作台专用 DeepSeek Harness 底层 Skill：供给与加载
//
// 稳定角色与通信协议由工作台专用 Harness Profile 提供。
// Skill 不写入项目源码目录，普通 DeepSeek 会话因此不会误加载。
import fs from "node:fs";
import path from "node:path";
import { ROOT_DIR } from "./logger.mjs";

/** Skill 名称（kebab-case，须与 SKILL.md frontmatter 一致）。 */
export const SKILL_NAME = "workbench-executor";
export const WORKBENCH_DISPATCH_MARKER = "WORKBENCH_MANAGED_DISPATCH_V1";

/** Skill 源码目录（随工作台源码维护的权威版本）。 */
export function skillSourceDir() {
  return path.join(ROOT_DIR, "skills", SKILL_NAME);
}

/** 专用 Harness Profile 内的隔离 Skill 根；普通 Harness 会话不会扫描此路径。 */
export function profileSkillDir(profileDir) {
  return path.join(profileDir, "skills", SKILL_NAME);
}

export function ensureProfileSkill(profileDir) {
  const src = skillSourceDir();
  const destDir = profileSkillDir(profileDir);
  const srcSkill = path.join(src, "SKILL.md");
  if (!fs.existsSync(srcSkill)) return { installed: false, dir: null, reason: "source SKILL.md missing" };
  if (fs.existsSync(path.join(destDir, "SKILL.md"))) {
    try {
      if (fs.readFileSync(srcSkill, "utf8") === fs.readFileSync(path.join(destDir, "SKILL.md"), "utf8")) {
        return { installed: false, dir: destDir };
      }
    } catch { /* 按需覆盖 */ }
  }
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destDir), { recursive: true });
  fs.cpSync(src, destDir, { recursive: true });
  return { installed: true, dir: destDir };
}

/**
 * 首任务（新会话）提示开头的工作台 Skill 激活指令。
 * 让执行者先加载本 Skill 再读信封；后续任务由 TASK-005 的精简提示复用。
 */
export function buildSkillActivationLine() {
  return `[${WORKBENCH_DISPATCH_MARKER}] 请先用 skill 工具加载 "${SKILL_NAME}"，再读取任务信封。`;
}
