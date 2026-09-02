// 测试替身：代替 controller/folder_picker.mjs 的 pickFolder，
// 由 pickdir-http-test.mjs 控制返回值/错误，用于确定性测试 /api/pickdir 的 HTTP 层。
export const state = {
  path: "C:\\mock\\picked\\dir", // 返回的路径；null 表示用户取消
  error: null,                   // 非空则 pickFolder 抛出该错误
  lastStart: "",                 // 记录收到的 startPath，用于断言透传
};

export async function pickFolder(startPath = "", _opts = {}) {
  state.lastStart = String(startPath || "");
  if (state.error) throw new Error(state.error);
  return state.path === null ? null : state.path;
}
