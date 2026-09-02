// 真实对话框探针：真实弹出 Windows 系统文件夹选择器（会在用户屏幕上显示约 6 秒）。
// 判定逻辑：
//   - 若进程在 6 秒内一直存活直到被探针杀掉 → 对话框已成功弹出并等待用户操作（PASS）；
//   - 若用户在此期间恰好点击选择了文件夹 → 返回真实路径（PASS，且验证了取路径逻辑）；
//   - 若用户在对话框中点击取消 → 返回 null（PASS，对话框工作正常）；
//   - 若进程立刻退出并报错 → 对话框未能弹出（FAIL）。
// 运行：node test/dialog-probe.mjs
import { pickFolder } from "../controller/folder_picker.mjs";

const t0 = Date.now();
try {
  const res = await pickFolder("", { timeoutMs: 6000 });
  if (res === null) {
    console.log("PASS: 对话框已真实弹出；用户取消了选择（返回 null，符合预期）");
  } else {
    console.log(`PASS: 用户在对话框中完成选择，返回真实路径: ${JSON.stringify(res)}`);
  }
  process.exit(0);
} catch (e) {
  const ms = Date.now() - t0;
  if (/超时/.test(e.message || "")) {
    console.log(`PASS: 系统文件夹选择器已真实弹出并持续等待用户操作 ${ms}ms（被探针超时关闭）`);
    process.exit(0);
  }
  console.log(`FAIL: 对话框未能弹出 — ${e.message}`);
  process.exit(2);
}
