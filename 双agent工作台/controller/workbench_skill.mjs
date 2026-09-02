// 工作台专用 DeepSeek Harness 底层 Skill：供给与加载
//
// 目标：把稳定角色/通信协议/格式要求从"每次任务 Prompt 字符串"下沉为 dsh 的
// 项目级 Skill（<sourceDir>/.dsh/skills/<SKILL_NAME>/SKILL.md），由 dsh 标准
// skill 发现机制（skill-filesystem，rank 100 项目根）识别，工作台提示显式加载，
// 且 Skill 正文自带"工作台上下文识别规则"，普通直接调用不生效。
//
// 说明：dsh 的 skill 发现根包括 项目根 `.dsh/skills`(100) / `.agents/skills`(200)
//       / customSkillDirs(300) / 用户根 `<dshHome>/skills`(400) / `<agentsHome>/skills`(500)。
//       我们把 Skill 只放进"由工作台管理的项目源码目录"的 `.dsh/skills`，并依赖
//       prompt 显式激活 + 正文上下文门控，从而避免污染用户直接调用环境。
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

/** 目标：某项目源码目录下的 dsh 项目级 skill 目录。 */
export function projectSkillDir(sourceDir) {
  return path.join(sourceDir, ".dsh", "skills", SKILL_NAME);
}

/** 目标 SKILL.md 路径。 */
export function projectSkillFile(sourceDir) {
  return path.join(projectSkillDir(sourceDir), "SKILL.md");
}

/**
 * 把工作台 Skill 供给到某项目源码目录的 `.dsh/skills/`，使其对以该目录为 cwd 的
 * DeepSeek Harness 会话可见。幂等：已存在且内容一致则跳过，不一致则更新。
 * @param {string} sourceDir 项目源码目录（执行者 cwd）
 * @returns {{installed:boolean, dir:string}} installed=本次是否写入
 */
export function ensureProjectSkill(sourceDir) {
  const src = skillSourceDir();
  const srcSkill = path.join(src, "SKILL.md");
  if (!fs.existsSync(srcSkill)) {
    // 源码 SKILL 缺失：不抛错，避免阻塞调度（由编排日志提示）
    return { installed: false, dir: null, reason: "source SKILL.md missing" };
  }
  const destDir = projectSkillDir(sourceDir);
  const destSkill = path.join(destDir, "SKILL.md");

  let installed = false;
  if (fs.existsSync(destSkill)) {
    try {
      const a = fs.readFileSync(srcSkill, "utf8");
      const b = fs.readFileSync(destSkill, "utf8");
      if (a === b) return { installed: false, dir: destDir };
    } catch { /* 读失败按需更新 */ }
  }
  fs.mkdirSync(destDir, { recursive: true });
  // 复制 SKILL.md 及同目录资源（assets/references/scripts 等，如有）
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(destDir, ent.name);
    fs.rmSync(d, { recursive: true, force: true });
    fs.cpSync(s, d, { recursive: true, force: true });
  }
  installed = true;
  return { installed, dir: destDir };
}

/** 检查某项目源码目录是否已安装工作台 Skill。 */
export function isProjectSkillInstalled(sourceDir) {
  return fs.existsSync(projectSkillFile(sourceDir));
}

/** 从 SKILL.md frontmatter 解析 Skill 名称（校验一致性用）。 */
export function parseSkillName(md) {
  const m = (md || "").match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!m) return null;
  const n = m[1].match(/^name:\s*(\S+)/m);
  return n ? n[1] : null;
}

/**
 * 首任务（新会话）提示开头的工作台 Skill 激活指令。
 * 让执行者先加载本 Skill 再读信封；后续任务由 TASK-005 的精简提示复用。
 */
export function buildSkillActivationLine() {
  return `[${WORKBENCH_DISPATCH_MARKER}] 请先用 skill 工具加载 "${SKILL_NAME}"，再读取任务信封。`;
}

/**
 * 校验某项目源码目录的 Skill 与源码一致（验证用）。
 * @returns {{ok:boolean, name:string|null, sourceExists:boolean, installed:boolean}}
 */
export function verifyProjectSkill(sourceDir) {
  const src = path.join(skillSourceDir(), "SKILL.md");
  const dest = projectSkillFile(sourceDir);
  const sourceExists = fs.existsSync(src);
  const installed = fs.existsSync(dest);
  if (!sourceExists || !installed) return { ok: false, name: null, sourceExists, installed };
  const a = fs.readFileSync(src, "utf8");
  const b = fs.readFileSync(dest, "utf8");
  return { ok: a === b, name: parseSkillName(a), sourceExists, installed };
}
