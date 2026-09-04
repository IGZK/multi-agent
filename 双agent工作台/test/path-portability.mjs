import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProjectStore } from "../controller/store.mjs";
import { DashboardServer } from "../controller/server.mjs";
import { Orchestrator } from "../controller/orchestrator.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "双agent 路径测试-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new ProjectStore(path.join(root, "原工作台", "projects"));
  return { root, store };
}

test("默认源码目录随整个工作台搬移，读取不改写用户项目状态", (t) => {
  const { root, store } = fixture(t);
  const id = store.createProject("搬移项目", "测试");
  fs.writeFileSync(path.join(store.sourceDir(id), "保留文件.txt"), "原始内容");
  const original = fs.readFileSync(path.join(store.workspaceDir(id), "project_state.json"), "utf8");
  const destination = path.join(root, "新位置 带空格");
  fs.renameSync(path.dirname(store.projectsRoot), destination);
  const moved = new ProjectStore(path.join(destination, "projects"));
  assert.equal(moved.sourceDir(id), path.join(destination, "projects", id, "source"));
  assert.equal(fs.readFileSync(path.join(moved.sourceDir(id), "保留文件.txt"), "utf8"), "原始内容");
  assert.equal(fs.readFileSync(path.join(moved.workspaceDir(id), "project_state.json"), "utf8"), original);
  assert.equal(moved.readState(id).source_dir, null);
});

test("失效的外部源码目录阻止检查点创建与回滚，详情仍允许重选目录", async (t) => {
  const { root, store } = fixture(t);
  const originalSource = path.join(root, "外部源码");
  const id = store.createProject("外部项目", "测试", originalSource);
  fs.writeFileSync(path.join(originalSource, "项目.txt"), "外部源码");
  await store.createCheckpoint(id, "TASK-001", "original");
  const defaultSource = path.join(store.projectDir(id), "source");
  fs.writeFileSync(path.join(defaultSource, "保留.txt"), "不得修改默认目录");
  const movedSource = path.join(root, "外部源码 新位置");
  fs.renameSync(originalSource, movedSource);
  const stateBefore = fs.readFileSync(path.join(store.workspaceDir(id), "project_state.json"), "utf8");

  assert.throws(() => store.sourceDir(id), /请重新选择项目文件夹/);
  await assert.rejects(store.createCheckpoint(id, "TASK-002", "invalid"), /请重新选择项目文件夹/);
  assert.throws(() => store.restoreCheckpoint(id), /请重新选择项目文件夹/);
  assert.equal(fs.readFileSync(path.join(defaultSource, "保留.txt"), "utf8"), "不得修改默认目录");
  assert.equal(fs.existsSync(originalSource), false);
  assert.equal(fs.readFileSync(path.join(store.workspaceDir(id), "project_state.json"), "utf8"), stateBefore);

  const server = new DashboardServer({}, null, {}, store, {}, {});
  for (const view of [store.listProjects()[0], server.projectDetail(id)]) {
    assert.equal(view.source_dir, originalSource);
    assert.match(view.source_dir_error, /请重新选择项目文件夹/);
  }
  const orchestrator = new Orchestrator({}, null, {}, { kill() {} }, store);
  await orchestrator.setSourceDir(id, movedSource);
  assert.equal(store.sourceDir(id), movedSource);
  assert.equal(server.projectDetail(id).source_dir_error, null);
  assert.equal(fs.readFileSync(path.join(movedSource, "项目.txt"), "utf8"), "外部源码");
});

test("相对旧路径和文件路径不会被当作可执行目录", (t) => {
  const { root, store } = fixture(t);
  const id = store.createProject("非法路径", "测试");
  const file = path.join(root, "文件.txt");
  fs.writeFileSync(file, "保留");
  for (const invalid of ["relative/source", file]) {
    store.writeState(id, { source_dir: invalid });
    assert.throws(() => store.sourceDir(id), /请重新选择项目文件夹/);
    assert.equal(store.sourceDirStatus(id).path, invalid);
    assert.equal(store.readState(id).source_dir, invalid);
  }
});

test("工作区路径校验拒绝越界路径", (t) => {
  const { root, store } = fixture(t);
  const id = store.createProject("路径边界", "测试");
  for (const invalid of ["../outside.txt", "..\\outside.txt", path.join(root, "outside.txt")]) {
    assert.throws(() => store.writeWorkspaceFile(id, invalid, "不得写入"), /工作区路径越界/);
  }
  assert.equal(fs.existsSync(path.join(root, "outside.txt")), false);
});

test("Windows 路径支持大小写差异和正反斜杠", { skip: process.platform !== "win32" }, (t) => {
  const { root, store } = fixture(t);
  const source = path.join(root, "Source Code");
  const id = store.createProject("路径格式", "测试", source);
  fs.writeFileSync(path.join(source, "keep.txt"), "source");
  store.writeState(id, { source_dir: source.toUpperCase().replace(/\\/g, "/") });
  assert.equal(fs.readFileSync(path.join(store.sourceDir(id), "keep.txt"), "utf8"), "source");
  const workspaceFile = path.join(store.workspaceDir(id), "Case Check.txt");
  store.writeWorkspaceFile(id, workspaceFile.toUpperCase().replace(/\\/g, "/"), "workspace");
  assert.equal(fs.readFileSync(workspaceFile, "utf8"), "workspace");
});
